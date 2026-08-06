// WP-14 drift check — the shadow week's daily reading. For every project in shadow state:
// re-index the LIVE projects.tree and compare against what the twins persisted. Zero model
// credits; read-only except nothing. Exit 0 = clean, 1 = drift found.
//
//   node ops/bv2-shadow-drift.mjs

import { serviceClient } from "../shell/server/lib/supabase.mjs";
import { indexTree } from "../shell/server/lib/builderV2/indexer.mjs";

const client = serviceClient();
const log = (line) => console.log(`[bv2-drift] ${line}`);

const { data: shadows, error } = await client.from("bv2_migration_state")
  .select("owner, project_id, state, last_shadow_at, notes").eq("state", "shadow");
if (error) { console.error(`migration state unreadable: ${error.message}`); process.exit(1); }
if (!shadows?.length) { log("no projects in shadow state yet"); process.exit(0); }

let drift = 0;
for (const row of shadows) {
  const { data: project } = await client.from("projects")
    .select("tree").eq("id", row.project_id).maybeSingle();
  if (!project?.tree) { log(`${row.project_id.slice(0, 8)}: project tree missing — SKIP (deleted?)`); continue; }

  const fresh = indexTree(project.tree);
  const persistedHash = row.notes?.treeHash || null;

  // The tree may legitimately have moved since the last shadow pass (user edits between
  // builds); drift means the PERSISTED index disagrees with the tree it claims to describe.
  const { data: revisions } = await client.from("bv2_file_revisions")
    .select("path, content_hash").eq("owner", row.owner).eq("project_id", row.project_id);
  const persisted = new Map((revisions || []).map((r) => [r.path, r.content_hash]));
  const mismatches = [];
  for (const [path, ix] of fresh.files) {
    const have = persisted.get(path);
    if (have && have !== ix.contentHash) mismatches.push(path);
  }

  if (fresh.treeHash === persistedHash && mismatches.length === 0) {
    log(`${row.project_id.slice(0, 8)}: CLEAN (${fresh.files.size} files, shadowed ${row.last_shadow_at})`);
  } else if (mismatches.length === 0) {
    log(`${row.project_id.slice(0, 8)}: tree moved since last shadow (${row.last_shadow_at}) — no index disagreement, next build re-shadows`);
  } else {
    drift += 1;
    log(`${row.project_id.slice(0, 8)}: DRIFT — ${mismatches.length} file(s) disagree with the persisted index: ${mismatches.slice(0, 5).join(", ")}`);
  }
}
log(`${shadows.length} shadow project(s), ${drift} with drift`);
process.exit(drift ? 1 : 0);
