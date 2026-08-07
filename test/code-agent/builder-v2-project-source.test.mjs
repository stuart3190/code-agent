import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { resolveVerifiedProjectTree } from "../../shell/server/lib/builderV2/projectSource.mjs";

test("V2 preview/export source is the verified snapshot, never the mutable projection", async () => {
  const warnings = [];
  const source = await resolveVerifiedProjectTree("owner", {
    id: "project", owner: "owner", builder_version: "v2", bv2_green_snapshot_id: "snapshot",
    tree: { "src/App.jsx": "stale" },
  }, {
    client: {}, snapshotStore: { materialize: async (owner, id) => {
      assert.equal(owner, "owner"); assert.equal(id, "snapshot");
      return { "src/App.jsx": "verified" };
    } },
    log: (line) => warnings.push(line),
  });
  assert.deepEqual(source.tree, { "src/App.jsx": "verified" });
  assert.equal(source.source, "bv2_green_snapshot");
  assert.equal(warnings.length, 1, "projection drift remains visible");
});

test("a V2 project without a verified snapshot fails closed", async () => {
  await assert.rejects(resolveVerifiedProjectTree("owner", {
    id: "project", builder_version: "v2", bv2_green_snapshot_id: null, tree: { x: "unverified" },
  }, { client: {} }), (error) => error.code === "snapshot_missing");
});

test("legacy tree remains available only through the explicit compatibility branch", async () => {
  const legacy = await resolveVerifiedProjectTree("owner", {
    id: "project", builder_version: "v1", bv2_green_snapshot_id: null, tree: { x: "legacy" },
  }, { client: {} });
  assert.equal(legacy.source, "legacy_tree");
  await assert.rejects(resolveVerifiedProjectTree("owner", {
    id: "project", builder_version: "v1", bv2_green_snapshot_id: null, tree: { x: "legacy" },
  }, { client: {}, allowLegacy: false }), (error) => error.code === "v2_adoption_required");
});

test("V2 publish, rollback and unpublish fail closed unless C8 is enabled", async () => {
  const source = await readFile(new URL("../../shell/server/lib/appBuild/appPublishService.mjs", import.meta.url), "utf8");
  assert.match(source, /project\.builder_version === "v2" && !useAtomic/);
  assert.match(source, /Builder V2 publish packaging did not run in the durable worker/);
  assert.match(source, /Builder V2 rollback requires a retained immutable release/);
  assert.match(source, /Builder V2 unpublish requires the atomic deployment state machine/);
});
