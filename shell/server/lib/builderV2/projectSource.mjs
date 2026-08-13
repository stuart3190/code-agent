// Authoritative Builder V2 source resolution.
// Projects are always materialised from the byte-verified green snapshot. projects.tree is never
// read or trusted as executable source.

import { serviceClient } from "../supabase.mjs";
import { createSnapshotStore } from "./snapshotStore.mjs";
import { supabaseSnapshotStorage } from "./supabaseTwins.mjs";

export async function resolveVerifiedProjectTree(owner, project, {
  client = serviceClient(), snapshotStore = null,
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
    throw Object.assign(new Error("Only Builder V2 projects are supported."), { code: "v2_project_required" });
  }
  if (!identity.bv2_green_snapshot_id) {
    throw Object.assign(new Error("Builder V2 project has no verified green snapshot."), { code: "snapshot_missing" });
  }
  const store = snapshotStore || createSnapshotStore(supabaseSnapshotStorage({ client }));
  const tree = await store.materialize(owner, identity.bv2_green_snapshot_id);
  return { tree, source: "bv2_green_snapshot", snapshotId: identity.bv2_green_snapshot_id, project: identity };
}
