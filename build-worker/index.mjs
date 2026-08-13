import os from "node:os";
import crypto from "node:crypto";
import path from "node:path";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { loadEnv } from "../shell/server/lib/env.mjs";
import { serviceClient } from "../shell/server/lib/supabase.mjs";
import { redactDiagnosticText } from "../shell/server/lib/appBuild/buildDiagnostics.mjs";
import { executeBuildPipelineWork } from "../shell/server/lib/buildJobs.mjs";
import { createOptimiser } from "../shell/server/lib/builderV2/assets/optimiser.mjs";
import { createWorkerQueue, serialiseWorkerFailure } from "./queue.mjs";
import { proveWorkerPreviewIsolation } from "./previewIsolationPreflight.mjs";
import { reconcileOrphanSandboxes, runSandboxJob } from "./sandboxRunner.mjs";
import { assertWorkerCredentialAuthority } from "./runtimeConfig.mjs";
import { previewProvider } from "../shell/server/preview/index.mjs";

loadEnv();
process.env.THRALLO_PROCESS_ROLE = "build-worker";

const VERSION = process.env.THRALLO_BUILD_WORKER_VERSION || "c7/1";
const WORKER_ID = process.env.THRALLO_BUILD_WORKER_ID || `${os.hostname()}:${process.pid}:${crypto.randomUUID().slice(0, 8)}`;
const LEASE_SECONDS = Math.max(15, Math.min(300, Number(process.env.THRALLO_BUILD_LEASE_SECONDS || 45)));
const POLL_MS = Math.max(250, Math.min(10_000, Number(process.env.THRALLO_BUILD_POLL_MS || 1000)));
const JOB_TYPES = (process.env.THRALLO_BUILD_JOB_TYPES || [
  "builder_pipeline", "dependency_install", "compile", "browser_verify", "qa_browser",
  "image_optimise", "publish_package", "android_package", "proof_slow",
].join(",")).split(",").map((v) => v.trim()).filter(Boolean);

let previewIsolation = { status: "not_required" };
try {
  assertWorkerCredentialAuthority(JOB_TYPES);
  if (JOB_TYPES.includes("builder_pipeline")) {
    previewIsolation = await proveWorkerPreviewIsolation({ preview: previewProvider() });
    console.log(JSON.stringify({ event: "worker_preview_isolation_preflight", ...previewIsolation }));
  }
} catch (error) {
  console.error(JSON.stringify({ event: "worker_preview_isolation_preflight", status: "failed",
    code: error.code || "worker_preflight_failed", message: error.message }));
  throw error;
}

const client = serviceClient();
const queue = createWorkerQueue(client);
let stopping = false;
let draining = process.env.THRALLO_BUILD_WORKER_DRAIN === "1";
let paused = process.env.THRALLO_BUILD_WORKER_PAUSED === "1";
let current = null;
let currentAbort = null;
let lastReconcile = 0;
let lastNodeRetirement = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tail = (value, max = 16_384) => redactDiagnosticText(String(value || "")).slice(-max);

async function runJob(job) {
  current = job;
  currentAbort = new AbortController();
  try {
    await queue.start(job, WORKER_ID);
  } catch (error) {
    // A start acknowledgement failure leaves the durable lease to expire/recover. Never leave
    // the supervisor's process-local `current` latch stuck, which would stop all future leasing.
    current = null;
    currentAbort = null;
    throw error;
  }
  let lastHeartbeat = Date.now();
  let outputBytes = 0;
  let eventChain = Promise.resolve();
  let eventFailure = null;
  const event = (type, value) => {
    const text = tail(value);
    outputBytes += Buffer.byteLength(text);
    if (outputBytes > Number(job.resource_limits?.outputBytes || 4 * 1024 * 1024)) {
      currentAbort.abort(Object.assign(new Error("worker diagnostic output limit exceeded"), { code: "output_limit" }));
      return eventChain;
    }
    eventChain = eventChain.then(async () => {
      if (eventFailure) return;
      try {
        await queue.event(job, WORKER_ID, type, { text });
      } catch (error) {
        eventFailure = Object.assign(new Error(`worker evidence persistence failed: ${error.message}`), {
          code: "worker_evidence_failed", cause: error,
        });
        currentAbort.abort(eventFailure);
      }
    });
    return eventChain;
  };
  const heartbeat = setInterval(async () => {
    try {
      const state = await queue.heartbeat(job, WORKER_ID, LEASE_SECONDS, { outputBytes });
      lastHeartbeat = Date.now();
      if (state?.cancel_requested) currentAbort.abort(Object.assign(new Error("cancel requested"), { code: "cancelled" }));
    } catch (error) {
      console.error(`[build-worker] heartbeat ${job.id}: ${error.message}`);
      currentAbort.abort(Object.assign(new Error("lease lost"), { code: "lease_lost" }));
    }
  }, Math.max(5_000, Math.floor(LEASE_SECONDS * 1000 / 3)));
  heartbeat.unref?.();

  try {
    let outcome;
    if (job.job_type === "builder_pipeline") {
      const { error } = await client.from("build_jobs").update({
        status: "running", phase: "running", updated_at: new Date().toISOString(),
      }).eq("id", job.build_id).eq("owner", job.owner)
        .in("status", ["queued", "running"]);
      if (error) throw new Error(`public build start persistence: ${error.message}`);
      outcome = await executeBuildPipelineWork(job, { signal: currentAbort.signal, onEvent: event });
      outcome = { ok: true, exitCode: 0, result: outcome, stdout: "", stderr: "" };
    } else if (job.job_type === "image_optimise") {
      const optimiser = createOptimiser({ client });
      const result = await optimiser.optimise(job.owner, job.payload || {});
      outcome = { ok: true, exitCode: 0, result, stdout: "", stderr: "" };
    } else if (job.job_type === "android_package") {
      const { buildAndroid } = await import("../shell/server/lib/android.mjs");
      const built = await buildAndroid({
        owner: { id: job.owner }, projectId: job.project_id,
        slug: job.payload.slug, tree: job.payload.tree, appName: job.payload.appName,
        log: (line) => event("stdout", line),
      });
      const artifactRoot = path.resolve(process.env.THRALLO_BUILD_ARTIFACT_ROOT || "/var/lib/thrallo-build-worker");
      const artifactDir = path.join(artifactRoot, job.id);
      await mkdir(artifactDir, { recursive: true });
      const artifactRef = path.join(artifactDir, built.filename);
      await writeFile(artifactRef, built.zip, { flag: "wx" });
      outcome = { ok: true, exitCode: 0, result: { filename: built.filename, bytes: built.zip.length }, artifactRef, stdout: "", stderr: "" };
    } else {
      outcome = await runSandboxJob(job, {
        signal: currentAbort.signal,
        onStdout: (chunk) => event("stdout", chunk),
        onStderr: (chunk) => event("stderr", chunk),
      });
    }
    if (currentAbort.signal.aborted) {
      throw Object.assign(new Error("Build work cancelled."), { classification: "cancelled", retryable: false });
    }
    if (!outcome.ok) {
      throw Object.assign(new Error(tail(outcome.stderr || `worker exited ${outcome.exitCode}`)), {
        classification: outcome.classification || "exit_code",
        retryable: ["worker_crash", "spawn_error"].includes(outcome.classification),
      });
    }
    const result = outcome.result || outcome.report || outcome;
    if (job.job_type === "qa_browser") {
      const report = outcome.report || outcome.result?.report || outcome;
      const qaRoot = path.resolve(process.env.QA_ARTIFACT_DIR || "/var/lib/thrallo-qa");
      const source = path.join(outcome.workspaceRef, "qa", job.payload.runId);
      await mkdir(qaRoot, { recursive: true });
      await cp(source, path.join(qaRoot, job.payload.runId), { recursive: true, force: true });
      const { error } = await client.from("qa_runs").update({
        status: report.issueCount ? "issues_found" : "passed",
        report, passed_count: report.passedCount || 0, issue_count: report.issueCount || 0,
        error: null, started_at: new Date().toISOString(), finished_at: new Date().toISOString(),
      }).eq("id", job.payload?.runId).eq("owner", job.owner);
      if (error) throw new Error(`qa result persistence: ${error.message}`);
    }
    const completionKey = outcome.completionKey || crypto.createHash("sha256")
      .update(`${job.id}:${job.attempts}:${JSON.stringify(result)}`).digest("hex");
    // Do not acknowledge completion until every stdout/stderr event accepted by this attempt is durable.
    await eventChain;
    if (eventFailure) throw eventFailure;
    // build_work_complete inserts the result and moves the job to succeeded in one transaction.
    await queue.complete(job, WORKER_ID, {
      completionKey, result, artifactRef: outcome.artifactRef || null,
      exitCode: outcome.exitCode ?? 0, stdout: outcome.stdout || "", stderr: outcome.stderr || "",
    });
    if (outcome.workspaceRef) {
      if (outcome.artifactRef) {
        await Promise.all([
          rm(path.join(outcome.workspaceRef, "project"), { recursive: true, force: true }),
          rm(path.join(outcome.workspaceRef, "payload.json"), { force: true }),
          rm(path.join(outcome.workspaceRef, "result.json"), { force: true }),
        ]).catch(() => {});
      } else {
        await rm(outcome.workspaceRef, { recursive: true, force: true }).catch(() => {});
      }
    }
    console.log(`[build-worker] succeeded ${job.id} ${job.job_type} (${Date.now() - lastHeartbeat}ms since heartbeat)`);
  } catch (error) {
    await eventChain;
    if (eventFailure && error !== eventFailure) error = Object.assign(new AggregateError(
      [error, eventFailure], "build work failed and its worker evidence could not persist",
    ), { code: "worker_evidence_failed", retryable: false });
    const classification = currentAbort.signal.aborted
      ? (error.code === "lease_lost" ? "worker_crash" : "cancelled")
      : error.classification || error.code || "worker_error";
    if (job.job_type === "qa_browser") {
      try {
        await client.from("qa_runs").update({
          status: "failed", error: "Browser testing could not finish. Please try again.",
          finished_at: new Date().toISOString(),
        }).eq("id", job.payload?.runId).eq("owner", job.owner);
      } catch {}
    }
    const failedWork = await queue.fail(job, WORKER_ID,
      serialiseWorkerFailure(error, classification)).catch((failure) => {
      console.error(`[build-worker] fail persistence ${job.id}: ${failure.message}`);
      return null;
    });
    if (job.job_type === "builder_pipeline" && failedWork && failedWork.state !== "queued") {
      const { data: publicJob, error: publicError } = await client.from("build_jobs").update({
        status: "failed", phase: "failed", stop_reason: classification,
        error: classification === "cancelled" ? "Cancelled by user." : "The isolated build worker stopped before completion.",
        updated_at: new Date().toISOString(),
      }).eq("id", job.build_id).eq("owner", job.owner)
        .not("status", "in", "(complete,failed,interrupted)").select("bv2_build_id").maybeSingle();
      if (publicError) console.error(`[build-worker] public job failure ${job.id}: ${publicError.message}`);
      if (publicJob?.bv2_build_id) {
        await client.from("bv2_builds").update({
          state: classification === "cancelled" ? "cancelled" : "failed",
          error: `worker:${classification}`, finished_at: new Date().toISOString(),
        }).eq("id", publicJob.bv2_build_id).eq("owner", job.owner)
          .not("state", "in", "(green,failed,cancelled,blocked)")
          .then(({ error: v2Error }) => {
            if (v2Error) console.error(`[build-worker] V2 build failure ${job.id}: ${v2Error.message}`);
          });
      }
    }
    console.error(`[build-worker] ${classification} ${job.id}: ${error.message}`);
  } finally {
    clearInterval(heartbeat);
    current = null; currentAbort = null;
  }
}

async function tick() {
  if (Date.now() - lastNodeRetirement > 60_000) {
    const staleBefore = new Date(Date.now() - Math.max(120_000, LEASE_SECONDS * 3_000)).toISOString();
    const retired = await queue.retireStaleNodes(WORKER_ID, staleBefore);
    lastNodeRetirement = Date.now();
    if (retired.length) console.warn(`[build-worker] retired ${retired.length} stale worker node registration(s)`);
  }
  if (Date.now() - lastReconcile > 30_000) {
    const reconciled = await reconcileOrphanSandboxes(client);
    lastReconcile = Date.now();
    if (reconciled.removed) console.warn(`[build-worker] removed ${reconciled.removed} orphan sandbox container(s)`);
  }
  const commanded = await queue.nodeState(WORKER_ID);
  if (!stopping && commanded === "paused") { paused = true; draining = false; }
  else if (!stopping && commanded === "draining") { draining = true; paused = false; }
  else if (!stopping && commanded === "active") { draining = false; paused = false; }
  const state = stopping ? "stopped" : draining ? "draining" : paused ? "paused" : "active";
  await queue.nodeHeartbeat(WORKER_ID, VERSION, state, JOB_TYPES, current?.id || null, {
    pid: process.pid, hostname: os.hostname(), leaseSeconds: LEASE_SECONDS, previewIsolation,
  });
  if (stopping || draining || paused || current) return;
  const job = await queue.lease(WORKER_ID, JOB_TYPES, LEASE_SECONDS);
  if (job) await runJob(job);
}

async function main() {
  console.log(`[build-worker] ${WORKER_ID} ${VERSION} types=${JOB_TYPES.join(",")} concurrency=1`);
  while (!stopping) {
    try { await tick(); } catch (error) { console.error(`[build-worker] tick: ${error.message}`); }
    await sleep(POLL_MS);
  }
  await queue.nodeHeartbeat(WORKER_ID, VERSION, "stopped", JOB_TYPES, null).catch(() => {});
}

function shutdown(signal) {
  if (stopping) return;
  stopping = true; draining = true;
  console.log(`[build-worker] ${signal}; draining`);
  currentAbort?.abort(Object.assign(new Error("worker shutting down"), { code: "worker_shutdown" }));
  setTimeout(() => process.exit(1), 30_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

main().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
