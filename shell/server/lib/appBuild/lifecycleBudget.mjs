// Aggregate lifecycle budget for Thrallo-MANAGED usage across a whole build lifecycle.
//
// The defect this closes: every dispatched job computed a fresh independent allowance
// (managedAffordableCreditLimit — build 60, iterate 40), so a three-job lifecycle could
// legitimately spend 60 + 40 + 40 with nothing tracking the total. The per-job ceiling is
// still enforced inside runJob as a runaway guard; this adds the missing cumulative one.
//
// Scope: the initial build, build-failure repairs, verification repairs, legitimate crash
// retries, and provider/model switches that keep using managed usage. BYOK usage is
// recorded for reporting but NEVER capped here — a BYOK user pays their own provider, so
// their optional limits live in byokSafety.mjs and are off unless they turn them on (§5).

import { optionalEnv } from "../env.mjs";

export const LIFECYCLE_MODES = Object.freeze(["build", "iterate"]);

// Defaults are deliberately below the naive sum of per-job caps: the lifecycle is a real
// ceiling, not a restatement of the old behaviour. Every value is env-overridable as
// THRALLO_LIFECYCLE_<FIELD>_<PLAN>_<MODE>.
const CREDIT_DEFAULTS = Object.freeze({
  free: { build: 90, iterate: 60 },
  starter: { build: 140, iterate: 90 },
  pro: { build: 220, iterate: 140 },
});

// Structural ceilings shared by every plan — they exist to stop loops, not to price work.
const JOB_DEFAULT = 3;          // the existing three-job ceiling: initial + at most 2 follow-ups
const TURN_DEFAULT = 75;        // 3 jobs x the engine's 25-turn cap
const ELAPSED_DEFAULT_MS = 45 * 60_000;

function envNumber(field, plan, mode) {
  const value = Number(optionalEnv(`THRALLO_LIFECYCLE_${field}_${plan}_${mode}`.toUpperCase(), ""));
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function lifecycleLimits({ plan = "free", mode = "build", redesign = false } = {}) {
  const planKey = CREDIT_DEFAULTS[plan] ? plan : "free";
  const modeKey = redesign ? "build" : (LIFECYCLE_MODES.includes(mode) ? mode : "build");
  return {
    plan: planKey,
    mode: modeKey,
    credits: envNumber("CREDITS", planKey, modeKey) ?? CREDIT_DEFAULTS[planKey][modeKey],
    jobs: envNumber("JOBS", planKey, modeKey) ?? JOB_DEFAULT,
    turns: envNumber("TURNS", planKey, modeKey) ?? TURN_DEFAULT,
    elapsedMs: envNumber("ELAPSED_MS", planKey, modeKey) ?? ELAPSED_DEFAULT_MS,
  };
}

const ZERO = Object.freeze({
  credits: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, reasoningTokens: 0,
  turns: 0, jobs: 0, repairRounds: 0, elapsedMs: 0,
});

// A lifecycle budget instance. `managed` false means BYOK: totals still accumulate (they
// feed Diagnostics and the optional BYOK controls) but no credit ceiling is applied.
export function createLifecycleBudget({ plan = "free", mode = "build", redesign = false, managed = true, startedAt = Date.now(), spentSupplier = null } = {}) {
  const limits = lifecycleLimits({ plan, mode, redesign });
  const totals = { ...ZERO };

  const elapsed = (now = Date.now()) => Math.max(0, now - startedAt);

  // CANONICAL SPEND (2026-08-05 billing incident). Credits are no longer an independently
  // accumulated running total — that accumulator is how one build simultaneously "cost" 19.25 in
  // every report and 51.33 at the ceiling. When a supplier is provided, credits are DERIVED from
  // the same per-event record every other surface reads (the diagnostics session's per-call
  // costModel totals, which back ai_requests). Without a supplier — pure-planner unit tests — the
  // local accumulator remains, and both paths use the same pricing function, so they cannot drift.
  const spentCredits = () => (spentSupplier ? Number(spentSupplier()) || 0 : totals.credits);

  return {
    limits,
    managed,
    get totals() { return { ...totals, credits: spentCredits(), elapsedMs: elapsed() }; },

    // Called once per dispatched job, before it runs.
    noteJob() { totals.jobs += 1; return totals.jobs; },
    noteRepair() { totals.repairRounds += 1; return totals.repairRounds; },

    // Called when a job ends, with whatever the pipeline actually measured. Token and turn
    // counters accumulate here; CREDITS deliberately do not when a canonical supplier exists.
    record({ usage = null, credits = 0, turns = 0 } = {}) {
      if (!spentSupplier) totals.credits += Number(credits) || 0;
      totals.inputTokens += Number(usage?.input || 0);
      totals.outputTokens += Number(usage?.output || 0);
      totals.cachedTokens += Number(usage?.cached || 0);
      totals.reasoningTokens += Number(usage?.reasoning || 0);
      totals.turns += Number(turns || usage?.turns || 0);
      return this.totals;
    },

    remaining() {
      return {
        credits: managed ? Math.max(0, limits.credits - spentCredits()) : Infinity,
        jobs: Math.max(0, limits.jobs - totals.jobs),
        turns: Math.max(0, limits.turns - totals.turns),
        elapsedMs: Math.max(0, limits.elapsedMs - elapsed()),
      };
    },

    // The gate every follow-up dispatch must pass. `estimatedCredits` is what the next job
    // could cost in the worst case; the caller supplies the per-job runaway cap.
    canDispatch({ estimatedCredits = 0 } = {}) {
      const left = this.remaining();
      if (left.jobs <= 0) {
        return { ok: false, reason: "jobs", remaining: left, limits };
      }
      if (left.elapsedMs <= 0) {
        return { ok: false, reason: "elapsed", remaining: left, limits };
      }
      if (left.turns <= 0) {
        return { ok: false, reason: "turns", remaining: left, limits };
      }
      if (managed && left.credits <= 0) {
        return { ok: false, reason: "credits", remaining: left, limits };
      }
      // A follow-up that cannot even fit its own minimum useful allowance is refused now
      // rather than started and killed mid-turn.
      if (managed && estimatedCredits > 0 && left.credits < Math.min(estimatedCredits, 1)) {
        return { ok: false, reason: "credits", remaining: left, limits };
      }
      return { ok: true, remaining: left, limits };
    },

    // The per-job cap handed to runJob: never more than what the lifecycle has left.
    jobAllowance(perJobCap) {
      if (!managed) return perJobCap;
      return Math.max(0, Math.min(Number(perJobCap) || 0, this.remaining().credits));
    },
  };
}

// Plain-English explanation of a refusal — no figures the user cannot act on, and never a
// raw provider or billing string.
export function budgetBlockedMessage(check, { alternatives = [] } = {}) {
  const base = {
    credits: "This build has used the managed-usage allowance set aside for one build lifecycle.",
    jobs: "This build has used all of its automatic attempts.",
    turns: "This build has used all of its automatic work allowance.",
    elapsed: "This build has been running long enough that I've paused it rather than keep spending.",
  }[check?.reason] || "This build has reached its safe automatic limit.";
  const options = ["Your current progress is saved and nothing was lost."];
  if (alternatives.length) {
    options.push(`I can continue on ${alternatives.map((a) => a.label || a).join(" or ")} if you'd like to switch.`);
  }
  options.push("You can top up your managed usage, connect your own API key to keep going on your account, or stop here and keep the current version.");
  return `${base} ${options.join(" ")}`;
}
