import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { slugifySiteName } from "../../shell/server/lib/publishing/siteSlug.mjs";

const readCode = (relativePath) => readFile(new URL(relativePath, import.meta.url), "utf8");

test("the shared publishing slug normalizer preserves the retired route contract", () => {
  assert.equal(slugifySiteName("Ledger & Co"), "ledger-co");
  assert.equal(slugifySiteName("Sam's Place"), "sams-place");
  assert.equal(slugifySiteName("Sam\u2019s Place"), "sams-place");
  assert.equal(slugifySiteName(`  ${"A".repeat(45)}---`), "a".repeat(40));
});

test("Android packaging depends on route-independent publishing support", async () => {
  const worker = await readCode("../../build-worker/index.mjs");
  assert.match(worker, /job\.job_type === "android_package"/);
  assert.match(worker, /import\("\.\.\/shell\/server\/lib\/android\.mjs"\)/);

  const android = await readCode("../../shell/server/lib/android.mjs");
  assert.match(android, /from "\.\/publishing\/materializePublish\.mjs"/);
  assert.doesNotMatch(android, /routes\/publish\.mjs/);

  const publisher = await readCode("../../shell/server/lib/publishing/materializePublish.mjs");
  assert.match(publisher, /export async function materializeAndPublish/);
  for (const required of [
    "packagePublishTree",
    "withPwaAssets",
    "assetlinksJson",
    "finalizeAndActivateRelease",
    "recordRelease",
  ]) {
    assert.ok(publisher.includes(required), `shared publisher lost ${required}`);
  }
});

test("the live Builder V2 publisher imports only the shared slug utility", async () => {
  const publisher = await readCode("../../shell/server/lib/appBuild/appPublishService.mjs");
  assert.match(publisher, /from "\.\.\/publishing\/siteSlug\.mjs"/);
  assert.doesNotMatch(publisher, /routes\/publish\.mjs/);
});
