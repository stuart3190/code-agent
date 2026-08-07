#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { rm } from "node:fs/promises";
import path from "node:path";
import { REACT_VITE } from "../src/scaffolds/reactVite.mjs";
import { runProcess } from "../build-worker/processTree.mjs";
import { runSandboxJob } from "../build-worker/sandboxRunner.mjs";

if (process.env.BUILD_WORKER_SANDBOX_PROOF !== "1") {
  throw new Error("BUILD_WORKER_SANDBOX_PROOF=1 is required");
}
const image = process.env.THRALLO_BUILD_SANDBOX_IMAGE || "thrallo-build-sandbox:c7-proof";
const artifactRoot = path.resolve(process.env.THRALLO_BUILD_ARTIFACT_ROOT || "/tmp/thrallo-c7-sandbox-proof");
if (!artifactRoot.startsWith("/tmp/thrallo-c7-")) throw new Error("sandbox proof requires an isolated /tmp/thrallo-c7-* root");

const limits = { wallSeconds: 30, cpu: 0.5, memoryMb: 384, pids: 64, outputBytes: 1024 * 1024 };
const job = (id, jobType, payload, resourceLimits = limits) => ({
  id, owner: "proof-owner", project_id: "proof-project", attempts: 1,
  job_type: jobType, payload, resource_limits: resourceLimits,
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8" }).trim();
const proof = {};

try {
  const compile = await runSandboxJob(job("valid-compile", "compile", { tree: REACT_VITE }), { artifactRoot, image });
  assert.equal(compile.ok, true, JSON.stringify({ exitCode: compile.exitCode, classification: compile.classification,
    stdout: compile.stdout, stderr: compile.stderr })); proof.compile = { exitCode: compile.exitCode };

  const exact = "C7_EXACT_COMPILER_STDERR";
  const malformedTree = {
    "package.json": JSON.stringify({ scripts: { build: `node -e \"console.error('${exact}');process.exit(23)\"` } }),
  };
  const malformed = await runSandboxJob(job("malformed-project", "compile", { tree: malformedTree }), { artifactRoot, image });
  assert.equal(malformed.ok, false); assert.equal(malformed.exitCode, 23); assert.match(malformed.stderr, new RegExp(exact));
  proof.malformedProject = { exitCode: malformed.exitCode, exactStderr: true };

  const running = runSandboxJob(job("inspect-limits", "proof_slow", { durationMs: 2500 }), { artifactRoot, image });
  await sleep(500);
  const inspected = JSON.parse(docker("inspect", "thrallo-job-inspect-limits"))[0];
  assert.equal(inspected.HostConfig.Memory, 384 * 1024 * 1024);
  assert.equal(inspected.HostConfig.NanoCpus, 500_000_000);
  assert.equal(inspected.HostConfig.PidsLimit, 64);
  assert.equal(inspected.HostConfig.ReadonlyRootfs, true);
  assert.equal(inspected.HostConfig.NetworkMode, "none");
  assert.ok(inspected.HostConfig.SecurityOpt.includes("no-new-privileges"));
  const binds = inspected.Mounts.map((mount) => mount.Source);
  assert.ok(binds.every((source) => source.includes("inspect-limits")));
  assert.equal((await running).ok, true);
  proof.containerLimits = { memoryBytes: inspected.HostConfig.Memory, nanoCpus: inspected.HostConfig.NanoCpus,
    pids: inspected.HostConfig.PidsLimit, readOnlyRoot: true, network: inspected.HostConfig.NetworkMode,
    isolatedMounts: true };

  const timeout = await runSandboxJob(job("timeout-tree", "proof_slow", {
    durationMs: 120_000, spawnGrandchild: true,
  }, { ...limits, wallSeconds: 1 }), { artifactRoot, image });
  assert.equal(timeout.ok, false); assert.equal(timeout.classification, "timeout");
  assert.equal(docker("ps", "-aq", "--filter", "name=thrallo-job-timeout-tree"), "");
  proof.timeoutProcessTree = { classification: timeout.classification, containerRemoved: true };

  const oom = await runProcess("docker", [
    "run", "--rm", "--memory", "256m", "--memory-swap", "256m", "--pids-limit", "32",
    "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--entrypoint", "node", image, "-e",
    "const a=[];setInterval(()=>a.push(Buffer.alloc(32*1024*1024,1)),5)",
  ], { wallMs: 30_000, outputBytes: 64 * 1024 });
  assert.equal(oom.exitCode, 137); proof.memoryLimit = { exitCode: oom.exitCode };

  docker("run", "-d", "--rm", "--name", "thrallo-c7-proof-web", "nginx:alpine");
  try {
    let ready = false;
    for (let attempt = 0; attempt < 20 && !ready; attempt += 1) {
      try { docker("exec", "thrallo-c7-proof-web", "wget", "-qO-", "http://127.0.0.1"); ready = true; }
      catch { await sleep(100); }
    }
    assert.equal(ready, true, "disposable browser proof server did not become ready");
    const address = docker("inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", "thrallo-c7-proof-web");
    const browser = await runSandboxJob(job("browser-proof", "browser_verify", {
      previewUrl: `http://${address}`, usesBackend: false, timeoutMs: 20_000,
    }, { ...limits, wallSeconds: 30 }), { artifactRoot, image });
    assert.equal(browser.exitCode, 0); assert.ok(browser.app?.checks?.some((check) => check.id === "load" && check.status === "pass"),
      JSON.stringify(browser.app || browser));
    proof.browser = { processIsolated: true, loadEvidence: true };
  } finally {
    try { docker("rm", "-f", "thrallo-c7-proof-web"); } catch {}
  }

  docker("run", "-d", "--rm", "--name", "thrallo-c7-proof-hang", "--entrypoint", "node", image,
    "-e", "require('http').createServer(()=>{}).listen(8080)");
  try {
    const address = docker("inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", "thrallo-c7-proof-hang");
    const controller = new AbortController();
    const pendingBrowser = runSandboxJob(job("browser-cancel", "browser_verify", {
      previewUrl: `http://${address}:8080`, usesBackend: false, timeoutMs: 120_000,
    }, { ...limits, wallSeconds: 125 }), { artifactRoot, image, signal: controller.signal });
    setTimeout(() => controller.abort(), 750).unref?.();
    const cancelledBrowser = await pendingBrowser;
    assert.equal(cancelledBrowser.classification, "cancelled");
    assert.equal(docker("ps", "-aq", "--filter", "name=thrallo-job-browser-cancel"), "");
    proof.browserCancellation = { classification: "cancelled", containerRemoved: true };
  } finally {
    try { docker("rm", "-f", "thrallo-c7-proof-hang"); } catch {}
  }

  const afterMalformed = await runSandboxJob(job("after-malformed", "proof_slow", { durationMs: 100 }), { artifactRoot, image });
  assert.equal(afterMalformed.ok, true); proof.supervisorSurvivesMalformedProject = true;
  console.log(JSON.stringify({ ok: true, image, ...proof }, null, 2));
} finally {
  await rm(artifactRoot, { recursive: true, force: true });
}
