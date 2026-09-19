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

test("the retired Android mutable-tree packaging surface is physically absent", async () => {
  const worker = await readCode("../../build-worker/index.mjs");
  assert.doesNotMatch(worker, /android_package|lib\/android\.mjs/);
  const queue = await readCode("../../shell/server/lib/buildWorkQueue.mjs");
  assert.doesNotMatch(queue, /android_package/);
  const migration = await readCode("../../supabase/migrations/20260813194500_enforce_v2_only_builder_contract.sql");
  assert.match(migration, /retired Android work rows remain/);
  const activeChecks = migration.split("drop constraint if exists build_work_payloads_job_type_check")[1];
  assert.ok(activeChecks, "V2-only migration must replace both durable-work type constraints");
  assert.doesNotMatch(activeChecks, /android_package/);
});

test("the live Builder V2 publisher imports only the shared slug utility", async () => {
  const publisher = await readCode("../../shell/server/lib/appBuild/appPublishService.mjs");
  assert.match(publisher, /from "\.\.\/publishing\/siteSlug\.mjs"/);
  assert.doesNotMatch(publisher, /routes\/publish\.mjs/);
});
