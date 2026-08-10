// Build the Builder V2 sandbox image from THIS checkout and pin the worker to its immutable
// digest — the two halves of the 2026-08-10 provenance incident, done together so they cannot
// drift apart again.
//
// The pin previously lived only as a hand-written line in /etc/thrallo/build-worker.env, with no
// record of what the digest contained. Here the digest is derived from a build, the build is
// stamped with its source commit, and both are written to a generated provenance file that
// replaces the hand-maintained DEPLOYED_COMMIT marker.
//
//   node ops/pin-build-sandbox-image.mjs --commit <sha> [--tag <tag>] [--build] [--pin] [--restart]
//
// Nothing happens without the explicit flags: --build builds, --pin rewrites the EnvironmentFile,
// --restart restarts the worker. Default is a dry report of what it would do.

import { chmod, chown, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runProcess } from "../build-worker/processTree.mjs";
import { computeSandboxIdentity } from "../shell/server/lib/builderV2/sandboxProvenance.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name, fallback = null) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const commit = value("commit") || "unknown";
const tag = value("tag") || `thrallo-build-sandbox:${commit.slice(0, 12)}`;
const envPath = value("env-file", "/etc/thrallo/build-worker.env");
const provenancePath = path.join(root, ".deployment-provenance.json");

const run = async (file, argv, options = {}) => {
  const result = await runProcess(file, argv, {
    cwd: root, env: process.env, wallMs: options.wallMs || 20 * 60_000,
    outputBytes: 8 * 1024 * 1024,
    onStdout: (line) => process.stdout.write(line),
    onStderr: (line) => process.stderr.write(line),
  });
  if (!result.ok) throw new Error(`${file} ${argv.join(" ")} failed (${result.classification || `exit ${result.exitCode}`})`);
  return result;
};

const capture = async (file, argv) => {
  const result = await runProcess(file, argv, { cwd: root, env: process.env, wallMs: 60_000, outputBytes: 1024 * 1024 });
  if (!result.ok) throw new Error(`${file} ${argv.join(" ")} failed`);
  return String(result.stdout || "").trim();
};

const hostIdentity = await computeSandboxIdentity({ root, commit });

if (flag("build")) {
  // The official build, plus the source commit so the image can say where it came from.
  await run("docker", ["build", "--build-arg", `SOURCE_COMMIT=${commit}`,
    "-t", tag, "-f", "build-worker/Dockerfile", "."]);
}

const digest = await capture("docker", ["image", "inspect", tag, "--format", "{{.Id}}"]);
const created = await capture("docker", ["image", "inspect", tag, "--format", "{{.Created}}"]);

const record = {
  sourceCommit: commit,
  sandboxImageTag: tag,
  sandboxImageDigest: digest,
  sandboxImageCreated: created,
  sandboxIdentity: hostIdentity.identity,
  verifierHash: hostIdentity.verifier,
  files: hostIdentity.files,
  pinnedAt: new Date().toISOString(),
};

if (flag("pin")) {
  // Rewrite in place, preserving every other line, exactly as the worker-authority tool does —
  // so the two can be run in either order without one clobbering the other.
  const current = await readFile(envPath, "utf8");
  const stats = await stat(envPath);
  let seen = false;
  const rows = current.split(/\r?\n/).map((line) => {
    if (!line.startsWith("THRALLO_BUILD_SANDBOX_IMAGE=")) return line;
    seen = true;
    return `THRALLO_BUILD_SANDBOX_IMAGE=${digest}`;
  });
  if (!seen) rows.push(`THRALLO_BUILD_SANDBOX_IMAGE=${digest}`);
  const temporary = `${envPath}.pin.tmp`;
  await writeFile(temporary, `${rows.filter((line, index, all) => index < all.length - 1 || line).join("\n")}\n`,
    { encoding: "utf8", mode: 0o640 });
  await chown(temporary, stats.uid, stats.gid);
  await chmod(temporary, 0o640);
  await rename(temporary, envPath);
  await writeFile(provenancePath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

if (flag("restart")) await run("sudo", ["systemctl", "restart", "thrallo-build-worker"], { wallMs: 120_000 });

console.log(JSON.stringify({ ...record, built: flag("build"), pinned: flag("pin"), restarted: flag("restart") }, null, 2));
