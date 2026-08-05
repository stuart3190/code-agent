// Remediation for the 2026-08-05 cached-token billing defect. DRY RUN by default.
//
// GROUNDED IN THE ACTUAL LEDGER (ca_usage_records), not reconstructed from ai_requests. The first
// draft of this script reconstructed charges from the per-call diagnostics and proposed restoring
// 222.85 credits across 13 owners — but 11 of those owners were throwaway proof accounts whose
// deletion cascaded their ledger rows away. They have no debit to restore. The pre-apply check
// ("no build without an actual managed-ledger debit") caught it, which is exactly what it is for.
//
// The remediation universe is therefore every SURVIVING managed app_build debit row with cached
// tokens: for each, the flat rule charged metadata.total_tokens/TOKENS_PER_CREDIT, and the
// canonical price is creditsForUsage over the row's own recorded token split. The correction is
// one appended adjustment row per ledger row, keyed cached-fix:<ledger_row_id> — stable, unique,
// and idempotent. Originals are never edited or deleted.
//
//   node ops/billing-remediation.mjs           # dry run — full reconciliation, writes nothing
//   node ops/billing-remediation.mjs --apply   # append adjustments (re-run safe)

import { loadEnv } from "../shell/server/lib/env.mjs";
import { serviceClient } from "../shell/server/lib/supabase.mjs";
import { TOKENS_PER_CREDIT } from "../src/cost.mjs";
import { creditsForUsage } from "../src/billing/costModel.mjs";

loadEnv();
const APPLY = process.argv.includes("--apply");
const db = serviceClient();
const r4 = (n) => Math.round(n * 10_000) / 10_000;

const { data: debits, error } = await db.from("ca_usage_records")
  .select("id,owner,model,input_tokens,cached_tokens,output_tokens,reasoning_tokens,metadata,created_at")
  .eq("billing_source", "managed")
  .gt("cached_tokens", 0);
if (error) { console.error(error.message); process.exit(1); }

const rows = (debits || []).filter((u) => u.metadata?.kind === "app_build");

// Idempotency: which corrections already exist?
const { data: existing } = await db.from("ca_usage_records")
  .select("metadata").eq("model", "adjustment");
const done = new Set((existing || [])
  .filter((r) => r.metadata?.kind === "cached_token_billing_correction")
  .map((r) => r.metadata?.ref));

let totalRestore = 0;
let pending = 0;
const owners = new Map();
console.log("ledger_row  owner     model          flat     corrected  restore   status");
for (const u of rows.sort((a, b) => a.created_at.localeCompare(b.created_at))) {
  const totalTok = Number(u.metadata?.total_tokens || (u.input_tokens + u.output_tokens));
  const flat = r4(totalTok / TOKENS_PER_CREDIT);
  const corrected = r4(creditsForUsage({
    usage: {
      input: u.input_tokens, cached: u.cached_tokens,
      output: u.output_tokens, reasoning: u.reasoning_tokens, total: totalTok,
    },
    model: u.model,
  }));
  const over = r4(Math.max(0, flat - corrected));
  if (over < 0.005) continue;

  const ref = `cached-fix:${u.id}`;
  const already = done.has(ref);
  if (!already) pending += 1;
  totalRestore += already ? 0 : over;
  owners.set(u.owner, r4((owners.get(u.owner) || 0) + (already ? 0 : over)));
  const restoreTokens = Math.round(over * TOKENS_PER_CREDIT);
  console.log(`${u.id.slice(0, 8)}    ${u.owner.slice(0, 8)}  ${String(u.model).padEnd(13)} ${flat.toFixed(2).padStart(7)}  ${corrected.toFixed(2).padStart(8)}  ${over.toFixed(2).padStart(7)}   ${already ? "already-adjusted" : "pending"}`);

  if (APPLY && !already) {
    const { error: ierr } = await db.from("ca_usage_records").insert({
      owner: u.owner, run_id: null, provider: "app-build", model: "adjustment",
      // Negative input restores the token-denominated allowance by exactly the overcharge.
      input_tokens: -restoreTokens, cached_tokens: 0, output_tokens: 0, reasoning_tokens: 0,
      compute_seconds: 0, amount_gbp: 0, billing_source: "managed",
      metadata: {
        kind: "cached_token_billing_correction", ref,
        original_debit_credits: flat, corrected_debit_credits: corrected,
        restored_credits: over, restored_tokens: restoreTokens,
        source_ledger_row: u.id, reason: "cached tokens were priced as fresh input by a flat tokens-per-credit rule",
      },
    });
    // Stop on any mismatch rather than partially guessing.
    if (ierr) { console.error(`  FAILED on ${ref}: ${ierr.message} — stopping.`); process.exit(1); }
    console.log(`  adjusted: +${restoreTokens} tokens (${over.toFixed(4)} credits) restored`);
  }
}

console.log(`\n${rows.length} surviving managed debit rows with cached tokens`);
console.log(`${pending} pending correction(s) · ${done.size} already applied`);
for (const [owner, amount] of owners) if (amount > 0) console.log(`  owner ${owner.slice(0, 8)}: ${amount.toFixed(2)} credits to restore`);
console.log(`TOTAL ${APPLY ? "RESTORED" : "TO RESTORE"}: ${totalRestore.toFixed(2)} credits`);
console.log(APPLY ? "APPLIED (idempotent — re-running changes nothing)." : "DRY RUN — nothing written.");
