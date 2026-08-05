// The two remaining defects of the 46.10-credit run (178f7fc8 / build 30782000), fixed and pinned:
//
//   CEILING — one staged Codex job reached 46.10 against a 25-credit build ceiling, because the
//   ceiling was consulted only between dispatches and the per-turn guard was armed for managed
//   lanes only. The guard now runs on EVERY lane, per turn, with a pre-emptive floor: no provider
//   call starts that cannot possibly fit.
//
//   TRANSITIONS — the builder answered a keyword list with static copy; the verifier's freshness
//   rule correctly failed five journeys. The rule is now a pure exported function, proven here,
//   and the stage prompts teach the transition it tests.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { managedUsageGuard } from "../../shell/server/lib/buildJobs.mjs";
import { byokJobCeiling } from "../../shell/server/lib/appBuild/appBuildService.mjs";
import { expectationOutcome, expectationKeywords } from "../../shell/server/lib/appBuild/journeyVerifier.mjs";
import { planStages, stagePrompt } from "../../shell/server/lib/appBuild/stagePlan.mjs";
import { buildStageContext } from "../../shell/server/lib/appBuild/contextBuilder.mjs";
import { buildManifest } from "../../shell/server/lib/appBuild/projectManifest.mjs";
import { runAgent } from "../../src/engine/runAgent.mjs";
import { creditsForUsage } from "../../src/billing/costModel.mjs";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "cf130c23");
const CONTRACT = JSON.parse(readFileSync(path.join(FIXTURES, "contract.json"), "utf8"));
const MODEL = "gpt-5.5";

// ── the ceiling, inside the job ───────────────────────────────────────────────────────────────

function bigTurnProvider(calls) {
  // Every turn: 60k fresh input, 2k output, and a patch — about 6.2 credits on gpt-5.5.
  return {
    model: MODEL,
    runTurn: async () => {
      calls.count += 1;
      return {
        text: "",
        toolCalls: [{ id: `t${calls.count}`, name: "write_file", rawArguments: "{}", arguments: { path: `src/f${calls.count}.js`, contents: "export const x = 1;" } }],
        usage: { input: 60_000, output: 2_000, reasoning: 0, cached: 0, total: 62_000 },
      };
    },
  };
}

test("CEILING — a 25-credit job stops before the call that cannot fit, and cannot cross 25", async () => {
  const calls = { count: 0 };
  const tree = {};
  const tracked = { rows: [], add(u) { this.rows.push(u); }, summary() {
    return this.rows.reduce((a, u) => ({ input: a.input + u.input, output: a.output + u.output, cached: a.cached + u.cached, reasoning: 0, total: a.total + u.total }), { input: 0, output: 0, cached: 0, reasoning: 0, total: 0 });
  } };
  const guard = managedUsageGuard(25, MODEL, tracked);

  await assert.rejects(
    runAgent({
      provider: bigTurnProvider(calls), systemPrompt: "s", tools: [],
      toolImpls: { write_file: ({ path: p, contents }) => { tree[p] = contents; return { bytes: contents.length, created: true }; } },
      tree, prompt: "p", maxTurns: 25, log: () => {}, onUsage: guard,
    }),
    (error) => error.name === "ManagedCreditBudgetError",
  );

  const spent = creditsForUsage({ usage: tracked.summary(), model: MODEL });
  const perTurn = creditsForUsage({ usage: { input: 60_000, cached: 0, output: 2_000 }, model: MODEL });
  const minNext = creditsForUsage({ usage: { input: 60_000, cached: 60_000, output: 0 }, model: MODEL });
  // The invariant, not a hardcoded count: the job NEVER crosses the ceiling, and it stopped at
  // exactly the first turn after which even the cheapest possible next call could not fit.
  assert.ok(spent <= 25 + 1e-9, `metered spend ${spent.toFixed(2)} must never cross the ceiling`);
  assert.ok(spent + minNext > 25, "the stop fired precisely when the floor no longer fit");
  assert.equal(calls.count, Math.floor(spent / perTurn + 0.5), "no provider call after the stop");
  assert.ok(calls.count < 25, "stopped well before maxTurns");
  // The paid work of the final completed turn was APPLIED before the abort, and its usage kept.
  assert.equal(Object.keys(tree).length, calls.count, "every paid turn's writes survive");
  assert.equal(tracked.rows.length, calls.count, "metered usage for completed turns is retained");
});

test("CEILING — every lane derives the same in-job cap; Codex gets it net of lifecycle spend", () => {
  const lifecycle = (over) => ({
    managed: false, byokSafety: { maxCostPerBuild: null }, costCeiling: 25,
    budget: { totals: { credits: 0 } }, ...over,
  });
  assert.equal(byokJobCeiling(lifecycle()), 25, "codex/BYOK carries the build ceiling into the job");
  assert.equal(byokJobCeiling(lifecycle({ budget: { totals: { credits: 20.5 } } })), 4.5, "net of what the lifecycle already spent");
  assert.equal(byokJobCeiling(lifecycle({ byokSafety: { maxCostPerBuild: 3 } })), 3, "the user's own tighter cap wins");
  assert.equal(byokJobCeiling(lifecycle({ costCeiling: null })), null, "no ceiling configured → no cap invented");
  assert.equal(byokJobCeiling({ managed: true }), null, "managed lanes keep their own allowance guard");

  // Source pins: the BYOK/Codex lane arms the SAME guard, and dispatches carry the derived cap.
  const jobs = readFileSync("shell/server/lib/buildJobs.mjs", "utf8");
  assert.match(jobs, /byok\s*\?\s*\(job\.byokCostLimit \? managedUsageGuard\(Number\(job\.byokCostLimit\)/);
  const service = readFileSync("shell/server/lib/appBuild/appBuildService.mjs", "utf8");
  assert.equal((service.match(/byokCostLimit: byokJobCeiling\(lifecycle\)/g) || []).length, 5,
    "every dispatch site derives the in-job cap; none hands the raw per-build setting");
  // And no managed reservation machinery is touched by any of it: the guard throws, nothing else.
  assert.ok(!/reservations/.test(jobs.slice(jobs.indexOf("export function managedUsageGuard"), jobs.indexOf("export function managedUsageGuard") + 900)));
});

// ── the freshness rule, pure ──────────────────────────────────────────────────────────────────

test("TRANSITIONS — static pre-existing copy does not satisfy an expectation; caused change does", () => {
  const wanted = expectationKeywords("a confirmation with a booking reference is shown");
  assert.ok(wanted.includes("confirmation") && wanted.includes("reference"));

  // The 46.10-credit failure mode: every wanted word visible, NONE of it new. Fails.
  const staticCopy = expectationOutcome({ wanted, found: [...wanted], fresh: [], drove: true, action: "submit the booking form" });
  assert.equal(staticCopy.status, "fail");
  assert.match(staticCopy.detail, /nothing changed/);

  // The same words appearing AS A RESULT of the action. Passes.
  const caused = expectationOutcome({ wanted, found: [...wanted], fresh: ["confirmation"], drove: true, action: "submit the booking form" });
  assert.equal(caused.status, "pass");

  // Navigation is exempt — the whole page is new by definition.
  const nav = expectationOutcome({ wanted: ["booking", "manage"], found: ["booking", "manage"], fresh: [], drove: true, action: "open the booking management area" });
  assert.equal(nav.status, "pass");
});

test("TRANSITIONS — selection, confirmation, cancellation and mobile navigation are all taught as transitions", () => {
  const stages = planStages(CONTRACT, { includePolish: false });
  const prompts = stages.map((s) => stagePrompt(s, CONTRACT, { request: "booking site" })).join("\n\n");

  const cases = [
    CONTRACT.journeys.find((j) => j.id === "reserve-picking-slot").steps.find((s) => /choose an available date/.test(s.action)),
    CONTRACT.journeys.find((j) => j.id === "reserve-picking-slot").steps.find((s) => /timed slot/.test(s.action)),
    CONTRACT.journeys.find((j) => j.id === "manage-reservation").steps.find((s) => /cancel option/.test(s.action)),
    CONTRACT.journeys.find((j) => j.id === "use-responsive-navigation").steps.find((s) => /open the mobile menu/.test(s.action)),
  ].filter(Boolean);
  assert.ok(cases.length >= 4, "all four transition cases exist in the stored contract");

  for (const step of cases) {
    const wanted = expectationKeywords(step.expect);
    assert.ok(prompts.includes(`before: ${wanted.join(", ")} absent (or in their pre-action state) · after: they newly appear or visibly change`),
      `transition contract present for: ${step.action}`);
  }
  // The general rule is stated where every stage reads it.
  assert.match(prompts, /snapshots the page BEFORE each action/);
  assert.match(prompts, /closed first, open after the trigger/);
});

// ── context budgets stay hard with slicing in play ────────────────────────────────────────────

test("SLICING — the budget binds: what cannot fit as a slice becomes a summary, never an overflow", () => {
  // Blocks big enough (>15 lines) that only keyword-relevant ones survive slicing — and a
  // budget too small even for the signature-only slice.
  const filler = "\n  // padding line".repeat(20);
  const big = Array.from({ length: 120 }, (_, i) => `export function ZonePanel${i}() {${filler}\n  return ${i};\n}`).join("\n");
  const smallContract = { entities: [{ name: "booking" }], journeys: [] };
  const tree = {
    "package.json": "{}",
    "src/App.jsx": big,
    "src/data/booking.js": "export const b = 1;",
  };
  const manifest = buildManifest(tree, { contract: smallContract });
  // Measure the fixed floor (system/objective/contract/manifest), then grant just enough budget
  // above it for a summary but nowhere near enough for the signature-only slice (~1.8k tokens).
  const probe = buildStageContext({
    tree, manifest, stageId: "data", contract: smallContract,
    priorFiles: ["src/App.jsx"], budgetTokens: 100_000,
  });
  const floor = probe.breakdown.system + probe.breakdown.objective + probe.breakdown.contract + probe.breakdown.manifest;
  const context = buildStageContext({
    tree, manifest, stageId: "data", contract: smallContract,
    priorFiles: ["src/App.jsx"], budgetTokens: floor + 150,
  });
  // The budget is hard for BODIES: no full file and no slice is admitted past it. The demoted
  // file falls back to a BOUNDED summary (exports capped), never to its content.
  assert.ok(!context.slices.some((s) => s.path === "src/App.jsx"), "no room even for the slice");
  const demoted = context.summaries.find((s) => s.path === "src/App.jsx");
  assert.ok(demoted, "demoted to a summary instead");
  assert.ok(floor + context.breakdown.fullFiles + context.breakdown.sliced <= context.budget,
    `bodies fit the budget: ${floor} + ${context.breakdown.fullFiles} + ${context.breakdown.sliced} <= ${context.budget}`);
  assert.ok(context.breakdown.summaries < 200, `the fallback itself is bounded (${context.breakdown.summaries} tok)`);
});
