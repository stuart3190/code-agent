// How expensive is this build allowed to be, and where did the money actually go?
//
// The 62-credit booking site was not expensive because of staged generation — the four stages cost
// about 11 credits between them. It was expensive because three verification repair rounds cost
// 28.84, 20.42 and 7.43, at input-to-output ratios of 17:1. The repairs re-sent the entire project
// on every turn of every round.
//
// So this module does two things: it decides how much machinery a build actually needs, and it
// records where every credit went so the next person does not have to reconstruct it from SQL.

// ── complexity ────────────────────────────────────────────────────────────────────────────────
//
// Not every app needs every check. A landing page has no persistence to verify and no journeys
// worth driving twice; running the heavyweight path over it spends real money proving nothing.
// A Roblox generator or a visual editor genuinely does.

export const COMPLEXITY = Object.freeze({ simple: "simple", medium: "medium", advanced: "advanced" });

const ADVANCED_SIGNALS = [
  /\bide\b|code editor|monaco|codemirror/i,
  /roblox|luau|unity|unreal|game engine/i,
  /visual editor|drag[- ]and[- ]drop builder|canvas editor|node graph|flow editor/i,
  /\bcad\b|3d model|three\.?js|webgl|blender/i,
  // "an AI writing assistant" has a word between the two. An earlier version required them
  // adjacent and classified it as simple — the most expensive kind of misclassification.
  /\bai\b[\w\s-]{0,20}\b(tool|assistant|agent|generator|writer|chatbot|copilot)\b|llm|prompt engineering|fine[- ]tun/i,
  /compiler|interpreter|transpiler|parser generator/i,
  /real[- ]?time collaborat|operational transform|crdt/i,
];

const MEDIUM_SIGNALS = [
  /dashboard|analytics|reporting|admin (panel|system|console)/i,
  /\bsaas\b|subscription|multi[- ]tenant|billing|stripe/i,
  /e-?commerce|storefront|shopping cart|checkout|inventory/i,
  /workflow|pipeline|automation|scheduler/i,
  /\bcrm\b|\berp\b|help ?desk|ticketing/i,
];

const SIMPLE_SIGNALS = [
  /landing page|one[- ]pager|coming soon/i,
  /contact form|enquiry form|sign[- ]up form/i,
  /booking|reservation|appointment|scheduling site/i,
  /portfolio|résumé|resume|personal site|blog/i,
  /\bcrud\b|to-?do|task list|notes app/i,
];

/**
 * Classify a build from the request and the contract.
 *
 * The contract is the better evidence when it exists — journeys and entities describe what the
 * thing DOES, where the request describes what someone hoped for. Both are used; the contract wins
 * a disagreement.
 */
export function classifyComplexity({ prompt = "", contract = null } = {}) {
  const text = `${prompt} ${contract?.summary || ""} ${(contract?.journeys || []).map((j) => j.title).join(" ")}`;
  const reasons = [];

  for (const signal of ADVANCED_SIGNALS) {
    if (signal.test(text)) { reasons.push(`matches an advanced pattern (${signal.source.slice(0, 40)})`); return { level: COMPLEXITY.advanced, reasons }; }
  }

  // Structural evidence: a lot of moving parts is medium regardless of what it is called.
  const journeys = (contract?.journeys || []).length;
  const entities = (contract?.entities || []).length;
  const routes = (contract?.routes || []).length;
  if (journeys > 6 || entities > 3 || routes > 8) {
    reasons.push(`${journeys} journeys, ${entities} entities, ${routes} routes`);
    return { level: COMPLEXITY.medium, reasons };
  }

  for (const signal of MEDIUM_SIGNALS) {
    if (signal.test(text)) { reasons.push("matches a medium pattern"); return { level: COMPLEXITY.medium, reasons }; }
  }
  for (const signal of SIMPLE_SIGNALS) {
    if (signal.test(text)) { reasons.push("matches a simple pattern"); return { level: COMPLEXITY.simple, reasons }; }
  }

  // Unrecognised, and small. Simple is the right default: the checks a simple build skips are the
  // ones that cost the most and prove the least on a small app, and anything that fails still gets
  // caught by the gate.
  reasons.push("no strong signal; sized as simple");
  return { level: COMPLEXITY.simple, reasons };
}

/**
 * The budget and the machinery for each level.
 *
 * `maxRepairTurns` is the important one. The 28-credit repair round was a single dispatch that ran
 * many turns, each re-sending the project; capping turns caps the quadratic.
 */
export const PROFILES = Object.freeze({
  [COMPLEXITY.simple]: {
    maxCredits: 12,
    maxRepairCredits: 4,
    maxAiCalls: 8,
    maxDurationMs: 8 * 60_000,
    maxRepairTurns: 6,
    // A simple app's foundation and journey are the same work; splitting them buys nothing and
    // costs a model call plus a compile.
    mergeStages: true,
    // The generic signup/login probe. Meaningless on a site with no accounts, and it was the
    // check that failed three times on the booking site and drove every repair round.
    genericAuthProbe: false,
  },
  [COMPLEXITY.medium]: {
    maxCredits: 30,
    maxRepairCredits: 10,
    maxAiCalls: 14,
    maxDurationMs: 15 * 60_000,
    maxRepairTurns: 8,
    mergeStages: false,
    genericAuthProbe: true,
  },
  [COMPLEXITY.advanced]: {
    maxCredits: 60,
    maxRepairCredits: 20,
    maxAiCalls: 24,
    maxDurationMs: 30 * 60_000,
    maxRepairTurns: 12,
    mergeStages: false,
    genericAuthProbe: true,
  },
});

export function profileFor(level) {
  return PROFILES[level] || PROFILES[COMPLEXITY.simple];
}

// ── profiling ─────────────────────────────────────────────────────────────────────────────────

/**
 * Record where the time and the credits went.
 *
 * Deliberately a running record rather than a post-hoc query: the numbers that mattered most (the
 * input-to-output ratio on repairs) were invisible in the totals and only showed up when the
 * per-step token counts were compared side by side.
 */
export function createProfiler({ level = COMPLEXITY.simple, now = () => Date.now() } = {}) {
  const started = now();
  const entries = [];
  const counters = { aiCalls: 0, deterministicChecks: 0, repairRounds: 0, cacheHits: 0, cacheMisses: 0 };

  return {
    level,
    counters,

    /** One AI call. `usage` is the engine's telemetry. */
    ai(label, { credits = 0, usage = null, durationMs = 0, phase = "build" } = {}) {
      counters.aiCalls += 1;
      const input = Number(usage?.input || 0);
      const output = Number(usage?.output || 0);
      entries.push({
        kind: "ai", label, phase, credits: Number(credits) || 0, durationMs,
        input, output,
        // The ratio that exposed the real problem: 17:1 means the call is paying to re-read
        // context, not to produce work.
        ratio: output ? Number((input / output).toFixed(1)) : null,
      });
    },

    /** A check that cost no credits. Counted so "deterministic first" is measurable, not asserted. */
    deterministic(label, { durationMs = 0, phase = "verify" } = {}) {
      counters.deterministicChecks += 1;
      entries.push({ kind: "deterministic", label, phase, credits: 0, durationMs });
    },

    cache(label, hit) {
      counters[hit ? "cacheHits" : "cacheMisses"] += 1;
      entries.push({ kind: "cache", label, hit, credits: 0, durationMs: 0 });
    },

    repairRound() { counters.repairRounds += 1; },

    get credits() { return entries.reduce((total, e) => total + (e.credits || 0), 0); },
    get elapsedMs() { return now() - started; },

    /** Everything a report needs, with the biggest spender first. */
    summary() {
      const byLabel = new Map();
      for (const entry of entries) {
        if (entry.kind !== "ai") continue;
        const current = byLabel.get(entry.label) || { label: entry.label, credits: 0, calls: 0, input: 0, output: 0, durationMs: 0 };
        current.credits += entry.credits;
        current.calls += 1;
        current.input += entry.input;
        current.output += entry.output;
        current.durationMs += entry.durationMs;
        byLabel.set(entry.label, current);
      }
      return {
        level,
        credits: Number(this.credits.toFixed(2)),
        elapsedMs: this.elapsedMs,
        ...counters,
        hotspots: [...byLabel.values()].sort((a, b) => b.credits - a.credits).map((h) => ({
          ...h,
          credits: Number(h.credits.toFixed(2)),
          ratio: h.output ? Number((h.input / h.output).toFixed(1)) : null,
        })),
        entries,
      };
    },

    /** A text flame graph — proportional, readable in a log, no tooling required. */
    flame(width = 46) {
      const summary = this.summary();
      const total = summary.credits || 1;
      const lines = [
        `BUILD PROFILE — ${level} · ${summary.credits} credits · ${(summary.elapsedMs / 60_000).toFixed(1)} min`,
        `${summary.aiCalls} AI calls · ${summary.deterministicChecks} deterministic checks · `
          + `${summary.repairRounds} repair rounds · ${summary.cacheHits} cache hits`,
        "",
      ];
      for (const hot of summary.hotspots) {
        const bar = "█".repeat(Math.max(1, Math.round((hot.credits / total) * width)));
        lines.push(
          `  ${hot.label.padEnd(26).slice(0, 26)} ${String(hot.credits).padStart(6)} cr  ${bar}`
          + `${hot.ratio && hot.ratio > 12 ? `  ← ${hot.ratio}:1 in/out` : ""}`,
        );
      }
      return lines.join("\n");
    },
  };
}

// ── budget enforcement ────────────────────────────────────────────────────────────────────────

/**
 * Has this build spent what it is allowed to?
 *
 * Returns the reason when it has, so the customer can be told what specifically ran out rather
 * than "the limit was reached".
 */
export function budgetVerdict(profiler, profile, { repairCredits = 0 } = {}) {
  if (profiler.credits >= profile.maxCredits) {
    return { ok: false, reason: "credits", detail: `this build reached its ${profile.maxCredits}-credit limit` };
  }
  if (repairCredits >= profile.maxRepairCredits) {
    return { ok: false, reason: "repair_credits", detail: `repairs reached their ${profile.maxRepairCredits}-credit limit` };
  }
  if (profiler.counters.aiCalls >= profile.maxAiCalls) {
    return { ok: false, reason: "ai_calls", detail: `this build reached its ${profile.maxAiCalls}-call limit` };
  }
  if (profiler.elapsedMs >= profile.maxDurationMs) {
    return { ok: false, reason: "duration", detail: `this build reached its ${Math.round(profile.maxDurationMs / 60_000)}-minute limit` };
  }
  return { ok: true };
}
