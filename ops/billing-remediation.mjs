// Remediation for the 2026-08-05 cached-token billing defect. DRY RUN by default.
//
// The defect: budgetLedger.debit priced managed usage at a flat (input+output)/TOKENS_PER_CREDIT,
// charging cached input tokens as fresh and ignoring model weighting. Every reporting surface
// (ai_requests.cost, diag_steps, diag_runs.totals) used the cache-aware costModel and was right;
// the debit was wrong. Run 83883309: real cost 19.25 credits, debited 51.33.
//
// What was actually harmed: the managed MONTHLY ALLOWANCE (token-denominated) burned ~2.5× faster
// than the canonical cost basis, and every credit figure shown to a customer or compared against a
// ceiling was inflated. No per-build Stripe charge exists, so no cash moved — the correction is an
// allowance restoration, not a refund.
//
// The correction: one idempotent adjustment row per affected BUILD (stable id
// `cached-fix:<build_id>`), restoring tokens equal to the overcharge in credits ×
// TOKENS_PER_CREDIT. Original usage rows are never rewritten or deleted.
//
//   node ops/billing-remediation.mjs           # dry run — prints the full reconciliation
//   node ops/billing-remediation.mjs --apply   # appends adjustments (idempotent; re-run safe)

import { loadEnv } from "../shell/server/lib/env.mjs";
import { serviceClient } from "../shell/server/lib/supabase.mjs";
import { TOKENS_PER_CREDIT } from "../src/cost.mjs";

loadEnv();
const APPLY = process.argv.includes("--apply");
const db = serviceClient();

// Per-build overcharge, computed from the immutable per-call records. ai_requests.cost is the
// canonical cache-aware figure; the flat charge is reconstructed from the stored token counts.
const { data: builds, error: qerr } = await db.from("ai_requests")
  .select("owner,build_id,input_tokens,output_tokens,cost,cached_tokens,byok,created_at")
  .gt("cached_tokens", 0);
if (qerr) { console.error(qerr.message); process.exit(1); }

const byBuild = new Map();
for (const r of builds || []) {
  if (r.byok === true || !r.build_id) continue;
  const entry = byBuild.get(r.build_id) || { owner: r.owner, flat: 0, canonical: 0, calls: 0, at: r.created_at };
  entry.flat += (r.input_tokens + r.output_tokens) / TOKENS_PER_CREDIT;
  entry.canonical += Number(r.cost || 0);
  entry.calls += 1;
  byBuild.set(r.build_id, entry);
}

let totalOver = 0;
const owners = new Set();
console.log("build     owner     calls  flat     canonical  overcharge  restore_tokens");
for (const [buildId, e] of byBuild) {
  const over = Math.max(0, e.flat - e.canonical);
  if (over < 0.005) continue;
  totalOver += over;
  owners.add(e.owner);
  const restore = Math.round(over * TOKENS_PER_CREDIT);
  console.log(`${buildId.slice(0, 8)}  ${e.owner.slice(0, 8)}  ${String(e.calls).padStart(3)}  ${e.flat.toFixed(2).padStart(7)}  ${e.canonical.toFixed(2).padStart(8)}  ${over.toFixed(2).padStart(9)}  ${restore}`);

  if (APPLY) {
    // Idempotent: the stable metadata ref is checked before insert, so re-running appends nothing.
    const ref = `cached-fix:${buildId}`;
    const { data: existing } = await db.from("usage_records")
      .select("id").eq("metadata->>ref", ref).limit(1);
    if (existing?.length) { console.log(`  (already adjusted — skipped)`); continue; }
    const { error: ierr } = await db.from("usage_records").insert({
      owner: e.owner, provider: "app-build", model: "adjustment",
      input_tokens: -restore, cached_tokens: 0, output_tokens: 0, reasoning_tokens: 0,
      compute_seconds: 0, amount_gbp: 0, billing_source: "managed",
      metadata: { kind: "cached_token_billing_correction", ref, build_id: buildId,
        overcharge_credits: Number(over.toFixed(4)) },
    });
    if (ierr) console.error(`  FAILED: ${ierr.message}`);
    else console.log(`  adjusted: +${restore} tokens restored`);
  }
}
console.log(`\n${byBuild.size} builds inspected · ${owners.size} owners · total overcharge ${totalOver.toFixed(2)} credits`);
console.log(APPLY ? "ADJUSTMENTS APPLIED (idempotent)." : "DRY RUN — nothing written. Re-run with --apply after review.");
