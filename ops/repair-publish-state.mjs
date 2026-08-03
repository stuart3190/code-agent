// Detect and repair inconsistent publication state.
//
// The invariant: a product has at most ONE live published record. Two means the platform must pick
// a winner on read, and two surfaces picking differently is precisely the disagreement PR 7
// removes. The database now holds this with a partial unique index, but the index can only refuse
// NEW violations — anything already in the table has to be found and repaired.
//
// Repair never deletes. The slug, the URL and the publish history live on the row, and a republish
// has to return to the same address, so a superseded record is stamped `unpublished_at` and left
// in place. Every change is written to project_logs so the owner can see what happened to their
// site, and printed as an audit line.
//
//   node ops/repair-publish-state.mjs            # report only
//   node ops/repair-publish-state.mjs --apply    # repair

import { serviceClient } from "../shell/server/lib/supabase.mjs";
import { publishStates } from "../shell/server/lib/publishState.mjs";
import { resolvePublishState, pickActiveSite } from "../shell/shared/publishResolution.mjs";

const APPLY = process.argv.includes("--apply");
const db = serviceClient();

const findings = [];
const note = (kind, detail) => { findings.push({ kind, ...detail }); };

// ── Every owner that has ever published ─────────────────────────────────────────────────
const { data: sites, error } = await db.from("published_sites").select("owner,project_id,product_id,slug,unpublished_at,updated_at");
if (error) { console.error(`could not read published_sites: ${error.message}`); process.exit(1); }
const owners = [...new Set((sites || []).map((s) => s.owner))];
console.log(`[repair] ${sites.length} published record(s) across ${owners.length} owner(s)`);

for (const owner of owners) {
  const states = await publishStates(owner, db);
  const resolved = resolvePublishState(states);

  // 1. Several LIVE records for one product.
  for (const conflict of resolved.conflicts) {
    const winner = resolved.forProduct(conflict.productId);
    note("multiple_live", {
      owner, productId: conflict.productId,
      keeping: conflict.active,
      retiring: conflict.superseded,
      why: `kept the most recently published (${winner?.publishedAt}); the others are historical`,
    });
    if (!APPLY) continue;
    for (const projectId of conflict.superseded) {
      const stamped = new Date().toISOString();
      const { error: updateError } = await db.from("published_sites")
        .update({ unpublished_at: stamped, updated_at: stamped })
        .eq("owner", owner).eq("project_id", String(projectId));
      if (updateError) { console.error(`  ! ${projectId}: ${updateError.message}`); continue; }
      // The owner sees this in their own logs, not just in an operator's terminal.
      await db.from("project_logs").insert({
        owner, project_id: String(projectId), logged_at: stamped,
        level: "warning", source: "system",
        message: "Superseded publish record retired",
        detail: `This project had an older publish record for the same app while ${conflict.active} was live. `
          + "It has been marked as no longer serving. The live site and its address are unchanged.",
        ref_type: "project", ref_id: String(conflict.active),
      }).catch(() => {});
      console.log(JSON.stringify({ audit: "publish_state_repair", kind: "retired_superseded", owner, projectId, keeping: conflict.active, at: stamped }));
    }
  }

  // 2. product_id missing from the row while the project has one. Not a disagreement yet, but the
  //    database index cannot guard a row whose product it does not know.
  for (const site of sites.filter((s) => s.owner === owner)) {
    const state = resolved.forProject(site.project_id);
    if (!state) continue;
    if (state.productId && !site.product_id) {
      note("missing_product_link", { owner, projectId: site.project_id, productId: state.productId });
      if (!APPLY) continue;
      const { error: fixError } = await db.from("published_sites")
        .update({ product_id: String(state.productId) })
        .eq("owner", owner).eq("project_id", String(site.project_id));
      if (fixError) console.error(`  ! ${site.project_id}: ${fixError.message}`);
      else console.log(JSON.stringify({ audit: "publish_state_repair", kind: "backfilled_product", owner, projectId: site.project_id, productId: state.productId }));
    }
    // 3. A published project with no product at all. Reported, never invented: there is no link in
    //    the schema to derive one from, and guessing would attach a live site to the wrong app.
    if (!state.productId) {
      note("no_product_link", {
        owner, projectId: site.project_id, slug: site.slug, live: !site.unpublished_at,
        why: "resolvable by project id, but no conversation can reach it — needs a human decision",
      });
    }
  }
}

// ── Report ──────────────────────────────────────────────────────────────────────────────
console.log("");
if (!findings.length) {
  console.log("No inconsistencies found. Every product resolves to exactly one publish record.");
} else {
  for (const finding of findings) console.log(`${finding.kind}: ${JSON.stringify(finding)}`);
  console.log(`\n${findings.length} finding(s)${APPLY ? " — repaired" : " — run with --apply to repair"}`);
}

// The repair must leave the invariant true, not merely attempt it.
if (APPLY) {
  let stillBroken = 0;
  for (const owner of owners) {
    const after = resolvePublishState(await publishStates(owner, db));
    stillBroken += after.conflicts.length;
  }
  console.log(stillBroken ? `\nFAILED: ${stillBroken} conflict(s) remain` : "\nVerified: no conflicts remain.");
  process.exit(stillBroken ? 1 : 0);
}

// Reporting mode exits non-zero only on a real disagreement, so it can be wired to an alert without
// firing on the informational "no product link" case.
process.exit(findings.some((f) => f.kind === "multiple_live") ? 1 : 0);
