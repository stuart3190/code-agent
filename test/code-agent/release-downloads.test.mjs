// Desktop release distribution: manifest-driven whitelist, Range support, and the
// guarantee that nothing outside the manifest (or the releases dir) is reachable.

process.env.CODE_AGENT_STORE = "memory";

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { handleReleaseDownload, handleReleaseManifest } from "../../shell/server/lib/releaseDownloads.mjs";

function fakeRes() {
  const res = {
    statusCode: 0, headers: {}, chunks: [],
    writeHead(code, headers) { res.statusCode = code; res.headers = headers || {}; },
    end(chunk) { if (chunk) res.chunks.push(chunk); res.ended = true; res.resolve?.(); },
    write(chunk) { res.chunks.push(chunk); return true; },
    on() {}, once() {}, emit() {},
    body() { return Buffer.concat(res.chunks.map((c) => Buffer.from(c))).toString(); },
    done: null,
  };
  res.done = new Promise((resolve) => { res.resolve = resolve; });
  return res;
}

async function seed() {
  const dir = await mkdtemp(path.join(tmpdir(), "thrallo-rel-"));
  await writeFile(path.join(dir, "Thrallo-Setup-x64.exe"), "SETUP-BYTES-0123456789");
  await writeFile(path.join(dir, "Thrallo-Portable-x64.zip"), "ZIP-BYTES");
  await writeFile(path.join(dir, "secret-build.log"), "private");
  await writeFile(path.join(dir, "manifest.json"), JSON.stringify({
    product: "Thrallo Desktop", version: "1.131.0", platform: "Windows 10/11 x64",
    releasedAt: "2026-07-31T00:00:00.000Z", notes: "First public build.",
    files: {
      setup: { name: "Thrallo-Setup-x64.exe", label: "Windows installer", sizeBytes: 22, sha256: "x" },
      portable: { name: "Thrallo-Portable-x64.zip", label: "Portable ZIP", sizeBytes: 9, sha256: "y" },
    },
  }));
  return dir;
}

test("manifest endpoint returns version, files, and download URLs", async () => {
  const dir = await seed();
  const res = fakeRes();
  await handleReleaseManifest({}, res, { dir });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body());
  assert.equal(body.version, "1.131.0");
  assert.equal(body.files.setup.url, "/downloads/Thrallo-Setup-x64.exe");
  assert.equal(body.files.portable.url, "/downloads/Thrallo-Portable-x64.zip");
});

test("manifest 404s cleanly when no release is published", async () => {
  const res = fakeRes();
  await handleReleaseManifest({}, res, { dir: path.join(tmpdir(), "does-not-exist") });
  assert.equal(res.statusCode, 404);
});

test("download streams the correct file with attachment headers", async () => {
  const dir = await seed();
  const res = fakeRes();
  await handleReleaseDownload({ headers: {}, method: "GET" }, res, { name: "Thrallo-Setup-x64.exe", dir });
  await res.done;
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["Content-Length"], 22);
  assert.match(res.headers["Content-Disposition"], /Thrallo-Setup-x64\.exe/);
  assert.equal(res.headers["Accept-Ranges"], "bytes");
  assert.equal(res.body(), "SETUP-BYTES-0123456789");
});

test("Range requests resume mid-file (206 + Content-Range)", async () => {
  const dir = await seed();
  const res = fakeRes();
  await handleReleaseDownload({ headers: { range: "bytes=6-10" }, method: "GET" }, res, { name: "Thrallo-Setup-x64.exe", dir });
  await res.done;
  assert.equal(res.statusCode, 206);
  assert.equal(res.headers["Content-Range"], "bytes 6-10/22");
  assert.equal(res.body(), "BYTES");
  // Unsatisfiable ranges answer 416, not a crash.
  const res2 = fakeRes();
  await handleReleaseDownload({ headers: { range: "bytes=99-" }, method: "GET" }, res2, { name: "Thrallo-Setup-x64.exe", dir });
  assert.equal(res2.statusCode, 416);
});

test("HEAD returns headers only", async () => {
  const dir = await seed();
  const res = fakeRes();
  await handleReleaseDownload({ headers: {}, method: "HEAD" }, res, { name: "Thrallo-Portable-x64.zip", dir });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["Content-Length"], 9);
  assert.equal(res.body(), "");
});

test("only manifest-listed files are reachable — no traversal, no stray files", async () => {
  const dir = await seed();
  for (const name of ["secret-build.log", "manifest.json", "../shell/.env", "..%2F..%2Fetc", "Thrallo-Setup-x64.exe.bak", ""]) {
    const res = fakeRes();
    await handleReleaseDownload({ headers: {}, method: "GET" }, res, { name, dir });
    assert.equal(res.statusCode, 404, `${JSON.stringify(name)} must 404`);
  }
});
