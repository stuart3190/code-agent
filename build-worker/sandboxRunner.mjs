import crypto from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { runProcess } from "./processTree.mjs";

const safeId = (value) => String(value || "").replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 64);

export function safeChildEnvironment(base = process.env) {
  const allowed = ["PATH", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP"];
  return Object.fromEntries(allowed.filter((key) => base[key]).map((key) => [key, base[key]]));
}

async function removeSandboxContainer(name) {
  return runProcess("docker", ["rm", "-f", name], {
    env: safeChildEnvironment(), wallMs: 10_000, outputBytes: 64 * 1024,
  }).catch(() => null);
}

export async function reconcileOrphanSandboxes(client) {
  const listed = await runProcess("docker", [
    "ps", "-a", "--filter", "label=thrallo.build-worker=1",
    "--format", "{{.Names}}|{{.Label \"thrallo.durable-job-id\"}}",
  ], { env: safeChildEnvironment(), wallMs: 10_000, outputBytes: 1024 * 1024 });
  if (!listed.ok || !listed.stdout.trim()) return { inspected: 0, removed: 0 };
  const containers = listed.stdout.trim().split(/\r?\n/).map((line) => {
    const [name, jobId] = line.split("|"); return { name, jobId };
  }).filter((row) => row.name && row.jobId);
  const jobIds = [...new Set(containers.map((row) => row.jobId))];
  const { data, error } = await client.from("build_work_jobs")
    .select("id,state,lease_expires_at").in("id", jobIds);
  if (error) throw new Error(`sandbox reconciliation: ${error.message}`);
  const jobs = new Map((data || []).map((row) => [row.id, row]));
  let removed = 0;
  for (const container of containers) {
    const job = jobs.get(container.jobId);
    const leaseAlive = job?.lease_expires_at && new Date(job.lease_expires_at).getTime() > Date.now();
    if (job && ["leased", "running", "cancel_requested"].includes(job.state) && leaseAlive) continue;
    const result = await removeSandboxContainer(container.name);
    if (result?.ok) removed += 1;
  }
  return { inspected: containers.length, removed };
}

export async function runSandboxJob(job, {
  artifactRoot = process.env.THRALLO_BUILD_ARTIFACT_ROOT || "/var/lib/thrallo-build-worker",
  image = process.env.THRALLO_BUILD_SANDBOX_IMAGE || "thrallo-build-sandbox:latest",
  docker = process.env.THRALLO_BUILD_SANDBOX !== "process",
  signal = null, onStdout = null, onStderr = null,
} = {}) {
  const limits = job.resource_limits || {};
  const jobRoot = path.resolve(artifactRoot, safeId(job.id));
  const root = path.resolve(artifactRoot);
  if (jobRoot === root || !jobRoot.startsWith(root + path.sep)) throw new Error("unsafe worker workspace path");
  await rm(jobRoot, { recursive: true, force: true });
  await mkdir(jobRoot, { recursive: true });
  const inputPath = path.join(jobRoot, "payload.json");
  const outputPath = path.join(jobRoot, "result.json");
  await writeFile(inputPath, JSON.stringify({ jobType: job.job_type, payload: {
    ...(job.payload || {}),
    wallMs: Math.floor(Number(limits.wallSeconds || 300) * 1000),
    outputBytes: Number(limits.outputBytes || 4 * 1024 * 1024),
  } }), { encoding: "utf8", flag: "wx" });

  let proc;
  if (docker) {
    const network = ["compile", "publish_package", "proof_slow"].includes(job.job_type) ? "none" : "bridge";
    const name = `thrallo-job-${safeId(job.id)}`;
    const durableJobId = safeId(job.durable_job_id || job.id);
    const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
    const gid = typeof process.getgid === "function" ? process.getgid() : 1000;
    // A hard worker death can leave the daemon-owned container alive. A retry of this exact
    // work unit always removes that orphan before claiming the deterministic container name.
    await removeSandboxContainer(name);
    proc = await runProcess("docker", [
      "run", "--rm", "--name", name,
      "--label", "thrallo.build-worker=1", "--label", `thrallo.durable-job-id=${durableJobId}`,
      "--user", `${uid}:${gid}`,
      "--network", network,
      "--memory", `${Math.max(256, Number(limits.memoryMb || 1024))}m`,
      "--cpus", String(Math.max(0.25, Number(limits.cpu || 1))),
      "--pids-limit", String(Math.max(32, Number(limits.pids || 128))),
      "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
      "--tmpfs", `/tmp:rw,noexec,nosuid,size=256m,uid=${uid},gid=${gid}`,
      "--tmpfs", `/tmp/home:rw,noexec,nosuid,size=16m,uid=${uid},gid=${gid}`,
      "-v", `${jobRoot}:/work:rw`, "-v", `${inputPath}:/input/payload.json:ro`,
      image,
    ], {
      env: safeChildEnvironment(), signal,
      wallMs: Math.floor(Number(limits.wallSeconds || 300) * 1000) + 15_000,
      outputBytes: Number(limits.outputBytes || 4 * 1024 * 1024), onStdout, onStderr,
    });
    // Killing the docker client does not necessarily stop a daemon-owned container.
    // Explicit cleanup is therefore part of cancellation/timeout acknowledgement.
    await removeSandboxContainer(name);
  } else {
    proc = await runProcess(process.execPath, [path.resolve("build-worker/sandbox.mjs")], {
      cwd: process.cwd(),
      env: { ...safeChildEnvironment(), THRALLO_JOB_INPUT: inputPath, THRALLO_JOB_OUTPUT: outputPath,
        THRALLO_JOB_WORK: path.join(jobRoot, "project"), THRALLO_SCAFFOLD_NODE_MODULES: path.resolve("harness/.deps/node_modules") },
      signal, wallMs: Math.floor(Number(limits.wallSeconds || 300) * 1000) + 5_000,
      outputBytes: Number(limits.outputBytes || 4 * 1024 * 1024), onStdout, onStderr,
    });
  }
  let result = null;
  try { result = JSON.parse(await readFile(outputPath, "utf8")); } catch {}
  result ||= { ok: false, exitCode: proc.exitCode, stdout: proc.stdout, stderr: proc.stderr, classification: proc.classification || "missing_result" };
  const artifactPath = path.join(jobRoot, "artifact");
  return {
    ...result,
    stdout: [proc.stdout, result.stdout].filter(Boolean).join("\n"),
    stderr: [proc.stderr, result.stderr].filter(Boolean).join("\n"),
    classification: result.classification || proc.classification,
    artifactRef: job.job_type === "publish_package" && result.ok ? artifactPath : null,
    workspaceRef: jobRoot,
    completionKey: crypto.createHash("sha256").update(`${job.id}:${job.attempts}:${JSON.stringify(result)}`).digest("hex"),
  };
}
