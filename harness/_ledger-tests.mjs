// Offline ledger tests — NO network. A tiny in-memory fake of the Supabase query surface drives the
// REAL src/billing/ledger.mjs, so the bundle-first split, the per-tier hard ceiling, the rollover cap
// and idempotency are asserted against the actual SDK code (only the DB is faked). Every credit number
// is checked against costModel (creditsForTurn / breakeven / bundleRolloverCapCredits) — the ledger
// must never produce a figure the model didn't.
// Run: node harness/_ledger-tests.mjs   (exit 0 = all pass)

import { createLedger } from "../src/billing/ledger.mjs";
import {
  creditsForTurn,
  breakeven,
  bundleRolloverCapCredits,
  userHardCeilCredits,
  TIERS,
} from "../src/billing/costModel.mjs";

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); }
}
const near = (a, b, eps = 0.0005) => Math.abs(a - b) <= eps;
const studio = TIERS.find((t) => t.id === "studio");
const starter = TIERS.find((t) => t.id === "starter");

// ── in-memory Supabase fake (only the methods ledger.mjs uses) ─────────────────────────────────
function makeFakeClient() {
  const store = { credit_ledger: [], customers: [] };
  let seq = 0;
  const UNIQUE = { credit_ledger: ["owner", "ref", "kind", "bucket"] };

  class Query {
    constructor(table) { this.table = table; this.filters = []; this.op = "select"; this.single = false; this.returnRows = false; }
    select() { if (this.op === "insert" || this.op === "upsert") this.returnRows = true; return this; }
    eq(c, v) { this.filters.push(["eq", c, v]); return this; }
    gte(c, v) { this.filters.push(["gte", c, v]); return this; }
    maybeSingle() { this.single = true; return this.exec(); }
    insert(rows) { this.op = "insert"; this.rows = Array.isArray(rows) ? rows : [rows]; return this; }
    upsert(patch, opts) { this.op = "upsert"; this.rows = [patch]; this.onConflict = opts?.onConflict; return this; }
    then(res, rej) { return this.exec().then(res, rej); }
    match(row) {
      return this.filters.every(([kind, c, v]) =>
        kind === "eq" ? String(row[c]) === String(v) : kind === "gte" ? String(row[c]) >= String(v) : true);
    }
    async exec() {
      const tbl = store[this.table];
      if (this.op === "select") {
        const rows = tbl.filter((r) => this.match(r));
        return this.single ? { data: rows[0] ?? null, error: null } : { data: rows, error: null };
      }
      if (this.op === "insert") {
        const uq = UNIQUE[this.table];
        const out = [];
        for (const row of this.rows) {
          if (uq && tbl.some((r) => uq.every((k) => String(r[k]) === String(row[k]))))
            return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } };
          const full = { id: `id-${++seq}`, ts: new Date().toISOString(), created_at: new Date().toISOString(), ...row };
          tbl.push(full); out.push(full);
        }
        return { data: this.returnRows ? out : null, error: null };
      }
      if (this.op === "upsert") {
        const patch = this.rows[0];
        const i = tbl.findIndex((r) => String(r[this.onConflict]) === String(patch[this.onConflict]));
        let row;
        if (i >= 0) { row = { ...tbl[i], ...patch }; tbl[i] = row; }
        else { row = { id: `id-${++seq}`, ...patch }; tbl.push(row); }
        return { data: this.returnRows ? [row] : null, error: null };
      }
    }
  }
  return { from: (table) => new Query(table), _store: store };
}

const newLedger = () => createLedger(makeFakeClient());
const OWNER = "user-A";

console.log("grant + getBalance (balance = Σ delta):");
{
  const L = newLedger();
  await L.grant({ owner: OWNER, credits: 2000, bucket: "bundle", ref: "grant:1", cycle: "2026-07" });
  const b = await L.getBalance(OWNER);
  check("bundle grant of 2000 -> balance.bundle == 2000", b.bundle === 2000 && b.total === 2000 && b.topup === 0);
}

console.log("debit is model-WEIGHTED (straight from costModel.creditsForTurn):");
{
  const L = newLedger();
  await L.grant({ owner: OWNER, credits: 100, bucket: "bundle", ref: "g" });
  const need = creditsForTurn({ tokens: 10000, model: "claude-opus-4-8" }); // ~1.667
  const res = await L.debit({ owner: OWNER, tokens: 10000, model: "claude-opus-4-8", ref: "turn-1", tier: null });
  check(`10k Opus debits creditsForTurn() (${need.toFixed(3)})`, res.ok && near(res.debited, need));
  const b = await L.getBalance(OWNER);
  check("balance dropped by exactly the weighted need", near(b.bundle, 100 - need));
}

console.log("BUNDLE-FIRST split across both buckets (one row per bucket):");
{
  const L = newLedger();
  await L.grant({ owner: OWNER, credits: 1, bucket: "bundle", ref: "gb" });
  await L.grant({ owner: OWNER, credits: 5, bucket: "topup", ref: "gt" });
  const need = creditsForTurn({ tokens: 10000, model: "claude-opus-4-8" }); // 1.667 > bundle 1
  const res = await L.debit({ owner: OWNER, tokens: 10000, model: "claude-opus-4-8", ref: "turn-split", tier: null });
  check("fromBundle drains bundle first (==1)", res.ok && near(res.fromBundle, 1));
  check(`fromTopup covers the remainder (${(need - 1).toFixed(3)})`, near(res.fromTopup, need - 1));
  const b = await L.getBalance(OWNER);
  check("bundle emptied, top-up bears the overflow", near(b.bundle, 0) && near(b.topup, 5 - (need - 1)));
}

console.log("pre-turn BALANCE check refuses when short:");
{
  const L = newLedger();
  await L.grant({ owner: OWNER, credits: 0.5, bucket: "bundle", ref: "g" });
  const res = await L.debit({ owner: OWNER, tokens: 10000, model: "claude-sonnet-4-6", ref: "turn-short", tier: null });
  check("debit needing 1.0 with 0.5 balance is refused (insufficient_balance)", !res.ok && res.reason === "insufficient_balance");
  const b = await L.getBalance(OWNER);
  check("refused turn wrote NOTHING (balance unchanged)", b.total === 0.5);
}

console.log("final-job grace debit consumes the remaining balance without going negative:");
{
  const L = newLedger();
  await L.grant({ owner: OWNER, credits: 1.29, bucket: "topup", ref: "partial-g" });
  const res = await L.debit({
    owner: OWNER, tokens: 164358, model: "gpt-5.5", ref: "partial-turn",
    tier: null, allowPartial: true,
  });
  check("16.4358-credit usage debits the available 1.29 credits", res.ok && res.partial && res.debited === 1.29 && res.need === 16.4358);
  check("partial debit reports the unpaid usage difference", near(res.shortfall, 15.1458));
  check("partial debit leaves exactly zero, never a negative balance", (await L.getBalance(OWNER)).total === 0);
  const replay = await L.debit({
    owner: OWNER, tokens: 164358, model: "gpt-5.5", ref: "partial-turn",
    tier: null, allowPartial: true,
  });
  check("replaying a partial debit is idempotent", replay.ok && replay.idempotent && replay.debited === 1.29);
}

console.log("per-tier HARD CEILING (== tier breakeven from costModel):");
{
  const L = newLedger();
  const ceil = userHardCeilCredits(starter); // breakeven ~301
  check("ceiling equals starter breakeven", near(ceil, breakeven(starter).breakevenCredits, 0.01));
  await L.setEntitlement({ owner: OWNER, tier: "starter" });
  await L.grant({ owner: OWNER, credits: 10000, bucket: "topup", ref: "big" }); // balance never the limiter
  // Burn just under the ceiling in one Sonnet turn (weight 1 => credits == tokens/10k).
  const underTokens = Math.floor((ceil - 2) * 10000);
  const a = await L.debit({ owner: OWNER, tokens: underTokens, model: "claude-sonnet-4-6", ref: "near" });
  check(`debit to just under ceiling is allowed (spent ${a.debited?.toFixed(1)})`, a.ok);
  // The next turn would cross the ceiling -> refused.
  const b = await L.debit({ owner: OWNER, tokens: 50000, model: "claude-sonnet-4-6", ref: "over" }); // +5 credits
  check("the turn that would cross the ceiling is refused (hard_ceiling)", !b.ok && b.reason === "hard_ceiling");
  check("ceiling refusal reports the tier and limit", b.tier === "starter" && near(b.ceiling, ceil, 0.01));
}

console.log("rollover job caps carry at breakeven − bundle (can't bank past breakeven):");
{
  const L = newLedger();
  const cap = bundleRolloverCapCredits(studio);      // 1009
  const be = breakeven(studio).breakevenCredits;     // 3009
  await L.setEntitlement({ owner: OWNER, tier: "studio" });
  await L.grant({ owner: OWNER, credits: 2000, bucket: "bundle", ref: "g-jun", cycle: "2026-06" });
  await L.debit({ owner: OWNER, tokens: 5_000_000, model: "claude-sonnet-4-6", ref: "burn" }); // 500 credits
  const before = await L.getBalance(OWNER);
  check("bundle balance is 1500 before rollover", near(before.bundle, 1500));
  const roll = await L.rolloverJob({ owner: OWNER, tier: "studio", endingCycle: "2026-06", nextCycle: "2026-07" });
  check(`carry capped at ${Math.round(cap)} (not the full 1500)`, near(roll.carried, cap, 0.01));
  check(`expired the remainder (${Math.round(1500 - cap)})`, near(roll.expired, 1500 - cap, 0.01));
  check(`bundle after grant == breakeven ${Math.round(be)} (never above)`, near(roll.bundleAfter, be, 0.01) && roll.bundleAfter <= be + 1e-6);
}

console.log("idempotency — redelivered grant + replayed turn don't double-write:");
{
  const L = newLedger();
  const g1 = await L.grant({ owner: OWNER, credits: 120, bucket: "bundle", ref: "invoice:abc" });
  const g2 = await L.grant({ owner: OWNER, credits: 120, bucket: "bundle", ref: "invoice:abc" }); // redelivery
  check("second identical grant is flagged idempotent", g1.idempotent === false && g2.idempotent === true);
  const d1 = await L.debit({ owner: OWNER, tokens: 100000, model: "claude-sonnet-4-6", ref: "turn-x", tier: null });
  const d2 = await L.debit({ owner: OWNER, tokens: 100000, model: "claude-sonnet-4-6", ref: "turn-x", tier: null }); // replay
  check("replayed turn is idempotent (no second debit)", d1.idempotent === false && d2.idempotent === true);
  const b = await L.getBalance(OWNER);
  check("balance reflects ONE grant and ONE debit only", near(b.bundle, 120 - 10));
}

console.log(`\n${fail === 0 ? "ALL GREEN" : "RED"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
