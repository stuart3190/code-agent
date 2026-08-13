import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { resolveVerifiedProjectTree } from "../../shell/server/lib/builderV2/projectSource.mjs";

test("V2 preview/export source is the verified snapshot, never the mutable projection", async () => {
  const source = await resolveVerifiedProjectTree("owner", {
    id: "project", owner: "owner", builder_version: "v2", bv2_green_snapshot_id: "snapshot",
    tree: { "src/App.jsx": "stale" },
  }, {
    client: {}, snapshotStore: { materialize: async (owner, id) => {
      assert.equal(owner, "owner"); assert.equal(id, "snapshot");
      return { "src/App.jsx": "verified" };
    } },
  });
  assert.deepEqual(source.tree, { "src/App.jsx": "verified" });
  assert.equal(source.source, "bv2_green_snapshot");
});

test("a V2 project without a verified snapshot fails closed", async () => {
  await assert.rejects(resolveVerifiedProjectTree("owner", {
    id: "project", builder_version: "v2", bv2_green_snapshot_id: null, tree: { x: "unverified" },
  }, { client: {} }), (error) => error.code === "snapshot_missing");
});

test("non-V2 project source is rejected without a mutable-tree compatibility path", async () => {
  await assert.rejects(resolveVerifiedProjectTree("owner", {
    id: "project", builder_version: "v1", bv2_green_snapshot_id: null, tree: { x: "legacy" },
  }, { client: {} }), (error) => error.code === "v2_project_required");
});

test("V2 publish, rollback and unpublish use only immutable atomic releases", async () => {
  const source = await readFile(new URL("../../shell/server/lib/appBuild/appPublishService.mjs", import.meta.url), "utf8");
  assert.match(source, /assertPublishIntakeReady/);
  assert.match(source, /Builder V2 publish packaging did not run in the durable worker/);
  assert.match(source, /activateRetainedRelease/);
  assert.match(source, /atomicUnpublish/);
  assert.doesNotMatch(source, /useAtomic|transferSite/);
});
