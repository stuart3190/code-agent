import crypto from "node:crypto";
import path from "node:path";

export const RELEASE_HASH_VERSION = "thrallo-release-v1";
export const RELEASE_MANIFEST_FILE = "manifest.json";

export function safeReleaseSegment(value, name = "identifier") {
  const text = String(value || "");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(text)) throw new Error(`invalid ${name}`);
  return text;
}

export function normalizeArtifactPath(input) {
  const value = String(input || "").replaceAll("\\", "/");
  const normalized = path.posix.normalize(value);
  if (!value || normalized === "." || normalized.startsWith("../") || normalized.startsWith("/")
      || normalized.includes("\0")) throw new Error(`unsafe artifact path: ${value}`);
  return normalized;
}

export function createArtifactManifest(files) {
  const rows = [];
  let bytes = 0;
  for (const [rawPath, encoded] of Object.entries(files || {})) {
    const file = normalizeArtifactPath(rawPath);
    const content = Buffer.from(String(encoded), "base64");
    const canonical = content.toString("base64");
    if (canonical.replace(/=+$/, "") !== String(encoded).replace(/=+$/, "")) {
      throw new Error(`artifact file is not valid base64: ${file}`);
    }
    rows.push({ path: file, bytes: content.length, sha256: crypto.createHash("sha256").update(content).digest("hex") });
    bytes += content.length;
  }
  rows.sort((a, b) => a.path.localeCompare(b.path));
  if (!rows.length) throw new Error("release artifact is empty");
  if (!rows.some((row) => row.path === "index.html")) throw new Error("release artifact has no index.html");
  const identity = { version: RELEASE_HASH_VERSION, files: rows };
  const artifactHash = crypto.createHash("sha256").update(JSON.stringify(identity)).digest("hex");
  const manifest = { ...identity, artifactHash, fileCount: rows.length, bytes };
  const manifestHash = crypto.createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
  return { manifest, manifestHash, artifactHash, fileCount: rows.length, bytes };
}

export function assertManifest(expected, files) {
  const actual = createArtifactManifest(files);
  if (!expected || actual.artifactHash !== expected.artifactHash
      || actual.manifestHash !== expected.manifestHash
      || actual.fileCount !== expected.fileCount || actual.bytes !== expected.bytes) {
    throw new Error("release artifact does not match its immutable manifest");
  }
  return actual;
}

export function releaseRelativePath(owner, projectId, releaseId) {
  return [".thrallo", "releases", safeReleaseSegment(owner, "owner"),
    safeReleaseSegment(projectId, "project id"), safeReleaseSegment(releaseId, "release id")].join("/");
}
