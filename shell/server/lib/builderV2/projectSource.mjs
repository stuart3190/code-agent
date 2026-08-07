// Authoritative source resolution during V1 -> V2 adoption.
// V2 projects are always materialised from the byte-verified green snapshot. projects.tree is a
// temporary UI/export compatibility projection and is never trusted as the V2 source of truth.

import { serviceClient } from "../supabase.mjs";
import { createSnapshotStore } from "./snapshotStore.mjs";
import { supabaseSnapshotStorage } from "./supabaseTwins.mjs";

export async function resolveVerifiedProjectTree(owner, project, {
  client = serviceClient(), snapshotStore = null, allowLegacy = true, log = console.warn,
} = {}) {
  if (!project?.id) throw new Error("project source resolution requires a project id");
  let identity = project;
  if (!("builder_version" in identity) || !("bv2_green_snapshot_id" in identity)) {
    const { data, error } = await client.from("projects")
      .select("id,owner,builder_version,bv2_green_snapshot_id").eq("id", project.id).eq("owner", owner).maybeSingle();
    if (error) throw new Error(`project source identity: ${error.message}`);
    if (!data) throw Object.assign(new Error("project not found"), { code: "project_missing" });
    identity = { ...project, ...data };
  }
  if (identity.builder_version !== "v2") {
    if (!allowLegacy) throw Object.assign(new Error("project has not been adopted into Builder V2"), { code: "v2_adoption_required" });
    if (!identity.tree || typeof identity.tree !== "object") {
      throw Object.assign(new Error("Build the app before using it."), { code: "no_app" });
    }
    return { tree: identity.tree, source: "legacy_tree", snapshotId: null, project: identity };
  }
  if (!identity.bv2_green_snapshot_id) {
    throw Object.assign(new Error("Builder V2 project has no verified green snapshot."), { code: "snapshot_missing" });
  }
  const store = snapshotStore || createSnapshotStore(supabaseSnapshotStorage({ client }));
  const tree = await store.materialize(owner, identity.bv2_green_snapshot_id);
  if (identity.tree && JSON.stringify(identity.tree) !== JSON.stringify(tree)) {
    log(`[bv2] compatibility projection drift for ${project.id}; serving snapshot ${identity.bv2_green_snapshot_id}`);
  }
  return { tree, source: "bv2_green_snapshot", snapshotId: identity.bv2_green_snapshot_id, project: identity };
}
