import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const deliveryUrl = new URL("../../shell/server/lib/appBuild/appDeliveryService.mjs", import.meta.url);
const legacyUrl = new URL("../../shell/server/lib/appBuild/appBuildService.mjs", import.meta.url);

test("the customer app service exposes only V2 delivery operations", async () => {
  const source = await readFile(deliveryUrl, "utf8");
  const exports = [...source.matchAll(/export async function (\w+)/g)].map((match) => match[1]);
  assert.deepEqual(exports, ["showPreview", "runQaSweep", "exportProject"]);
  assert.doesNotMatch(source, /startAppBuild|repairApp|planEndAction|checkpoint|mutable tree/i);
  assert.doesNotMatch(source, /columns: "[^"]*\btree\b/, "delivery must not read the mutable tree projection");
  await assert.rejects(access(legacyUrl), (error) => error?.code === "ENOENT");
});

test("preview and export materialize only an authoritative V2 green snapshot", async () => {
  const source = await readFile(deliveryUrl, "utf8");
  assert.equal((source.match(/allowLegacy: false/g) || []).length, 2);
  assert.equal((source.match(/builder_version, bv2_green_snapshot_id/g) || []).length, 3);
  assert.match(source, /previews\.mode !== "vps"/);
  assert.match(source, /preview_isolation_required/);
});

test("core capabilities import the V2 delivery service and no legacy app-build service", async () => {
  const source = await readFile(
    new URL("../../shell/server/lib/capabilities/coreCapabilities.mjs", import.meta.url),
    "utf8",
  );
  assert.match(source, /from "\.\.\/appBuild\/appDeliveryService\.mjs"/);
  assert.doesNotMatch(source, /appBuildService\.mjs/);
});
