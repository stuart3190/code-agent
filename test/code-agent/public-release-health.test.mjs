import test from "node:test";
import assert from "node:assert/strict";
import { createArtifactManifest } from "../../shared/immutableRelease.mjs";
import { provePublicRelease } from "../../shell/server/lib/publishing/publicReleaseHealth.mjs";

const html = '<!doctype html><html><script src="/assets/main.js"></script><link href="/assets/main.css" rel="stylesheet"></html>';
const bodies = { "index.html": html, "assets/main.js": "console.log(1)", "assets/main.css": "body{color:green}" };
const { manifest } = createArtifactManifest(Object.fromEntries(Object.entries(bodies).map(([p,b]) => [p,Buffer.from(b).toString("base64")])));
const healthy = async url => new Response(bodies[new URL(url).pathname.slice(1)]);

test("public publish proof checks exact index and entry asset bytes", async () => {
  const result = await provePublicRelease("audit-counter", manifest, { fetchImpl: async (url, init) => {
    assert.equal(new URL(url).origin, "https://audit-counter.app.thrallo.com");
    assert.equal(init.redirect, "manual");
    return healthy(url);
  } });
  assert.deepEqual(result.verifiedFiles, Object.keys(bodies));
});

for (const status of [301, 401, 404, 503]) test(`public publish proof rejects HTTP ${status}`, async () => {
  await assert.rejects(provePublicRelease("audit-counter", manifest, {
    attempts: 1, fetchImpl: async () => new Response("", { status }),
  }), new RegExp(`HTTP ${status}`));
});

test("public publish proof rejects a stale index and SPA fallback masquerading as an asset", async () => {
  for (const fetchImpl of [async () => new Response("wrong"), async url => new Response(html)]) {
    await assert.rejects(provePublicRelease("audit-counter", manifest, { attempts: 1, fetchImpl }), /manifest size|match the activated release/);
  }
});

test("public publish proof retries transient ingress failure within a bounded allowance", async () => {
  let calls = 0; let sleeps = 0;
  const result = await provePublicRelease("audit-counter", manifest, {
    fetchImpl: async url => ++calls === 1 ? new Response("", { status: 503 }) : healthy(url),
    sleep: async () => { sleeps += 1; },
  });
  assert.equal(sleeps, 1); assert.equal(result.verifiedFiles.length, 3);
});

test("public publish proof refuses arbitrary hosts before making a request", async () => {
  for (const slug of ["127.0.0.1", "evil.example/", "audit@evil.example", "../private", ""]) {
    await assert.rejects(provePublicRelease(slug, manifest, { fetchImpl: () => assert.fail("no network") }), /invalid.*slug/);
  }
});
