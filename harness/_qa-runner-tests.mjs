import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isPrivateAddress, runQaBrowser, safeBrowserUrl } from "../shell/server/lib/qaRunner.mjs";

assert.equal(isPrivateAddress("127.0.0.1"), true);
assert.equal(isPrivateAddress("10.2.3.4"), true);
assert.equal(isPrivateAddress("172.31.4.8"), true);
assert.equal(isPrivateAddress("192.168.1.2"), true);
assert.equal(isPrivateAddress("::1"), true);
assert.equal(isPrivateAddress("8.8.8.8"), false);

const origin = "http://127.0.0.1:4567";
assert.equal(await safeBrowserUrl(`${origin}/asset.js`, origin), true);
assert.equal(await safeBrowserUrl("file:///etc/passwd", origin), false);
assert.equal(await safeBrowserUrl("http://example.com/a", origin), false);
assert.equal(await safeBrowserUrl("https://localhost/a", origin), false);
assert.equal(await safeBrowserUrl("https://safe.example/a", origin, new Map([
  ["safe.example", Promise.resolve(true)],
])), true);
assert.equal(await safeBrowserUrl("https://private.example/a", origin, new Map([
  ["private.example", Promise.resolve(false)],
])), false);

const server = createServer((req, res) => {
  if (req.url === "/missing.png") {
    res.writeHead(404, { "Content-Type": "text/plain" });
    return res.end("missing");
  }
  if (req.url === "/second") {
    res.writeHead(200, { "Content-Type": "text/html" });
    return res.end("<!doctype html><title>Second</title><main>Second page</main>");
  }
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(`<!doctype html>
    <title>QA fixture</title>
    <style>.too-wide { width: 1600px; } .mobile-overlay { position:absolute; width:80vw; height:40vh; }</style>
    <a href="/second">Second</a>
    <button></button>
    <img src="/missing.png" alt="missing fixture">
    <div class="too-wide">wide</div>
    <div class="mobile-overlay">large floating product panel</div>
    <script>setTimeout(() => { throw new Error("fixture runtime failure") }, 20)</script>`);
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const address = server.address();
const previewUrl = `http://127.0.0.1:${address.port}`;
const artifactRoot = await mkdtemp(path.join(os.tmpdir(), "buildr-qa-test-"));

try {
  const report = await runQaBrowser({ previewUrl, runId: "fixture-run", artifactRoot });
  assert.ok(report.checks.some((check) => check.url === "/second"), "same-origin route should be crawled");
  assert.ok(report.checks.some((check) => check.viewport === "mobile"), "mobile viewport should run");
  assert.ok(report.issues.some((issue) => issue.type === "runtime_error"), "runtime errors should be reported");
  assert.ok(report.issues.some((issue) => issue.type === "failed_request"), "failed requests should be reported");
  assert.ok(report.issues.some((issue) => issue.type === "broken_image"), "broken images should be reported");
  assert.ok(report.issues.some((issue) => issue.type === "accessibility"), "unlabelled controls should be reported");
  assert.ok(report.issues.some((issue) => issue.type === "horizontal_overflow"), "overflow should be reported");
  assert.ok(report.issues.some((issue) => issue.type === "mobile_content_overlap"), "large mobile overlays should be reported");
  assert.ok(report.screenshots.length >= 2, "screenshots should be captured");
  assert.match(report.fixPrompt, /fixture runtime failure/);
  const screenshot = await readFile(path.join(artifactRoot, "fixture-run", report.screenshots[0].file));
  assert.ok(screenshot.length > 100, "screenshot artifact should be readable");
} finally {
  await new Promise((resolve) => server.close(resolve));
  await rm(artifactRoot, { recursive: true, force: true });
}

console.log("QA runner tests passed");
