import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { buildWorkerEnabled, enqueueBuildWork, awaitBuildWork } from "./buildWorkQueue.mjs";

const ROOT = () => path.resolve(process.env.THRALLO_BUILD_ARTIFACT_ROOT || "/var/lib/thrallo-build-worker");

async function readArtifact(dir, base = "", files = {}, totals = { bytes: 0, count: 0 }) {
  const resolved = path.resolve(dir);
  const root = ROOT();
  if (resolved === root || !resolved.startsWith(root + path.sep)) throw new Error("worker returned an unsafe artifact reference");
  for (const entry of await readdir(resolved, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    const full = path.join(resolved, entry.name);
    if (entry.isDirectory()) await readArtifact(full, rel, files, totals);
    else if (entry.isFile()) {
      const info = await stat(full);
      totals.bytes += info.size; totals.count += 1;
      if (totals.bytes > 32 * 1024 * 1024 || totals.count > 4096) throw new Error("publish artifact exceeds safe output limits");
      files[rel] = (await readFile(full)).toString("base64");
    }
  }
  return files;
}

export async function packagePublishTree({
  owner, projectId, buildId = null, tree, appName = "My app", iconGlyph = null,
  renderIcons = false, idempotencyKey, client = null,
}) {
  if (!buildWorkerEnabled() || process.env.THRALLO_PROCESS_ROLE === "build-worker") return null;
  const work = await enqueueBuildWork({
    owner, projectId, buildId, jobType: "publish_package",
    payload: { tree, appName, iconGlyph, renderIcons }, idempotencyKey,
    priority: 15, maxAttempts: 2, client,
  });
  const completed = await awaitBuildWork(owner, work.id, { client, timeoutMs: 8 * 60_000 });
  if (!completed.artifact_ref) throw new Error("publish worker returned no artifact");
  return { files: await readArtifact(completed.artifact_ref), workJobId: work.id, artifactRef: completed.artifact_ref };
}

export async function readWorkerArtifactFile(artifactRef, { maxBytes = 64 * 1024 * 1024 } = {}) {
  const resolved = path.resolve(String(artifactRef || ""));
  const root = ROOT();
  if (!resolved.startsWith(root + path.sep)) throw new Error("worker returned an unsafe artifact reference");
  const info = await stat(resolved);
  if (!info.isFile() || info.size > maxBytes) throw new Error("worker artifact exceeds safe file limits");
  return readFile(resolved);
}
