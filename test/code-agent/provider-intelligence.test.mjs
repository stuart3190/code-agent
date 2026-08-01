// Provider Intelligence: Auto learns from measured production evidence, explains itself
// with real numbers, stays deterministic and auditable, and NEVER invents statistics.

process.env.CODE_AGENT_STORE = "memory";

import assert from "node:assert/strict";
import test from "node:test";

import {
  collectEvidence, buildScorecards, rankCandidates, explainChoice, recommendModel,
  providerIntelligenceSnapshot, confidenceFor, MIN_SAMPLES, WEIGHTS, taskFamilyFor,
} from "../../shell/server/lib/providerIntelligence.mjs";
import { applyIntelligence, routeCandidates } from "../../shell/server/lib/modelRouting.mjs";
import { autoStrategy } from "../../shell/server/lib/modelSelector.mjs";

// A synthetic-but-realistic evidence set: Grok verifies as well as OpenAI at lower cost;
// OpenAI is faster on edits. Shapes match what the pipeline actually records.
function evidenceRows({ grokCost = 0.6, grokVerified = true } = {}) {
  const rows = [];
  const add = (n, spec) => { for (let i = 0; i < n; i += 1) rows.push({ ...spec, buildId: `${spec.model}-${spec.task}-${i}` }); };
  add(20, { provider: "openai", model: "gpt-5.6-terra", mode: "balanced", task: "full_build", owner: "o1", cost: 1.0, inputTokens: 10_000, cachedTokens: 2_000, requestMs: 8_000, verified: true, cancelled: false, buildMs: 60_000, repairRounds: 0, retries: 0 });
  add(20, { provider: "xai", model: "grok-4.5", mode: "balanced", task: "full_build", owner: "o2", cost: grokCost, inputTokens: 10_000, cachedTokens: 4_000, requestMs: 7_000, verified: grokVerified, cancelled: false, buildMs: 62_000, repairRounds: 0, retries: 0 });
  // Edits: OpenAI markedly faster, same verification.
  add(12, { provider: "openai", model: "gpt-5.6-terra", mode: "fast", task: "quick_edit", owner: "o1", cost: 0.3, inputTokens: 3_000, cachedTokens: 1_000, requestMs: 2_000, verified: true, cancelled: false, buildMs: 20_000, repairRounds: 0, retries: 0 });
  add(12, { provider: "xai", model: "grok-4.5", mode: "fast", task: "quick_edit", owner: "o2", cost: 0.3, inputTokens: 3_000, cachedTokens: 1_000, requestMs: 3_000, verified: true, cancelled: false, buildMs: 40_000, repairRounds: 0, retries: 0 });
  return rows;
}

test("confidence bands follow sample size and the floor is honoured", () => {
  assert.equal(confidenceFor(2), null, `below ${MIN_SAMPLES} samples -> no confidence claim`);
  assert.equal(confidenceFor(MIN_SAMPLES), "Low");
  assert.equal(confidenceFor(20), "Medium");
  assert.equal(confidenceFor(60), "High");
  assert.equal(taskFamilyFor("quick_edit"), "quick_edit");
  assert.equal(taskFamilyFor("something-new"), "other");
});

test("scorecards compute cost per VERIFIED build, cache efficiency and repair rates", () => {
  const cards = buildScorecards(evidenceRows());
  const grok = cards.byModel.find((m) => m.key === "grok-4.5");
  assert.equal(grok.verificationRate, 100);
  assert.equal(grok.confidence, "Medium");
  assert.ok(grok.costPerVerifiedBuild > 0);
  // 20 builds @ 4k/10k cached + 12 edits @ 1k/3k cached = 92k of 236k input tokens.
  assert.equal(grok.cacheEfficiency, Number(((92_000 / 236_000) * 100).toFixed(1)), "cache efficiency measured, not assumed");
  // Verification failures drag the rate down and, with none passing in a task family,
  // there is no cost-per-verified figure to report at all.
  const failing = buildScorecards(evidenceRows({ grokVerified: false }));
  const grokOverall = failing.byModel.find((m) => m.key === "grok-4.5");
  assert.equal(grokOverall.verificationRate, 37.5, "12 of 32 builds still verified");
  const grokBuilds = failing.byModelTask.find((m) => m.key === "grok-4.5|full_build");
  assert.equal(grokBuilds.verificationRate, 0);
  assert.equal(grokBuilds.costPerVerifiedBuild, null, "no verified builds -> no cost-per-verified claim");
});

test("insufficient evidence yields no ranking and the honest 'Collecting benchmark data.' line", () => {
  const thin = buildScorecards([
    { provider: "xai", model: "grok-4.5", mode: "balanced", task: "full_build", owner: "o1", cost: 0.5, inputTokens: 100, cachedTokens: 0, requestMs: 100, verified: true, cancelled: false, buildMs: 1000, repairRounds: 0, retries: 0, buildId: "b1" },
  ]);
  const { ranked, evidence } = rankCandidates(thin);
  assert.equal(evidence, "insufficient");
  assert.deepEqual(ranked, []);
  assert.equal(explainChoice(ranked), "Collecting benchmark data.");
});

test("cheaper-at-equal-quality wins and the explanation quotes the real percentage", () => {
  const cards = buildScorecards(evidenceRows({ grokCost: 0.62 }));
  const { ranked, evidence } = rankCandidates(cards, { task: "full_build" });
  assert.equal(evidence, "measured");
  assert.equal(ranked[0].key, "grok-4.5", "Auto naturally favours the cheaper model at equal verified results");
  const explanation = explainChoice(ranked, { task: "full_build" });
  assert.match(explanation, /Selected grok-4\.5/);
  assert.match(explanation, /equivalent verified results at approximately 38% lower average cost/);
  assert.match(explanation, /Medium confidence/);
  // The quoted figure is the real one, not a rounded invention.
  const real = Math.round(((ranked[1].costPerVerifiedBuild - ranked[0].costPerVerifiedBuild) / ranked[1].costPerVerifiedBuild) * 100);
  assert.match(explanation, new RegExp(`${real}% lower`));
});

test("per-task learning: OpenAI wins edits on speed while Grok wins builds on cost", () => {
  const cards = buildScorecards(evidenceRows());
  const edits = rankCandidates(cards, { task: "quick_edit" });
  assert.equal(edits.ranked[0].key, "gpt-5.6-terra", "faster on edits at equal verification");
  assert.match(explainChoice(edits.ranked, { task: "quick_edit" }), /quick edit builds completed \d+% faster with the same verification success/);
  const builds = rankCandidates(cards, { task: "full_build" });
  assert.equal(builds.ranked[0].key, "grok-4.5", "cheaper on full builds");
});

test("rankings are deterministic and re-derivable from the published weights", () => {
  const cards = buildScorecards(evidenceRows());
  const a = rankCandidates(cards, { task: "full_build" });
  const b = rankCandidates(buildScorecards(evidenceRows()), { task: "full_build" });
  assert.deepEqual(a.ranked.map((r) => [r.key, r.score]), b.ranked.map((r) => [r.key, r.score]), "same evidence -> identical ranking");
  assert.equal(WEIGHTS.costPerVerified + WEIGHTS.duration + WEIGHTS.verification, 1, "weights are a published, auditable split");
  // Identical models tie-break alphabetically rather than by insertion order.
  const twins = buildScorecards([
    ...Array.from({ length: 8 }, (_, i) => ({ provider: "b", model: "b-model", mode: "balanced", task: "full_build", owner: "o", cost: 1, inputTokens: 10, cachedTokens: 0, requestMs: 10, verified: true, cancelled: false, buildMs: 100, repairRounds: 0, retries: 0, buildId: `b${i}` })),
    ...Array.from({ length: 8 }, (_, i) => ({ provider: "a", model: "a-model", mode: "balanced", task: "full_build", owner: "o", cost: 1, inputTokens: 10, cachedTokens: 0, requestMs: 10, verified: true, cancelled: false, buildMs: 100, repairRounds: 0, retries: 0, buildId: `a${i}` })),
  ]);
  assert.equal(rankCandidates(twins, { task: "full_build" }).ranked[0].key, "a-model");
});

test("the recommendation promotes an existing candidate without inventing one", () => {
  const candidates = [
    { provider: "openai", model: "gpt-5.6-terra", key: "openai:gpt-5.6-terra" },
    { provider: "xai", model: "grok-4.5", key: "xai:grok-4.5" },
  ];
  const promoted = applyIntelligence(candidates, { model: "grok-4.5", explanation: "because measured", confidence: "Medium", samples: 20 });
  assert.equal(promoted[0].model, "grok-4.5");
  assert.equal(promoted[0].intelligence.explanation, "because measured");
  assert.equal(promoted.length, 2, "fallbacks are preserved, just reordered");
  // Already-first models still carry their evidence, so Auto can always explain itself.
  const unchanged = applyIntelligence(candidates, { model: "gpt-5.6-terra", explanation: "already best", confidence: "High", samples: 60 });
  assert.equal(unchanged[0].model, "gpt-5.6-terra");
  assert.equal(unchanged[0].intelligence.explanation, "already best");
  // A recommendation for something not in the candidate set changes nothing.
  assert.deepEqual(applyIntelligence(candidates, { model: "not-configured" }), candidates);
  assert.deepEqual(applyIntelligence(candidates, null), candidates);
});

test("Auto explains itself from evidence, and says it is collecting when there is none", () => {
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "sk-test-000000000000000000";
  const learned = autoStrategy({
    credential: { provider: "managed" }, routing: {},
    intelligence: { model: process.env.OPENAI_BALANCED_MODEL || "gpt-5.6-terra", explanation: "Selected gpt-5.6-terra because it achieved equivalent verified results at approximately 38% lower average cost (20 verified full build builds, Medium confidence).", confidence: "Medium", samples: 20 },
  });
  assert.equal(learned.learned, true);
  assert.match(learned.reason, /38% lower average cost/);
  assert.equal(learned.confidence, "Medium");

  const collecting = autoStrategy({ credential: { provider: "managed" }, routing: {}, stats: {}, intelligence: null });
  assert.equal(collecting.learned, false);
  assert.match(collecting.reason, /Collecting benchmark data/);
  assert.doesNotMatch(collecting.reason, /\d+%/, "never quotes a statistic it does not have");
});

test("recommendModel falls back from task scope to overall, or returns null", async () => {
  const cards = buildScorecards(evidenceRows());
  const forEdits = await recommendModel({ task: "quick_edit", scorecards: cards });
  assert.equal(forEdits.model, "gpt-5.6-terra");
  assert.equal(forEdits.task, "quick_edit");
  // An unseen task family falls back to the overall ranking rather than guessing.
  const unseen = await recommendModel({ task: "verification_repair", scorecards: cards });
  assert.equal(unseen.task, null, "fell back to the overall evidence");
  assert.ok(unseen.model);
  // No evidence at all -> null, so callers keep their configured behaviour.
  assert.equal(await recommendModel({ scorecards: buildScorecards([]) }), null);
});

test("evidence collection is anonymised and the snapshot never fabricates", async () => {
  const rows = evidenceRows();
  const client = {
    from: (table) => ({
      select: () => ({
        gte: () => ({
          limit: async () => ({
            data: table === "ai_requests"
              ? rows.map((r) => ({ owner: r.owner, provider: r.provider, model: r.model, input_tokens: r.inputTokens, output_tokens: 100, cached_tokens: r.cachedTokens, duration_ms: r.requestMs, cost: r.cost, build_id: r.buildId, trigger: "user", context: { taskType: r.task, mode: r.mode }, created_at: new Date().toISOString() }))
              : [...new Set(rows.map((r) => r.buildId))].map((id) => {
                const row = rows.find((r) => r.buildId === id);
                return { id, kind: "app_build", status: row.verified ? "passed" : "failed", duration_ms: row.buildMs, repair_rounds: row.repairRounds, totals: { cost: row.cost }, model: row.model, started_at: new Date().toISOString() };
              }),
          }),
        }),
      }),
    }),
  };
  const collected = await collectEvidence({ client });
  assert.ok(collected.length > 0);
  assert.ok(collected.every((r) => !("prompt" in r)), "no prompt text is ever collected");

  const snapshot = await providerIntelligenceSnapshot({ client });
  assert.ok(snapshot.models.length >= 2);
  assert.equal(snapshot.minSamples, MIN_SAMPLES);
  assert.deepEqual(snapshot.weights, WEIGHTS, "the dashboard publishes the weights it ranked with");
  assert.match(snapshot.overall.explanation, /Selected /);
  // Task families with no evidence report honestly instead of showing an empty ranking.
  assert.equal(snapshot.perTask.verification_repair.explanation, "Collecting benchmark data.");
  assert.deepEqual(snapshot.perTask.verification_repair.ranked, []);
});

test("per-model profiles derive strengths, weaknesses, win rate and score from evidence", async () => {
  const { modelProfiles, providerTree } = await import("../../shell/server/lib/providerIntelligence.mjs");
  const cards = buildScorecards(evidenceRows());
  const profiles = modelProfiles(cards);
  const grok = profiles.find((p) => p.model === "grok-4.5");
  const openai = profiles.find((p) => p.model === "gpt-5.6-terra");

  assert.ok(grok.strengths.includes("lowest cost per verified build"), "strengths are measured, not assigned");
  assert.ok(openai.strengths.includes("fastest completion"));
  assert.ok(openai.weaknesses.includes("highest cost per verified build"));
  assert.ok(grok.weaknesses.includes("slowest completion"));
  // Task win rate: each wins one of the two contested families.
  assert.equal(grok.taskContests, 2);
  assert.equal(grok.taskWins, 1);
  assert.equal(grok.taskWinRate, 50);
  assert.equal(openai.taskWinRate, 50);
  assert.ok(typeof grok.recommendationScore === "number", "carries the auditable score");
  assert.equal(grok.collecting, false);

  // Providers nest their models; the provider for a model is learned from the evidence.
  const tree = providerTree(cards, profiles);
  const xai = tree.find((p) => p.provider === "xai");
  assert.equal(xai.models.length, 1);
  assert.equal(xai.models[0].model, "grok-4.5");
  assert.ok(tree.find((p) => p.provider === "openai").models.some((m) => m.model === "gpt-5.6-terra"));
});

test("models below the floor report collecting, with no invented strengths", async () => {
  const { modelProfiles } = await import("../../shell/server/lib/providerIntelligence.mjs");
  const thin = buildScorecards([
    { provider: "xai", model: "grok-new", mode: "balanced", task: "ui", owner: "o", cost: 0.1, inputTokens: 10, cachedTokens: 0, requestMs: 10, verified: true, cancelled: false, buildMs: 100, repairRounds: 0, retries: 0, buildId: "b1", createdAt: new Date().toISOString() },
  ]);
  const profile = modelProfiles(thin)[0];
  assert.equal(profile.collecting, true);
  assert.deepEqual(profile.strengths, [], "no claims without enough evidence");
  assert.deepEqual(profile.weaknesses, []);
  assert.equal(profile.recommendationScore, null);
  assert.equal(profile.confidence, null);
});

test("the richer task taxonomy classifies real request wording", async () => {
  const { classifyTask } = await import("../../shell/server/lib/appBuild/contextScope.mjs");
  const cases = [
    ["Plan the approach for adding multi-tenant support", "planning"],
    ["Design the database schema for orders and invoices", "architecture"],
    ["The signup button throws an error when clicked", "debugging"],
    ["Change the header colour to navy and tighten the spacing", "ui"],
    ["Add a settings page component with a form", "frontend"],
    ["Create an API endpoint that persists bookings", "backend"],
    ["Refactor the checkout code to remove duplication", "refactoring"],
    ["Write a README documenting the setup steps", "documentation"],
    ["Rename the Save button to Submit", "quick_edit"],
  ];
  for (const [prompt, expected] of cases) {
    assert.equal(classifyTask({ mode: "iterate", prompt }), expected, `"${prompt.slice(0, 40)}…"`);
  }
  assert.equal(classifyTask({ mode: "build", prompt: "anything" }), "full_build");
  assert.equal(classifyTask({ mode: "iterate", prompt: "x", trigger: "verification_repair" }), "verification_repair");
});

test("snapshot exposes the expandable provider tree and per-task learning", async () => {
  const rows = evidenceRows().map((r) => ({ ...r, createdAt: new Date().toISOString() }));
  const client = {
    from: (table) => ({
      select: () => ({
        gte: () => ({
          limit: async () => ({
            data: table === "ai_requests"
              ? rows.map((r) => ({ owner: r.owner, provider: r.provider, model: r.model, input_tokens: r.inputTokens, output_tokens: 100, cached_tokens: r.cachedTokens, duration_ms: r.requestMs, cost: r.cost, build_id: r.buildId, trigger: "user", context: { taskType: r.task, mode: r.mode }, created_at: r.createdAt }))
              : [...new Set(rows.map((r) => r.buildId))].map((id) => {
                const row = rows.find((r) => r.buildId === id);
                return { id, kind: "app_build", status: row.verified ? "passed" : "failed", duration_ms: row.buildMs, repair_rounds: row.repairRounds, totals: { cost: row.cost }, model: row.model, started_at: row.createdAt };
              }),
          }),
        }),
      }),
    }),
  };
  const snap = await providerIntelligenceSnapshot({ client });
  assert.ok(snap.providers.length >= 2, "providers listed from evidence");
  const xai = snap.providers.find((p) => p.provider === "xai");
  assert.ok(xai.models[0].strengths.length > 0, "each model carries its measured profile");
  assert.ok(snap.taskTypes.includes("planning") && snap.taskTypes.includes("quick_edit"));
  // Task families with no evidence stay honest.
  assert.equal(snap.perTask.documentation.explanation, "Collecting benchmark data.");
  assert.ok(snap.perTask.full_build.ranked.length >= 2);
});

test("routing keeps its configured order when Auto has no evidence", () => {
  process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "sk-test-000000000000000000";
  const baseline = routeCandidates({ credential: { provider: "managed" }, policy: { routingMode: "balanced" } });
  const withNull = routeCandidates({ credential: { provider: "managed" }, policy: { routingMode: "balanced", intelligence: null } });
  assert.deepEqual(withNull.map((c) => c.key), baseline.map((c) => c.key));
});
