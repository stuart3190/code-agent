import http from "node:http";
import crypto from "node:crypto";
import path from "node:path";
import { chmod, lstat, mkdir, readFile, readdir, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { PUBLISH_ROOT } from "./docker.mjs";
import {
  assertManifest, createArtifactManifest, normalizeArtifactPath, releaseRelativePath, safeReleaseSegment,
} from "../shared/immutableRelease.mjs";

const META_ROOT = () => path.join(PUBLISH_ROOT, ".thrallo");
const MAX_FILES = Number(process.env.PUBLISH_MAX_FILES || 4096);
const MAX_BYTES = Number(process.env.PUBLISH_MAX_BYTES || 32 * 1024 * 1024);

function inside(root, candidate) {
  const base = path.resolve(root); const target = path.resolve(candidate);
  if (target !== base && !target.startsWith(base + path.sep)) throw new Error("release path escapes publish root");
  return target;
}

function releaseDir(owner, projectId, releaseId) {
  return inside(PUBLISH_ROOT, path.join(PUBLISH_ROOT, ...releaseRelativePath(owner, projectId, releaseId).split("/")));
}

function pointerPath(slug) {
  return inside(PUBLISH_ROOT, path.join(META_ROOT(), "sites", safeReleaseSegment(slug, "slug"), "current"));
}

async function withSiteLock(slug, run) {
  const lockRoot = path.join(META_ROOT(), "locks");
  await mkdir(lockRoot, { recursive: true, mode: 0o700 });
  const lock = inside(lockRoot, path.join(lockRoot, `${safeReleaseSegment(slug, "slug")}.lock`));
  const deadline = Date.now() + 10_000;
  while (true) {
    try { await mkdir(lock, { mode: 0o700 }); break; }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      const stale = await lstat(lock).catch(() => null);
      if (stale && Date.now() - stale.mtimeMs > 30_000) { await rm(lock, { recursive: true, force: true }); continue; }
      if (Date.now() >= deadline) throw new Error("site activation lock timed out");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  try { return await run(); } finally { await rm(lock, { recursive: true, force: true }); }
}

async function filesFromDir(dir, base = "", out = {}) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error("immutable release contains a symlink");
    const rel = base ? `${base}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await filesFromDir(full, rel, out);
    else if (entry.isFile()) out[rel] = (await readFile(full)).toString("base64");
  }
  return out;
}

async function makeReadOnly(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { await makeReadOnly(full); await chmod(full, 0o555); }
    else await chmod(full, 0o444);
  }
  await chmod(dir, 0o555);
}

async function localHttpHealth(dir, manifest) {
  const expected = new Set(manifest.files.map((row) => row.path));
  const index = await readFile(path.join(dir, "index.html"), "utf8");
  if (!/<html|<!doctype/i.test(index)) throw new Error("index.html is not an HTML document");
  const refs = [...index.matchAll(/(?:src|href)=["']([^"'#?]+)["']/gi)]
    .map((match) => match[1].replace(/^\.\//, "").replace(/^\//, ""))
    .filter((ref) => ref && !/^[a-z]+:/i.test(ref));
  for (const ref of refs) if (!expected.has(normalizeArtifactPath(ref))) throw new Error(`index references missing asset: ${ref}`);

  const server = http.createServer(async (req, res) => {
    const requested = new URL(req.url, "http://127.0.0.1").pathname.replace(/^\//, "") || "index.html";
    try { const body = await readFile(inside(dir, path.join(dir, normalizeArtifactPath(requested)))); res.writeHead(200); res.end(body); }
    catch { res.writeHead(404); res.end(); }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  try {
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/index.html`, { signal: AbortSignal.timeout(2_000) });
    if (!response.ok || !(await response.text()).includes(index.slice(0, Math.min(64, index.length)))) {
      throw new Error("local release health check failed");
    }
  } finally { await new Promise((resolve) => server.close(resolve)); }
}

export async function finalizeRelease({ releaseId, owner, projectId, files, proof }) {
  const finalDir = releaseDir(owner, projectId, releaseId);
  const computed = assertManifest(proof, files);
  if (computed.fileCount > MAX_FILES || computed.bytes > MAX_BYTES) throw new Error("release exceeds publish limits");
  if (existsSync(finalDir)) {
    const existing = createArtifactManifest(await filesFromDir(finalDir));
    if (existing.artifactHash !== computed.artifactHash) throw new Error("immutable release id already has different bytes");
    return { releaseId, artifactPath: releaseRelativePath(owner, projectId, releaseId), ...existing, reused: true, health: "verified" };
  }
  const stageRoot = path.join(META_ROOT(), "staging");
  await mkdir(stageRoot, { recursive: true, mode: 0o700 });
  const stage = inside(stageRoot, path.join(stageRoot, `${safeReleaseSegment(releaseId)}-${crypto.randomUUID()}`));
  await mkdir(stage, { recursive: false, mode: 0o700 });
  try {
    for (const [raw, encoded] of Object.entries(files)) {
      const rel = normalizeArtifactPath(raw); const full = inside(stage, path.join(stage, ...rel.split("/")));
      await mkdir(path.dirname(full), { recursive: true, mode: 0o700 });
      await writeFile(full, Buffer.from(String(encoded), "base64"), { flag: "wx", mode: 0o600 });
    }
    assertManifest(proof, await filesFromDir(stage));
    await localHttpHealth(stage, computed.manifest);
    await mkdir(path.dirname(finalDir), { recursive: true, mode: 0o700 });
    await makeReadOnly(stage);
    await rename(stage, finalDir);
  } finally { await rm(stage, { recursive: true, force: true }); }
  return { releaseId, artifactPath: releaseRelativePath(owner, projectId, releaseId), ...computed, reused: false, health: "verified" };
}

export async function inspectPointer(slug) {
  const pointer = pointerPath(slug);
  try {
    const info = await lstat(pointer);
    if (!info.isSymbolicLink()) return { slug, kind: "legacy_directory", releaseId: null, target: null };
    const target = await readlink(pointer);
    const releaseId = path.basename(target);
    return { slug, kind: "release_pointer", releaseId, target };
  } catch (error) {
    if (error.code === "ENOENT") return { slug, kind: "absent", releaseId: null, target: null };
    throw error;
  }
}

async function activateReleaseUnlocked({ slug, owner, projectId, releaseId, expectedPreviousReleaseId = null }) {
  const finalDir = releaseDir(owner, projectId, releaseId);
  if (!existsSync(finalDir)) throw new Error("release artifact is missing");
  const current = await inspectPointer(slug);
  if (current.kind === "release_pointer" && current.releaseId === releaseId) return { ...current, changed: false };
  if (current.kind === "legacy_directory") throw new Error("atomic activation refuses to replace a legacy live directory");
  if ((current.releaseId || null) !== (expectedPreviousReleaseId || null)) {
    const error = new Error("stale filesystem activation pointer"); error.code = "stale_pointer"; throw error;
  }
  const pointer = pointerPath(slug);
  await mkdir(path.dirname(pointer), { recursive: true, mode: 0o700 });
  const relative = path.relative(path.dirname(pointer), finalDir);
  const temp = `${pointer}.next-${crypto.randomUUID()}`;
  await symlink(relative, temp, "dir");
  await rename(temp, pointer);
  const observed = await inspectPointer(slug);
  if (observed.releaseId !== releaseId) throw new Error("atomic pointer verification failed");
  return { ...observed, changed: true };
}

export async function activateRelease(options) {
  return withSiteLock(options.slug, () => activateReleaseUnlocked(options));
}

export async function adoptLegacyRelease({ releaseId, owner, projectId, slug }) {
  const legacy = inside(PUBLISH_ROOT, path.join(PUBLISH_ROOT, safeReleaseSegment(slug, "slug")));
  const info = await lstat(legacy).catch(() => null);
  if (!info?.isDirectory() || info.isSymbolicLink()) throw new Error("legacy site directory is missing");
  const files = await filesFromDir(legacy);
  const proof = createArtifactManifest(files);
  const finalized = await finalizeRelease({ releaseId, owner, projectId, files, proof });
  const pointer = await activateRelease({ slug, owner, projectId, releaseId, expectedPreviousReleaseId: null });
  return { ...finalized, pointer, legacyPath: safeReleaseSegment(slug, "slug") };
}

export async function unpublishPointer({ slug, expectedPreviousReleaseId = null }) {
  return withSiteLock(slug, async () => {
    const current = await inspectPointer(slug);
    if (current.kind === "absent") return { ...current, changed: false };
    if (current.kind === "legacy_directory") throw new Error("atomic unpublish refuses to remove a legacy live directory");
    if (expectedPreviousReleaseId && current.releaseId !== expectedPreviousReleaseId) {
      const error = new Error("stale filesystem unpublish pointer"); error.code = "stale_pointer"; throw error;
    }
    await rm(pointerPath(slug), { force: true });
    return { ...(await inspectPointer(slug)), changed: true };
  });
}

export async function verifyRelease({ owner, projectId, releaseId }) {
  const dir = releaseDir(owner, projectId, releaseId);
  if (!existsSync(dir)) throw new Error("release artifact is missing");
  const proof = createArtifactManifest(await filesFromDir(dir));
  await localHttpHealth(dir, proof.manifest);
  return { releaseId, artifactPath: releaseRelativePath(owner, projectId, releaseId), ...proof, health: "verified" };
}

export async function listReleaseFiles({ owner, projectId, releaseId }) {
  return filesFromDir(releaseDir(owner, projectId, releaseId));
}

export async function cleanupReleases({ retained = [], olderThanMs = 30 * 24 * 60 * 60_000, now = Date.now() } = {}) {
  const root = path.join(META_ROOT(), "releases"); const keep = new Set(retained.map(String));
  let inspected = 0; let removed = 0;
  if (!existsSync(root)) return { inspected, removed };
  for (const owner of await readdir(root, { withFileTypes: true })) for (const project of await readdir(path.join(root, owner.name), { withFileTypes: true })) {
    const dir = path.join(root, owner.name, project.name);
    for (const release of await readdir(dir, { withFileTypes: true })) {
      if (!release.isDirectory()) continue; inspected += 1;
      if (keep.has(release.name)) continue;
      const info = await lstat(path.join(dir, release.name));
      if (now - info.mtimeMs < olderThanMs) continue;
      await chmod(path.join(dir, release.name), 0o700); // provisiond owns immutable storage
      await rm(path.join(dir, release.name), { recursive: true, force: true }); removed += 1;
    }
  }
  return { inspected, removed };
}

export async function purgeProjectReleases({ owner, projectId }) {
  const ownerDir = inside(META_ROOT(), path.join(META_ROOT(), "releases", safeReleaseSegment(owner, "owner")));
  const projectDir = inside(ownerDir, path.join(ownerDir, safeReleaseSegment(projectId, "project id")));
  const existed = existsSync(projectDir);
  if (existed) {
    await chmod(projectDir, 0o700);
    await rm(projectDir, { recursive: true, force: true });
  }
  return { owner, projectId, purged: existed };
}
