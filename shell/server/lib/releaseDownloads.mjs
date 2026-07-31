// Thrallo Desktop release distribution. Artifacts live in THRALLO_RELEASES_DIR next to a
// manifest.json that is the single source of truth: only files it lists are ever served,
// so no private path, build directory, or stray file can be reached through this route.
// Downloads stream with Range support (resumable) and attachment filenames.

import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function releasesDir() {
  return process.env.THRALLO_RELEASES_DIR || null;
}

export async function readManifest(dir = releasesDir()) {
  if (!dir) return null;
  try {
    const manifest = JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8"));
    return manifest && typeof manifest === "object" ? manifest : null;
  } catch {
    return null;
  }
}

function allowedNames(manifest) {
  return new Set(Object.values(manifest?.files || {}).map((f) => f?.name).filter(Boolean));
}

// GET /api/v1/downloads — the manifest plus stable download URLs. Public: it contains
// nothing but what the downloads page shows.
export async function handleReleaseManifest(req, res, { dir = releasesDir() } = {}) {
  const manifest = await readManifest(dir);
  if (!manifest) {
    res.writeHead(404, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "No release is published yet." }));
  }
  const files = Object.fromEntries(Object.entries(manifest.files || {}).map(([key, f]) => [
    key, { ...f, url: `/downloads/${f.name}` },
  ]));
  res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
  return res.end(JSON.stringify({ ...manifest, files }));
}

// GET|HEAD /downloads/:name — stream a released artifact. Name must match the manifest
// exactly; anything else (including traversal shapes) is a 404 with no detail.
export async function handleReleaseDownload(req, res, { name, dir = releasesDir() } = {}) {
  const notFound = () => {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Download not found." }));
  };
  const manifest = await readManifest(dir);
  if (!manifest || !NAME_RE.test(String(name || "")) || !allowedNames(manifest).has(name)) return notFound();

  const filePath = path.join(dir, name);
  let info;
  try {
    info = await stat(filePath);
  } catch {
    return notFound();
  }
  if (!info.isFile()) return notFound();

  const headers = {
    "Content-Type": "application/octet-stream",
    "Content-Disposition": `attachment; filename="${name}"`,
    "Accept-Ranges": "bytes",
    "Last-Modified": info.mtime.toUTCString(),
    "Cache-Control": "public, max-age=300",
  };

  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
  if (range && (range[1] !== "" || range[2] !== "")) {
    let start = range[1] === "" ? Math.max(info.size - Number(range[2]), 0) : Number(range[1]);
    let end = range[1] !== "" && range[2] !== "" ? Number(range[2]) : info.size - 1;
    end = Math.min(end, info.size - 1);
    if (start > end || start >= info.size) {
      res.writeHead(416, { "Content-Range": `bytes */${info.size}` });
      return res.end();
    }
    res.writeHead(206, {
      ...headers,
      "Content-Range": `bytes ${start}-${end}/${info.size}`,
      "Content-Length": end - start + 1,
    });
    if (req.method === "HEAD") return res.end();
    return createReadStream(filePath, { start, end }).pipe(res);
  }

  res.writeHead(200, { ...headers, "Content-Length": info.size });
  if (req.method === "HEAD") return res.end();
  return createReadStream(filePath).pipe(res);
}
