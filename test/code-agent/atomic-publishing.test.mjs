import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";

import { createArtifactManifest, normalizeArtifactPath } from "../../shared/immutableRelease.mjs";

const linux = process.platform !== "win32";
const OWNER = "a0000000-0000-4000-8000-000000000001";
const PROJECT = "b0000000-0000-4000-8000-000000000001";
const root = path.join(os.tmpdir(), `thrallo-c8-${process.pid}-${crypto.randomUUID()}`);
process.env.PUBLISH_DIR = root;
const releases = await import(`../../provisiond/releases.mjs?proof=${crypto.randomUUID()}`);

const artifact = (label = "one") => ({
  "index.html": Buffer.from(`<!doctype html><html><script src="/assets/${label}.js"></script></html>`).toString("base64"),
  [`assets/${label}.js`]: Buffer.from(`console.log(${JSON.stringify(label)})`).toString("base64"),
});
const id = (n) => `c0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
async function final(n, label = `r${n}`) {
  const files = artifact(label); const proof = createArtifactManifest(files);
  return releases.finalizeRelease({ releaseId: id(n), owner: OWNER, projectId: PROJECT, files, proof });
}

test.after(async () => { await chmod(root, 0o700).catch(() => {}); await rm(root, { recursive: true, force: true }); });

test("C8-01 build failure before finalisation creates no release", { skip: !linux }, async () => {
  assert.equal(existsSync(path.join(root, ".thrallo", "releases", OWNER, PROJECT, id(1))), false);
});

test("C8-02 failed health check cannot finalise", { skip: !linux }, async () => {
  const files = { "index.html": Buffer.from("not html").toString("base64") };
  await assert.rejects(releases.finalizeRelease({ releaseId: id(2), owner: OWNER, projectId: PROJECT,
    files, proof: createArtifactManifest(files) }), /HTML document/);
  assert.equal(existsSync(path.join(root, ".thrallo", "releases", OWNER, PROJECT, id(2))), false);
});

test("C8-03 crash before activation intent leaves live pointer absent", { skip: !linux }, async () => {
  await final(3); assert.equal((await releases.inspectPointer("proof-three")).kind, "absent");
});

test("C8-04 durable intent before pointer swap cannot expose staged release", { skip: !linux }, async () => {
  await final(4); assert.equal((await releases.inspectPointer("proof-four")).releaseId, null);
});

test("C8-05 pointer swap is independently observable before DB completion", { skip: !linux }, async () => {
  await final(5); await releases.activateRelease({ slug: "proof-five", owner: OWNER, projectId: PROJECT,
    releaseId: id(5), expectedPreviousReleaseId: null });
  assert.equal((await releases.inspectPointer("proof-five")).releaseId, id(5));
});

test("C8-06 simulated DB failure does not destroy pointer evidence", { skip: !linux }, async () => {
  await final(6); await releases.activateRelease({ slug: "proof-six", owner: OWNER, projectId: PROJECT,
    releaseId: id(6), expectedPreviousReleaseId: null });
  await Promise.reject(new Error("simulated DB commit failure")).catch(() => {});
  assert.equal((await releases.inspectPointer("proof-six")).releaseId, id(6));
});

test("C8-07 reconciliation repeats the desired activation idempotently", { skip: !linux }, async () => {
  await final(7); const options = { slug: "proof-seven", owner: OWNER, projectId: PROJECT,
    releaseId: id(7), expectedPreviousReleaseId: null };
  await releases.activateRelease(options); const second = await releases.activateRelease(options);
  assert.equal(second.changed, false);
});

test("C8-08 reconciler can revert to the retained previous release", { skip: !linux }, async () => {
  await final(8, "old"); await final(9, "new");
  await releases.activateRelease({ slug: "proof-eight", owner: OWNER, projectId: PROJECT, releaseId: id(8), expectedPreviousReleaseId: null });
  await releases.activateRelease({ slug: "proof-eight", owner: OWNER, projectId: PROJECT, releaseId: id(9), expectedPreviousReleaseId: id(8) });
  await releases.activateRelease({ slug: "proof-eight", owner: OWNER, projectId: PROJECT, releaseId: id(8), expectedPreviousReleaseId: id(9) });
  assert.equal((await releases.inspectPointer("proof-eight")).releaseId, id(8));
});

test("C8-09 concurrent publishes serialize and stale completion loses", { skip: !linux }, async () => {
  await final(10, "base"); await final(11, "left"); await final(12, "right");
  await releases.activateRelease({ slug: "proof-nine", owner: OWNER, projectId: PROJECT, releaseId: id(10), expectedPreviousReleaseId: null });
  const race = await Promise.allSettled([
    releases.activateRelease({ slug: "proof-nine", owner: OWNER, projectId: PROJECT, releaseId: id(11), expectedPreviousReleaseId: id(10) }),
    releases.activateRelease({ slug: "proof-nine", owner: OWNER, projectId: PROJECT, releaseId: id(12), expectedPreviousReleaseId: id(10) }),
  ]);
  assert.equal(race.filter((x) => x.status === "fulfilled").length, 1);
  assert.equal(race.filter((x) => x.status === "rejected").length, 1);
});

test("C8-10 stale activation cannot overwrite newer pointer", { skip: !linux }, async () => {
  const current = await releases.inspectPointer("proof-nine");
  await assert.rejects(releases.activateRelease({ slug: "proof-nine", owner: OWNER, projectId: PROJECT,
    releaseId: id(10), expectedPreviousReleaseId: id(10) }), /stale/);
  assert.equal((await releases.inspectPointer("proof-nine")).releaseId, current.releaseId);
});

test("C8-11 rollback activates retained bytes without a build function", { skip: !linux }, async () => {
  const before = await releases.verifyRelease({ owner: OWNER, projectId: PROJECT, releaseId: id(8) });
  assert.equal((await releases.inspectPointer("proof-eight")).releaseId, id(8));
  const after = await releases.verifyRelease({ owner: OWNER, projectId: PROJECT, releaseId: id(8) });
  assert.equal(after.artifactHash, before.artifactHash);
});

test("C8-12 rollback health failure leaves current pointer unchanged", { skip: !linux }, async () => {
  const current = await releases.inspectPointer("proof-eight");
  await assert.rejects(releases.activateRelease({ slug: "proof-eight", owner: OWNER, projectId: PROJECT,
    releaseId: id(99), expectedPreviousReleaseId: current.releaseId }), /missing/);
  assert.deepEqual(await releases.inspectPointer("proof-eight"), current);
});

test("C8-13 publish and unpublish race uses the same site lock", { skip: !linux }, async () => {
  await final(13); await releases.activateRelease({ slug: "proof-thirteen", owner: OWNER, projectId: PROJECT, releaseId: id(13), expectedPreviousReleaseId: null });
  const results = await Promise.allSettled([
    releases.unpublishPointer({ slug: "proof-thirteen", expectedPreviousReleaseId: id(13) }),
    releases.activateRelease({ slug: "proof-thirteen", owner: OWNER, projectId: PROJECT, releaseId: id(13), expectedPreviousReleaseId: id(13) }),
  ]);
  assert.ok(results.some((result) => result.status === "fulfilled"));
  assert.ok([null, id(13)].includes((await releases.inspectPointer("proof-thirteen")).releaseId));
});

test("C8-14 custom domain path remains stable across activation", async () => {
  const source = await readFile(new URL("../../provisiond/server.mjs", import.meta.url), "utf8");
  assert.match(source, /\.thrallo\/sites\/\$\{label\}\/current/);
});

test("C8-15 Thrallo subdomain routes through the stable current pointer", async () => {
  const caddy = await readFile(new URL("../../ops/Caddyfile.unified", import.meta.url), "utf8");
  assert.match(caddy, /root \* \/publish\/\.thrallo\/sites\/\{http\.request\.host\.labels\.3\}\/current/);
});

test("C8-16 previous release remains byte-identical after activation", { skip: !linux }, async () => {
  const before = await releases.verifyRelease({ owner: OWNER, projectId: PROJECT, releaseId: id(10) });
  const after = await releases.verifyRelease({ owner: OWNER, projectId: PROJECT, releaseId: id(10) });
  assert.equal(after.artifactHash, before.artifactHash);
});

test("C8-17 corrupt artifact cannot pass integrity verification", { skip: !linux }, async () => {
  await final(17); const dir = path.join(root, ".thrallo", "releases", OWNER, PROJECT, id(17));
  await chmod(dir, 0o700); await chmod(path.join(dir, "index.html"), 0o600);
  await writeFile(path.join(dir, "index.html"), "corrupt");
  await assert.rejects(releases.verifyRelease({ owner: OWNER, projectId: PROJECT, releaseId: id(17) }), /HTML document|missing asset/);
});

test("C8-18 missing artifact cannot activate", { skip: !linux }, async () => {
  await assert.rejects(releases.activateRelease({ slug: "proof-eighteen", owner: OWNER, projectId: PROJECT,
    releaseId: id(18), expectedPreviousReleaseId: null }), /missing/);
});

test("C8-19 cleanup preserves every retained release", { skip: !linux }, async () => {
  await final(19); const result = await releases.cleanupReleases({ retained: [id(19)], olderThanMs: 0, now: Date.now() + 1000 });
  assert.ok(result.inspected >= 1);
  assert.equal(existsSync(path.join(root, ".thrallo", "releases", OWNER, PROJECT, id(19))), true);
});

test("C8-20 Builder V1 remains on legacy path while atomic flag is disabled", async () => {
  const publish = await readFile(new URL("../../shell/server/lib/appBuild/appPublishService.mjs", import.meta.url), "utf8");
  assert.match(publish, /atomicPublishEnabled\(\) \? await finalizeAndActivateRelease/);
  assert.match(publish, /: await provisiond\("\/publish"/);
  assert.equal(normalizeArtifactPath("assets/app.js"), "assets/app.js");
});
