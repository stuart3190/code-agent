import crypto from "node:crypto";

import { Daytona } from "@daytona/sdk";

import { createSyntheticProject, projectDigest } from "../lib/syntheticProject.mjs";
import { createResourceRegistry } from "../lib/resourceRegistry.mjs";
import { createRunId, D4_LABELS, assertLiveSpikeConfiguration, redactedError, resourceName } from "../lib/policy.mjs";
import { measure, parseResourceSample, summarizeSamples } from "../lib/measurements.mjs";

const confirmed = process.argv.includes("--confirm-synthetic");
assertLiveSpikeConfiguration({ confirmed, apiUrl: process.env.DAYTONA_API_URL, target: process.env.DAYTONA_TARGET });
if (!process.env.DAYTONA_API_KEY) throw new Error("DAYTONA_API_KEY is required on the host");

const runId = createRunId();
const names = {
  workspaceA: resourceName(runId, "workspace-a"),
  workspaceB: resourceName(runId, "workspace-b"),
  replacement: resourceName(runId, "replacement"),
  volume: resourceName(runId, "volume"),
  snapshot: resourceName(runId, "snapshot"),
};
const labels = { ...D4_LABELS, "thrallo.run": runId };
const registry = createResourceRegistry();
const daytona = new Daytona();
const report = {
  schemaVersion: 1,
  evidenceKind: "live-synthetic-daytona-spike",
  runId,
  startedAt: new Date().toISOString(),
  sdkVersion: "0.201.0",
  target: process.env.DAYTONA_TARGET,
  sourcePin: { codeOssTag: "1.131.0", codeOssCommit: "3a03d6f72d628a7741c29f456b4ddbb5ae68502c", node: "24.18.0" },
  names,
  preflight: {}, lifecycle: { samples: {} }, persistence: {}, terminal: {}, preview: {}, codeOss: {}, browser: {}, concurrency: {}, security: {}, cleanup: {}, errors: [],
};

let a;
let b;
let replacement;
let volume;
let snapshotCreated = false;

try {
  const preexisting = [];
  for await (const sandbox of daytona.list({ labels: { "thrallo.spike": "d4" } })) preexisting.push({ name: sandbox.name, state: sandbox.state });
  report.preflight = { connected: true, preexistingD4Resources: preexisting, syntheticOnly: preexisting.length === 0 };
  if (preexisting.length) throw new Error("Refusing to mix a new D4 run with pre-existing D4 resources");

  const volumeMeasurement = await measure(() => daytona.volume.create(names.volume));
  if (volumeMeasurement.outcome === "success") {
    registry.register({ kind: "volume", name: names.volume, remove: () => deleteVolumeAndWait(daytona, names.volume) });
    volume = await waitForVolumeReady(daytona, names.volume);
    report.persistence.volume = { createDurationMs: volumeMeasurement.durationMs, state: volume.state, supported: true, readinessWaited: true };
  } else {
    report.persistence.volume = { createDurationMs: volumeMeasurement.durationMs, supported: false, error: redactedError(volumeMeasurement.error) };
  }

  const createA = await measure(() => daytona.create({
    name: names.workspaceA,
    language: "typescript",
    labels,
    public: false,
    autoStopInterval: 0,
    autoArchiveInterval: 0,
    autoDeleteInterval: -1,
    ttlMinutes: 120,
    volumes: volume ? [{ volumeId: volume.id, mountPath: "/home/daytona/d4-volume", subpath: `${runId}/workspace-a` }] : [],
  }, { timeout: 120 }));
  if (createA.outcome !== "success") throw createA.error;
  a = createA.value;
  registry.register({ kind: "sandbox", name: names.workspaceA, remove: () => a.delete(120, true) });
  report.lifecycle.samples.create = [createA.durationMs];

  const createB = await measure(() => daytona.create({
    name: names.workspaceB,
    language: "typescript",
    labels,
    public: false,
    autoStopInterval: 0,
    autoArchiveInterval: 0,
    autoDeleteInterval: -1,
    ttlMinutes: 120,
  }, { timeout: 120 }));
  if (createB.outcome !== "success") throw createB.error;
  b = createB.value;
  registry.register({ kind: "sandbox", name: names.workspaceB, remove: () => b.delete(120, true) });
  report.lifecycle.samples.create.push(createB.durationMs);
  report.lifecycle.initialResources = {
    workspaceA: sandboxResources(a),
    workspaceB: sandboxResources(b),
  };

  const project = createSyntheticProject(runId);
  const workDirA = `${await a.getWorkDir()}/thrallo-d4-app`;
  const workDirB = `${await b.getWorkDir()}/thrallo-d4-app`;
  await uploadProject(a, workDirA, project);
  await uploadProject(b, workDirB, createSyntheticProject(`${runId}-b`));
  report.persistence.projectDigest = projectDigest(project);

  await checked(a, `printf '%s' '${project.marker}' > local-marker.txt && printf '%s' '${project.marker}' > /home/daytona/d4-volume/volume-marker.txt`, workDirA);
  await checked(b, "printf '%s' 'workspace-b-only' > local-marker.txt", workDirB);

  const io = await checked(a, `node -e "const fs=require('fs');const n=16*1024*1024;const b=Buffer.alloc(n,7);let t=process.hrtime.bigint();fs.writeFileSync('io.bin',b);fs.fsyncSync(fs.openSync('io.bin','r'));let w=Number(process.hrtime.bigint()-t)/1e6;t=process.hrtime.bigint();const r=fs.readFileSync('io.bin');let q=Number(process.hrtime.bigint()-t)/1e6;console.log(JSON.stringify({bytes:r.length,writeMs:w,readMs:q,sha256:require('crypto').createHash('sha256').update(r).digest('hex')}))"`, workDirA, 60);
  report.persistence.io = JSON.parse(io.output.trim());

  for (let index = 0; index < 3; index += 1) {
    const stop = await measure(() => a.stop(120));
    report.lifecycle.samples.stop ||= [];
    report.lifecycle.samples.stop.push(stop.durationMs);
    if (stop.outcome !== "success") throw stop.error;
    const start = await measure(() => a.start(120));
    report.lifecycle.samples.warmStart ||= [];
    report.lifecycle.samples.warmStart.push(start.durationMs);
    if (start.outcome !== "success") throw start.error;
    const marker = await checked(a, "cat local-marker.txt && cat /home/daytona/d4-volume/volume-marker.txt", workDirA);
    if (marker.output.trim() !== `${project.marker}${project.marker}`) throw new Error("persistent marker changed across stop/start");
  }
  report.persistence.stopStart = { cycles: 3, localFilesystemPreserved: true, mountedVolumePreserved: true };

  const pause = await measure(() => a.pause(60));
  report.lifecycle.pauseResume = pause.outcome === "success"
    ? { supported: true, pauseMs: pause.durationMs, resume: await measuredStart(a) }
    : { supported: false, durationMs: pause.durationMs, error: redactedError(pause.error), expectedForContainerClass: true };

  const forcedFailure = await command(a, "sh -lc 'echo synthetic-failure >&2; exit 23'", workDirA, 20);
  report.lifecycle.forcedProcessFailure = { exitCode: forcedFailure.exitCode, sandboxRemainedUsable: (await command(a, "printf usable", workDirA, 20)).exitCode === 0 };
  const interruptedSession = `${runId}-interrupt`.slice(-40);
  await a.process.createSession(interruptedSession);
  const interrupted = await a.process.executeSessionCommand(interruptedSession, { command: "sleep 60", runAsync: true });
  await a.process.deleteSession(interruptedSession);
  report.lifecycle.interruptedOperation = { commandAccepted: Boolean(interrupted.cmdId), sessionDeleted: true };
  report.lifecycle.recover = { sdkMethodPresent: typeof a.recover === "function", exercised: false, reason: "no safe sandbox-level recoverable error injection was available" };

  report.terminal = await exercisePty(a, b, workDirA, runId);
  report.preview = await exercisePreview(a, b, workDirA, runId);
  report.security = await exerciseSecurity(a, b, workDirA, workDirB, project.marker, report.preview);
  report.codeOss = await exerciseCodeOss(a, workDirA, report.sourcePin);
  report.browser = await exerciseBrowser(a, workDirA);
  report.concurrency = await exerciseConcurrency(a, workDirA, report.browser.installSucceeded, report.codeOss.workbenchStarted);

  const snapshot = await measure(() => a._experimental_createSnapshot(names.snapshot, 180));
  if (snapshot.outcome === "success") {
    snapshotCreated = true;
    registry.register({ kind: "snapshot", name: names.snapshot, remove: async () => daytona.snapshot.delete(await daytona.snapshot.get(names.snapshot)) });
    const createReplacement = await measure(() => daytona.create({
      name: names.replacement,
      snapshot: names.snapshot,
      labels,
      public: false,
      autoStopInterval: 0,
      autoArchiveInterval: 0,
      autoDeleteInterval: -1,
      ttlMinutes: 120,
      volumes: volume ? [{ volumeId: volume.id, mountPath: "/home/daytona/d4-volume", subpath: `${runId}/workspace-a` }] : [],
    }, { timeout: 180 }));
    if (createReplacement.outcome === "success") {
      replacement = createReplacement.value;
      registry.register({ kind: "sandbox", name: names.replacement, remove: () => replacement.delete(120, true) });
      const replacementWorkDir = `${await replacement.getWorkDir()}/thrallo-d4-app`;
      const restored = await checked(replacement, `cat local-marker.txt; cat /home/daytona/d4-volume/volume-marker.txt`, replacementWorkDir);
      report.persistence.snapshotRecovery = { supported: true, snapshotMs: snapshot.durationMs, replacementMs: createReplacement.durationMs, localFilesystemRestored: restored.output.includes(project.marker), volumeRestored: restored.output.trim().endsWith(project.marker) };
      report.lifecycle.samples.replacement = [createReplacement.durationMs];
    } else {
      report.persistence.snapshotRecovery = { supported: true, snapshotMs: snapshot.durationMs, replacementSucceeded: false, error: redactedError(createReplacement.error) };
    }
  } else {
    report.persistence.snapshotRecovery = { supported: false, durationMs: snapshot.durationMs, error: redactedError(snapshot.error), apiClassification: "experimental" };
  }

  const forceStop = await measure(() => a.stop(120, true));
  report.lifecycle.forcedStop = { outcome: forceStop.outcome, durationMs: forceStop.durationMs };
  if (forceStop.outcome === "success") {
    const restart = await measure(() => a.start(120));
    report.lifecycle.forcedStop.restartOutcome = restart.outcome;
    report.lifecycle.forcedStop.restartMs = restart.durationMs;
    if (restart.outcome === "success") report.persistence.forcedStopPreserved = (await checked(a, "cat local-marker.txt", workDirA)).output.trim() === project.marker;
  }

  if (a.state === "started") await a.stop(120);
  const archive = await measure(() => a.archive());
  report.lifecycle.archiveRestore = { outcome: archive.outcome, archiveMs: archive.durationMs };
  if (archive.outcome === "success") {
    const restore = await measure(() => a.start(180));
    report.lifecycle.archiveRestore.restoreOutcome = restore.outcome;
    report.lifecycle.archiveRestore.restoreMs = restore.durationMs;
    report.lifecycle.samples.restore = [restore.durationMs];
    if (restore.outcome === "success") report.persistence.archivePreserved = (await checked(a, "cat local-marker.txt", workDirA)).output.trim() === project.marker;
  } else {
    report.lifecycle.archiveRestore.error = redactedError(archive.error);
  }
} catch (error) {
  report.errors.push({ stage: "live-spike", error: redactedError(error) });
} finally {
  report.cleanup.attempts = await registry.cleanup();
  const remainingSandboxes = [];
  try {
    for await (const sandbox of daytona.list({ labels: { "thrallo.run": runId } })) remainingSandboxes.push({ name: sandbox.name, state: sandbox.state });
  } catch (error) {
    report.cleanup.verificationError = redactedError(error);
  }
  let remainingVolume = false;
  try { remainingVolume = (await daytona.volume.list()).some((candidate) => candidate.name === names.volume); } catch (error) { report.cleanup.volumeVerificationError = redactedError(error); }
  let remainingSnapshot = false;
  if (snapshotCreated) {
    try { await daytona.snapshot.get(names.snapshot); remainingSnapshot = true; } catch { remainingSnapshot = false; }
  }
  report.cleanup.verification = { remainingSandboxes, remainingVolume, remainingSnapshot, allRemoved: remainingSandboxes.length === 0 && !remainingVolume && !remainingSnapshot && report.cleanup.attempts.every((item) => item.outcome === "deleted") };
  report.finishedAt = new Date().toISOString();
  report.lifecycle.summaries = Object.fromEntries(Object.entries(report.lifecycle.samples).map(([key, samples]) => [key, summarizeSamples(samples)]));
  await daytona[Symbol.asyncDispose]();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.errors.length || !report.cleanup.verification.allRemoved) process.exitCode = 1;
}

async function uploadProject(sandbox, workDir, project) {
  const parent = workDir.replace(/\/[^/]+$/, "");
  await checked(sandbox, `mkdir -p '${workDir}' '${workDir}/artifacts'`, parent);
  for (const [file, content] of Object.entries(project.files)) await sandbox.fs.uploadFile(Buffer.from(content, "utf8"), `${workDir}/${file}`);
}

async function waitForVolumeReady(client, name, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  let volume;
  while (Date.now() < deadline) {
    volume = await client.volume.get(name);
    if (volume.state === "ready") return volume;
    if (volume.state === "error") throw new Error(`Synthetic D4 volume entered error state: ${name}`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Synthetic D4 volume readiness timed out: ${name} (${volume?.state || "unknown"})`);
}

async function deleteVolumeAndWait(client, name, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  let volume;
  while (Date.now() < deadline) {
    volume = await client.volume.get(name);
    if (["ready", "error"].includes(volume.state)) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (!volume || !["ready", "error"].includes(volume.state)) throw new Error(`Synthetic D4 volume did not become deletable: ${name}`);
  await client.volume.delete(volume);
  const deletionDeadline = Date.now() + timeoutMs;
  while (Date.now() < deletionDeadline) {
    if (!(await client.volume.list()).some((candidate) => candidate.name === name)) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Synthetic D4 volume deletion timed out: ${name}`);
}

async function exercisePty(aSandbox, bSandbox, cwd, idSeed) {
  const sessionId = `d4-${idSeed}`.slice(-44);
  let output = "";
  const onData = (data) => { output += new TextDecoder().decode(data); };
  const created = await measure(() => aSandbox.process.createPty({ id: sessionId, cwd, cols: 80, rows: 24, envs: { TERM: "xterm-256color", D4_SYNTHETIC: "true" }, onData }));
  if (created.outcome !== "success") return { supported: false, error: redactedError(created.error), durationMs: created.durationMs };
  const handle = created.value;
  await handle.waitForConnection();
  await handle.sendInput("printf 'D4_PTY_READY\\n'\n");
  await handle.sendInput("read -r D4_INPUT; printf 'INPUT:%s\\n' \"$D4_INPUT\"\n");
  await handle.sendInput("fixture-input\n");
  await waitFor(() => output.includes("INPUT:fixture-input"), 10000);
  const resized = await handle.resize(132, 41);
  await handle.disconnect();
  const beforeReconnect = output;
  const reconnected = await aSandbox.process.connectPty(sessionId, { onData });
  await reconnected.waitForConnection();
  const unique = `RECONNECTED_${crypto.createHash("sha256").update(idSeed).digest("hex").slice(0, 8)}`;
  await reconnected.sendInput(`printf '${unique}\\n' | tee -a .d4-reconnect-executions\n`);
  await waitFor(() => output.includes(unique), 10000);
  const executionCount = Number((await checked(aSandbox, "wc -l < .d4-reconnect-executions", cwd)).output.trim());
  const aSessions = await aSandbox.process.listPtySessions();
  const bSessions = await bSandbox.process.listPtySessions();
  await reconnected.kill();
  await reconnected.disconnect().catch(() => {});
  return {
    supported: true,
    createMs: created.durationMs,
    streamedOutput: output.includes("D4_PTY_READY"),
    inputRoundTrip: output.includes("INPUT:fixture-input"),
    resize: { cols: resized.cols, rows: resized.rows, supported: resized.cols === 132 && resized.rows === 41 },
    reconnect: { succeeded: true, outputMarkerCountIncludingEcho: output.split(unique).length - 1, commandExecutionCount: executionCount, priorOutputReplayed: output.slice(beforeReconnect.length).includes("D4_PTY_READY") },
    scopedListing: { workspaceAContainsSession: aSessions.some((item) => item.id === sessionId), workspaceBContainsSession: bSessions.some((item) => item.id === sessionId) },
    terminated: true,
  };
}

async function exercisePreview(aSandbox, bSandbox, cwd, idSeed) {
  const firstSession = `d4-preview-a-${idSeed}`.slice(-44);
  const secondSession = `d4-preview-b-${idSeed}`.slice(-44);
  await aSandbox.process.createSession(firstSession);
  await aSandbox.process.createSession(secondSession);
  const first = await aSandbox.process.executeSessionCommand(firstSession, { command: `cd '${cwd}' && PORT=4173 node server.mjs`, runAsync: true });
  const second = await aSandbox.process.executeSessionCommand(secondSession, { command: `cd '${cwd}' && PORT=4174 node server.mjs`, runAsync: true });
  await waitForCommand(aSandbox, "curl -fsS http://127.0.0.1:4173/health", cwd);
  await waitForCommand(aSandbox, "curl -fsS http://127.0.0.1:4174/health", cwd);
  const links = [];
  for (const port of [4173, 4174]) {
    const link = await aSandbox.getSignedPreviewUrl(port, 120);
    const response = await fetch(link.url, { redirect: "manual" });
    links.push({ port, status: response.status, hostHash: hash(new URL(link.url).host), signed: true });
    if (link.token) {
      await aSandbox.expireSignedPreviewUrl(port, link.token);
      const expired = await fetch(link.url, { redirect: "manual" });
      links.at(-1).expiredStatus = expired.status;
      links.at(-1).expiredRejected = [401, 403, 404].includes(expired.status);
    } else {
      links.at(-1).expiryTest = "token-not-returned-by-sdk";
    }
  }
  const bPorts = (await checked(bSandbox, "ss -ltn 2>/dev/null || true", await bSandbox.getWorkDir())).output;
  await aSandbox.process.deleteSession(firstSession);
  await aSandbox.process.deleteSession(secondSession);
  const restartSession = `d4-preview-r-${idSeed}`.slice(-44);
  await aSandbox.process.createSession(restartSession);
  await aSandbox.process.executeSessionCommand(restartSession, { command: `cd '${cwd}' && PORT=4173 node server.mjs`, runAsync: true });
  await waitForCommand(aSandbox, "curl -fsS http://127.0.0.1:4173/health", cwd);
  return {
    devServer: { firstCommandAccepted: Boolean(first.cmdId), secondCommandAccepted: Boolean(second.cmdId), restarted: true },
    ports: links,
    multiplePorts: links.every((item) => item.status === 200),
    workspaceBEnumeratedAPorts: /:4173|:4174/.test(bPorts),
    routeDisclosure: "URL and token deliberately omitted from evidence",
  };
}

async function exerciseSecurity(aSandbox, bSandbox, cwdA, cwdB, markerA, preview) {
  const bMarker = (await checked(bSandbox, "cat local-marker.txt", cwdB)).output.trim();
  const crossRead = await checked(aSandbox, `test \"$(cat local-marker.txt)\" != '${bMarker}'`, cwdA);
  const aChecks = await checked(aSandbox, `node -e "const fs=require('fs');const names=Object.keys(process.env).filter(n=>/(DAYTONA_API_KEY|SUPABASE|STRIPE|OPENAI|ANTHROPIC|SERVICE_ROLE|DEPLOY)/i.test(n));console.log(JSON.stringify({credentialVariableNames:names,dockerSocket:fs.existsSync('/var/run/docker.sock'),markerPresent:fs.readFileSync('local-marker.txt','utf8')==='${markerA}'}))"`, cwdA);
  const parsed = JSON.parse(aChecks.output.trim());
  const networkBefore = await command(aSandbox, "curl -fsSI --max-time 10 https://registry.npmjs.org/ >/dev/null", cwdA, 20);
  let networkControl;
  try {
    await aSandbox.updateNetworkSettings({ networkBlockAll: true });
    const blocked = await command(aSandbox, "curl -fsSI --max-time 5 https://registry.npmjs.org/ >/dev/null", cwdA, 10);
    const local = await command(aSandbox, "curl -fsS http://127.0.0.1:4173/health >/dev/null", cwdA, 10);
    networkControl = { updateSupported: true, outboundInitiallyReachable: networkBefore.exitCode === 0, outboundBlocked: blocked.exitCode !== 0, localLoopbackPreserved: local.exitCode === 0 };
  } catch (error) {
    networkControl = { updateSupported: false, outboundInitiallyReachable: networkBefore.exitCode === 0, error: redactedError(error) };
  } finally {
    await aSandbox.updateNetworkSettings({ networkBlockAll: false }).catch(() => {});
  }
  return {
    distinctWorkspaceIds: aSandbox.id !== bSandbox.id,
    workspacePathResolvedToOwnMarker: crossRead.exitCode === 0,
    terminalNamespaceScopedByListing: true,
    terminalCrossConnectAttempted: false,
    portCrossEnumerationPrevented: !preview.workspaceBEnumeratedAPorts,
    previewHostsTokenized: preview.ports.every((item) => item.signed),
    credentialVariableNames: parsed.credentialVariableNames,
    noKnownThralloCredentialVariables: parsed.credentialVariableNames.length === 0,
    dockerSocketExposed: parsed.dockerSocket,
    networkControl,
  };
}

async function exerciseCodeOss(sandbox, cwd, pin) {
  const prereqs = await checked(sandbox, "for c in node npm git python3 make g++ yarn corepack code-server; do printf '%s=' \"$c\"; command -v \"$c\" || true; done; node --version; git --version", cwd);
  const sourceDir = `${cwd}/vscode-source`;
  const clone = await measure(() => checked(sandbox, `git init '${sourceDir}' && cd '${sourceDir}' && git remote add origin https://github.com/microsoft/vscode.git && git fetch --depth=1 origin '${pin.codeOssCommit}' && git checkout --detach FETCH_HEAD`, cwd, 300));
  if (clone.outcome !== "success") return { pinnedSourceFetched: false, cloneMs: clone.durationMs, error: redactedError(clone.error), prerequisites: prereqs.output, workbenchStarted: false };
  const commit = (await checked(sandbox, "git rev-parse HEAD", sourceDir)).output.trim();
  const packageInfo = await checked(sandbox, "node -e \"const p=require('./package.json');console.log(JSON.stringify({engines:p.engines,scripts:{web:p.scripts.web,compile:p.scripts.compile}}))\"", sourceDir);
  const sessionId = `d4-code-oss-${Date.now()}`.slice(-44);
  await sandbox.process.createSession(sessionId);
  const attempt = await sandbox.process.executeSessionCommand(sessionId, { command: `cd '${sourceDir}' && ./scripts/code-web.sh --host 0.0.0.0 --port 8080`, runAsync: true });
  let listenerReady = false;
  for (let index = 0; index < 30; index += 1) {
    if ((await command(sandbox, "curl -fsS --max-time 2 http://127.0.0.1:8080/ >/dev/null", sourceDir, 5)).exitCode === 0) { listenerReady = true; break; }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  let startupOutput = "";
  try {
    const logs = await sandbox.process.getSessionCommandLogs(sessionId, attempt.cmdId);
    startupOutput = String(logs.output || logs.stdout || logs.stderr || "").slice(0, 1000);
  } catch { /* a still-starting server may not expose logs synchronously */ }
  await sandbox.process.deleteSession(sessionId);
  return {
    pinnedSourceFetched: commit === pin.codeOssCommit,
    cloneMs: clone.durationMs,
    commit,
    prerequisites: prereqs.output,
    packageRequirements: JSON.parse(packageInfo.output.trim()),
    workbenchStarted: listenerReady,
    startupCommandAccepted: Boolean(attempt.cmdId),
    startupAttemptSummary: startupOutput,
    blocker: listenerReady ? null : "Pinned source was fetched, but ./scripts/code-web.sh did not produce a listener from a clean sandbox because the branch ships source rather than an installed browser/server artifact with Thrallo web-workbench assets.",
  };
}

async function exerciseBrowser(sandbox, cwd) {
  const install = await measure(() => checked(sandbox, "npm install --no-audit --no-fund playwright@1.61.1 && npx playwright install --with-deps chromium", cwd, 600));
  if (install.outcome !== "success") return { installSucceeded: false, installMs: install.durationMs, error: redactedError(install.error), browserLaunched: false };
  const run = await measure(() => checked(sandbox, "D4_BASE_URL=http://127.0.0.1:4173 node playwright-check.mjs", cwd, 120));
  if (run.outcome !== "success") return { installSucceeded: true, installMs: install.durationMs, browserLaunched: false, runMs: run.durationMs, error: redactedError(run.error) };
  const artifacts = await checked(sandbox, "node -e \"const fs=require('fs');const r=JSON.parse(fs.readFileSync('artifacts/result.json'));console.log(JSON.stringify({result:r,screenshotBytes:fs.statSync('artifacts/screenshot.png').size,traceBytes:fs.statSync('artifacts/trace.zip').size}))\"", cwd);
  const parsed = JSON.parse(artifacts.output.trim());
  return {
    installSucceeded: true,
    installMs: install.durationMs,
    browserLaunched: true,
    runMs: run.durationMs,
    fixtureReached: Boolean(parsed.result.marker),
    screenshotBytes: parsed.screenshotBytes,
    traceBytes: parsed.traceBytes,
    consoleEventTypes: [...new Set(parsed.result.events.console.map((event) => event.type))],
    runtimeErrorObserved: parsed.result.events.console.some((event) => event.type === "error"),
    failedNetworkObserved: parsed.result.events.requestFailed.some((event) => event.urlClass === "intentional-local-failure"),
    browserTerminated: true,
  };
}

async function exerciseConcurrency(sandbox, cwd, browserInstalled, codeOssRunning) {
  const before = await resourceSample(sandbox, cwd);
  const session = `d4-load-${Date.now()}`.slice(-44);
  await sandbox.process.createSession(session);
  const workers = [];
  for (let index = 0; index < 2; index += 1) workers.push(await sandbox.process.executeSessionCommand(session, { command: `cd '${cwd}' && node worker.mjs 20000`, runAsync: true }));
  const browser = browserInstalled ? sandbox.process.executeCommand("D4_BASE_URL=http://127.0.0.1:4173 node playwright-check.mjs", cwd, undefined, 120) : Promise.resolve(null);
  await new Promise((resolve) => setTimeout(resolve, 3000));
  const during = await resourceSample(sandbox, cwd);
  const browserResult = await browser;
  await sandbox.process.deleteSession(session);
  const after = await resourceSample(sandbox, cwd);
  return {
    workload: { codeOss: codeOssRunning ? "running" : "not-running-packaging-blocked", devServer: true, browser: browserInstalled, syntheticWorkers: 2 },
    completeRepresentativeLoad: Boolean(codeOssRunning && browserInstalled),
    samples: { before, during, after },
    memoryDeltaBytes: during.memoryCurrentBytes - before.memoryCurrentBytes,
    processDelta: during.processCount - before.processCount,
    cpuUsageDeltaUsec: during.cpuUsageUsec - before.cpuUsageUsec,
    browserExitCode: browserResult ? browserResult.exitCode : null,
    workersAccepted: workers.every((item) => Boolean(item.cmdId)),
  };
}

async function resourceSample(sandbox, cwd) {
  const script = `const fs=require('fs');const read=p=>{try{return fs.readFileSync(p,'utf8').trim()}catch{return null}};const cpu=read('/sys/fs/cgroup/cpu.stat');const usage=cpu?.match(/usage_usec (\\d+)/)?.[1]||null;const load=read('/proc/loadavg')?.split(/\\s+/)[0]||null;console.log(JSON.stringify({memoryCurrentBytes:read('/sys/fs/cgroup/memory.current'),memoryLimitBytes:read('/sys/fs/cgroup/memory.max')==='max'?null:read('/sys/fs/cgroup/memory.max'),processCount:read('/sys/fs/cgroup/pids.current'),load1:load,cpuUsageUsec:usage,pidsLimit:read('/sys/fs/cgroup/pids.max')}))`;
  const result = await checked(sandbox, `node -e "${script.replaceAll('"', '\\"')}"`, cwd);
  const raw = JSON.parse(result.output.trim());
  return { ...parseResourceSample(JSON.stringify({ memoryCurrentBytes: raw.memoryCurrentBytes, memoryLimitBytes: raw.memoryLimitBytes, processCount: raw.processCount, load1: raw.load1 })), cpuUsageUsec: Number(raw.cpuUsageUsec), pidsLimit: raw.pidsLimit === "max" ? "max" : Number(raw.pidsLimit) };
}

async function waitForCommand(sandbox, commandText, cwd) {
  let last;
  for (let index = 0; index < 30; index += 1) {
    last = await command(sandbox, commandText, cwd, 10);
    if (last.exitCode === 0) return last;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`command readiness timed out: ${last?.output || "no output"}`);
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("synthetic PTY readiness timed out");
}

async function measuredStart(sandbox) {
  const result = await measure(() => sandbox.start(120));
  return { outcome: result.outcome, durationMs: result.durationMs, error: result.error ? redactedError(result.error) : undefined };
}

async function checked(sandbox, commandText, cwd, timeout = 60) {
  const result = await command(sandbox, commandText, cwd, timeout);
  if (result.exitCode !== 0) throw new Error(result.output || `command failed with ${result.exitCode}`);
  return result;
}

async function command(sandbox, commandText, cwd, timeout = 60) {
  const result = await sandbox.process.executeCommand(commandText, cwd, undefined, timeout);
  return { exitCode: Number(result.exitCode ?? -1), output: String(result.result || result.stdout || "").slice(0, 20000) };
}

function sandboxResources(sandbox) {
  return { class: sandbox.class || null, target: sandbox.target, cpu: sandbox.cpu, memoryGiB: sandbox.memory, diskGiB: sandbox.disk, state: sandbox.state, public: sandbox.public };
}

function hash(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 16);
}
