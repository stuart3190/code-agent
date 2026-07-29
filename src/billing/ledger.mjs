// Phase 4 (LIVE) — the credit ledger SDK over Supabase.
//
// APPEND-ONLY by construction: balance is NEVER stored, it is Σ delta (see getBalance). Every grant,
// debit, top-up and expiry is one immutable row; corrections would be new refund/adjust rows. The SQL
// schema (migrations/credit_ledger.sql) grants no update/delete policy, so the table CAN'T be mutated.
//
// SINGLE SOURCE OF TRUTH: every credit amount, model weight, rollover cap and ceiling comes from
// src/billing/costModel.mjs. This module NEVER re-derives a price or a weight — it imports the math.
//
// CLIENT ROLES (the caller decides which Supabase client to hand in):
//   * end-user ANON session   -> getBalance proves RLS read-scoping (a user reads only their own rows)
//   * platform SERVICE_ROLE   -> grant / debit / rollover / setEntitlement (server-side writes that
//     bypass RLS, because webhooks and the engine act on behalf of any user)
// The factory is pure (createLedger(client)); both call sites use the identical code path.

import {
  creditsForTurn,
  creditsForUsage,
  modelWeight,
  bundleRolloverCapCredits,
  userHardCeilCredits,
  TIERS,
} from "./costModel.mjs";

const tierById = (id) => TIERS.find((t) => t.id === id) || null;

// First instant of the current UTC month, ISO — the window the per-tier hard ceiling sums debits over.
function monthStartISO(d = new Date()) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
}

// Round credit amounts to the ledger's numeric(14,4) scale so float dust never accumulates.
const r4 = (n) => Math.round(n * 1e4) / 1e4;
// FLOOR to 4 dp — used for the rollover carry, where rounding UP could nudge carry past the cap and
// (carry + next grant) a hair over breakeven. Flooring keeps carried ≤ cap by construction.
const floor4 = (n) => Math.floor(n * 1e4) / 1e4;

export function createLedger(client) {
  if (!client) throw new Error("createLedger(client): a Supabase client is required.");
  const table = () => client.from("credit_ledger");

  const unwrap = ({ data, error }) => {
    if (error) throw error;
    return data;
  };
  // A unique-index violation (idempotent re-write) is code 23505 — surface it as a sentinel, not a throw.
  const isDup = (error) => error && (error.code === "23505" || /duplicate key/i.test(error.message || ""));

  // ── balances (computed, never stored) ────────────────────────────────────────────────────────
  async function getBalance(owner) {
    const rows = unwrap(await table().select("delta,bucket").eq("owner", owner));
    let bundle = 0,
      topup = 0;
    for (const row of rows) {
      const d = Number(row.delta);
      if (row.bucket === "bundle") bundle += d;
      else if (row.bucket === "topup") topup += d;
    }
    bundle = r4(bundle);
    topup = r4(topup);
    return { bundle, topup, total: r4(bundle + topup) };
  }

  // Σ of DEBITED credits this UTC month (magnitude) — the input to the per-tier hard-ceiling check.
  async function monthlyDebitedCredits(owner, since = monthStartISO()) {
    const rows = unwrap(
      await table().select("delta").eq("owner", owner).eq("kind", "debit").gte("ts", since)
    );
    return r4(rows.reduce((s, row) => s + -Number(row.delta), 0));
  }

  // ── entitlement (customers table) ────────────────────────────────────────────────────────────
  async function getEntitlement(owner) {
    const { data, error } = await client
      .from("customers")
      .select("owner,stripe_customer_id,tier,current_period")
      .eq("owner", owner)
      .maybeSingle();
    if (error) throw error;
    return data || null;
  }

  // Upsert the Stripe<->user mapping + current tier. Service-role only (no end-user write policy).
  async function setEntitlement({ owner, tier = null, stripeCustomerId = null, currentPeriod = null }) {
    const patch = { owner, updated_at: new Date().toISOString() };
    if (tier !== undefined) patch.tier = tier;
    if (stripeCustomerId != null) patch.stripe_customer_id = stripeCustomerId;
    if (currentPeriod != null) patch.current_period = currentPeriod;
    const rows = unwrap(await client.from("customers").upsert(patch, { onConflict: "owner" }).select());
    return rows[0];
  }

  async function ownerForStripeCustomer(stripeCustomerId) {
    const { data, error } = await client
      .from("customers")
      .select("owner")
      .eq("stripe_customer_id", stripeCustomerId)
      .maybeSingle();
    if (error) throw error;
    return data?.owner ?? null;
  }

  // ── grant (bundle renewal / top-up purchase) ─────────────────────────────────────────────────
  // Idempotent on (owner, ref, kind, bucket): re-delivering the same Stripe event no-ops at the DB.
  async function grant({ owner, credits, bucket, ref, kind = "grant", cycle = null }) {
    if (!owner || !ref) throw new Error("grant: owner and ref are required.");
    if (!(credits > 0)) throw new Error(`grant: credits must be > 0 (got ${credits}).`);
    if (bucket !== "bundle" && bucket !== "topup") throw new Error(`grant: bad bucket ${bucket}.`);
    const row = { owner, delta: r4(credits), bucket, kind, cycle, ref };
    const { data, error } = await table().insert(row).select();
    if (error) {
      if (isDup(error)) return { ok: true, idempotent: true, credits: r4(credits), bucket, ref };
      throw error;
    }
    return { ok: true, idempotent: false, credits: r4(credits), bucket, ref, id: data[0].id };
  }

  // ── debit (a generation turn) ────────────────────────────────────────────────────────────────
  // need = creditsForTurn({tokens, model})  (model-WEIGHTED, from costModel — never re-derived here).
  // Guards, in order:
  //   1. pre-turn BALANCE check — refuse if total balance < need.
  //   2. per-tier HARD CEILING — refuse if this month's debits + need would exceed the user's tier
  //      breakeven (userHardCeilCredits). Tier resolved from the entitlement row unless passed in.
  // Then BUNDLE-FIRST split: spend resetting bundle credits before rolling top-up credits, writing one
  // row per bucket so every row stays single-bucket. Idempotent on the turn `ref`.
  async function debit({ owner, tokens, usage = null, model, ref, tier = undefined, allowPartial = false }) {
    if (!owner || !ref) throw new Error("debit: owner and ref are required.");
    const rawTokens = Number(usage?.total ?? tokens ?? 0);
    const need = r4(usage
      ? creditsForUsage({ usage, model })
      : creditsForTurn({ tokens: rawTokens, model }));
    const weight = modelWeight(model);

    // Idempotency: if this turn already debited, return the prior result unchanged.
    const existing = unwrap(await table().select("delta,bucket").eq("owner", owner).eq("ref", ref).eq("kind", "debit"));
    if (existing.length) {
      const debited = r4(existing.reduce((s, row) => s + -Number(row.delta), 0));
      return {
        ok: true, idempotent: true, need, debited,
        partial: debited + 1e-9 < need, shortfall: r4(Math.max(0, need - debited)), model, weight,
      };
    }

    const bal = await getBalance(owner);

    // Resolve the tier for the ceiling (entitlement row -> TIERS object) unless the caller passed one.
    let tierObj = tier;
    if (tierObj === undefined) {
      const ent = await getEntitlement(owner);
      tierObj = ent?.tier ? tierById(ent.tier) : null;
    }
    const ceil = userHardCeilCredits(tierObj || undefined);

    // Guard 1: balance. Product callers may opt into a final-job grace debit: consume the
    // remaining prepaid balance down to zero when exact post-metered usage is higher, then the
    // normal route gate blocks every subsequent managed job. Never create a negative balance.
    if (!allowPartial && bal.total + 1e-9 < need) {
      return { ok: false, reason: "insufficient_balance", need, balance: bal, model, weight };
    }
    const debited = allowPartial ? r4(Math.min(need, Math.max(0, bal.total))) : need;
    if (!(debited > 0)) {
      return { ok: false, reason: "insufficient_balance", need, balance: bal, model, weight };
    }
    // Guard 2: per-tier hard ceiling (skipped when ceil is Infinity, e.g. BYOK / no entitlement).
    if (Number.isFinite(ceil)) {
      const spent = await monthlyDebitedCredits(owner);
      if (spent + debited > ceil + 1e-9) {
        return { ok: false, reason: "hard_ceiling", need, debited, spentThisMonth: spent, ceiling: ceil, tier: tierObj?.id ?? null, model, weight };
      }
    }

    // Bundle-first split.
    const fromBundle = r4(Math.min(debited, Math.max(0, bal.bundle)));
    const fromTopup = r4(debited - fromBundle);

    const rows = [];
    if (fromBundle > 0)
      rows.push({ owner, delta: r4(-fromBundle), bucket: "bundle", kind: "debit", model, tokens: rawTokens, weight: r4(weight), ref });
    if (fromTopup > 0)
      rows.push({ owner, delta: r4(-fromTopup), bucket: "topup", kind: "debit", model, tokens: rawTokens, weight: r4(weight), ref });
    if (!rows.length) return { ok: true, need: 0, debited: 0, fromBundle: 0, fromTopup: 0, model, weight };

    const { error } = await table().insert(rows);
    if (error) {
      if (isDup(error)) {
        // Concurrent retry landed first — report it as idempotent rather than erroring.
        const after = unwrap(await table().select("delta").eq("owner", owner).eq("ref", ref).eq("kind", "debit"));
        return { ok: true, idempotent: true, need, debited: r4(after.reduce((s, row) => s + -Number(row.delta), 0)), model, weight };
      }
      throw error;
    }
    return {
      ok: true, idempotent: false, need, debited, fromBundle, fromTopup,
      partial: debited + 1e-9 < need, shortfall: r4(Math.max(0, need - debited)), model, weight, ref,
    };
  }

  // ── monthly rollover / expiry job ────────────────────────────────────────────────────────────
  // Bundle resets each cycle. Carry up to bundleRolloverCapCredits(tier) (= breakeven − bundle, from
  // costModel) into the next cycle; EXPIRE the remainder; then GRANT the next cycle's bundle. The cap
  // guarantees carry + next grant ≤ breakeven, so a rollover-banking user can never go underwater on
  // bundled credits. Top-up never expires (untouched here). Idempotent per (owner, cycle).
  async function rolloverJob({ owner, tier, endingCycle, nextCycle }) {
    const tierObj = typeof tier === "string" ? tierById(tier) : tier;
    if (!tierObj?.managed) throw new Error(`rolloverJob: managed tier required (got ${tier}).`);
    const cap = bundleRolloverCapCredits(tierObj);

    const bal = await getBalance(owner);
    const carry = floor4(Math.min(Math.max(0, bal.bundle), cap)); // floor: carried ≤ cap, never above
    const expired = r4(Math.max(0, bal.bundle - carry));

    if (expired > 0) {
      const { error } = await table().insert({
        owner, delta: r4(-expired), bucket: "bundle", kind: "expire", cycle: endingCycle,
        ref: `expire:${owner}:${endingCycle}`,
      });
      if (error && !isDup(error)) throw error;
    }

    const granted = await grant({
      owner, credits: tierObj.bundledCredits, bucket: "bundle", kind: "grant",
      cycle: nextCycle, ref: `grant:${owner}:${nextCycle}`,
    });

    const after = await getBalance(owner);
    return { tier: tierObj.id, cap, carried: carry, expired, granted: tierObj.bundledCredits, grantIdempotent: granted.idempotent, bundleAfter: after.bundle };
  }

  return {
    getBalance,
    monthlyDebitedCredits,
    getEntitlement,
    setEntitlement,
    ownerForStripeCustomer,
    grant,
    debit,
    rolloverJob,
    _client: client,
  };
}
