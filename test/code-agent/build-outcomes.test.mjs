// Real-world outcome learning: measurable behaviour only, anonymous, and folded into
// Auto's ranking so user success outweighs raw price.

process.env.CODE_AGENT_STORE = "memory";

import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  deriveOutcome, summariseOutcomes, userSuccessScore, outcomesByModel,
  recordBuildSignal, SIGNALS, SUCCESS_WEIGHTS,
} from "../../shell/server/lib/buildOutcomes.mjs";
import { buildScorecards, rankCandidates, explainChoice, WEIGHTS_WITH_OUTCOMES } from "../../shell/server/lib/providerIntelligence.mjs";

const HOUR = 3_600_000;
const run = (over = {}) => ({
  id: "b1", model: "m", status: "passed", repair_rounds: 0,
  finished_at: new Date(Date.now() - 2 * HOUR).toISOString(), ...over,
});

test("outcomes are derived from measurable behaviour, never opinions", () => {
  // Kept without touching it: verified, no follow-ups, settled.
  const clean = deriveOutcome({ run: run(), signals: ["preview_opened"], followUps: 0, lastActivityAt: new Date(Date.now() - 2 * HOUR).toISOString() });
  assert.equal(clean.accepted, true);
  assert.equal(clean.firstPass, true);
  assert.equal(clean.abandoned, false);

  // Exported counts as kept even with iterations.
  const iterated = deriveOutcome({ run: run({ repair_rounds: 2 }), signals: ["exported"], followUps: 4 });
  assert.equal(iterated.accepted, true);
  assert.equal(iterated.firstPass, false, "iterations mean it wasn't first-pass");
  assert.equal(iterated.exported, true);

  // Rolled back is never acceptance.
  const rolled = deriveOutcome({ run: run(), signals: ["rolled_back"], followUps: 1 });
  assert.equal(rolled.accepted, false);
  assert.equal(rolled.rolledBack, true);

  // Failed and dropped = abandoned.
  const dropped = deriveOutcome({ run: run({ status: "failed" }), signals: [], followUps: 0 });
  assert.equal(dropped.accepted, false);
  assert.equal(dropped.abandoned, true);

  // Deployment is read from the published-sites record, not a self-report.
  assert.equal(deriveOutcome({ run: run(), signals: [], followUps: 0, deployed: true }).deployed, true);

  // A build the user is still working on is neither accepted nor abandoned yet.
  const active = deriveOutcome({ run: run({ finished_at: new Date().toISOString() }), signals: [], followUps: 1, lastActivityAt: new Date().toISOString() });
  assert.equal(active.settled, false);
  assert.equal(active.accepted, false);
  assert.equal(active.abandoned, false);
});

test("summary exposes every required user-outcome metric", () => {
  const outcomes = [
    deriveOutcome({ run: run({ id: "a" }), signals: ["exported", "preview_opened"], followUps: 0 }),
    deriveOutcome({ run: run({ id: "b", repair_rounds: 1 }), signals: ["deployed"], followUps: 2 }),
    deriveOutcome({ run: run({ id: "c", status: "failed" }), signals: [], followUps: 0 }),
    deriveOutcome({ run: run({ id: "d" }), signals: ["rolled_back"], followUps: 3 }),
  ];
  const s = summariseOutcomes(outcomes);
  for (const key of ["acceptanceRate", "firstPassAcceptanceRate", "exportRate", "deploymentRate", "rollbackRate", "completionRate", "abandonmentRate", "avgFollowUps", "avgRepairCycles", "previewOpenRate"]) {
    assert.ok(s[key] !== undefined, `${key} reported`);
  }
  assert.equal(s.builds, 4);
  assert.equal(s.exportRate, 25);
  assert.equal(s.deploymentRate, 25);
  assert.equal(s.rollbackRate, 25);
  assert.equal(s.avgFollowUps, 1.25);
});

test("the User Success Score rewards kept, low-friction builds and is re-derivable", () => {
  const great = summariseOutcomes([
    deriveOutcome({ run: run({ id: "a" }), signals: ["exported"], followUps: 0 }),
    deriveOutcome({ run: run({ id: "b" }), signals: ["deployed"], followUps: 0 }),
  ]);
  const poor = summariseOutcomes([
    deriveOutcome({ run: run({ id: "c", status: "failed", repair_rounds: 3 }), signals: [], followUps: 6 }),
    deriveOutcome({ run: run({ id: "d" }), signals: ["rolled_back"], followUps: 5 }),
  ]);
  const greatScore = userSuccessScore(great);
  const poorScore = userSuccessScore(poor);
  assert.ok(greatScore > poorScore, `${greatScore} should beat ${poorScore}`);
  assert.ok(greatScore <= 100 && poorScore >= 0);
  assert.equal(Number((Object.values(SUCCESS_WEIGHTS).reduce((a, b) => a + b, 0)).toFixed(2)), 1, "weights are a published split");
});

test("a costlier model that users actually finish outranks a cheap one they abandon", () => {
  // Technical evidence: "cheap" is half the price and equally verified.
  const rows = [];
  const add = (n, model, cost) => {
    for (let i = 0; i < n; i += 1) {
      rows.push({ provider: "p", model, mode: "balanced", task: "full_build", owner: "o", cost, inputTokens: 1000, cachedTokens: 100, requestMs: 1000, verified: true, cancelled: false, buildMs: 30_000, repairRounds: 0, retries: 0, buildId: `${model}-${i}`, createdAt: new Date().toISOString() });
    }
  };
  add(10, "cheap-model", 0.5);
  add(10, "premium-model", 1.0);
  const cards = buildScorecards(rows);

  // Without outcome evidence, price wins.
  const technical = rankCandidates(cards, { task: "full_build" });
  assert.equal(technical.ranked[0].key, "cheap-model");
  assert.equal(technical.usedOutcomes, false);

  // With real outcomes: users keep and deploy the premium model's builds.
  const outcomes = {
    "cheap-model": { ...summariseOutcomes(Array.from({ length: 10 }, (_, i) => deriveOutcome({ run: run({ id: `c${i}` }), signals: ["rolled_back"], followUps: 5 }))), collecting: false },
    "premium-model": { ...summariseOutcomes(Array.from({ length: 10 }, (_, i) => deriveOutcome({ run: run({ id: `p${i}` }), signals: ["exported", "deployed"], followUps: 0 }))), collecting: false },
  };
  outcomes["cheap-model"].userSuccessScore = userSuccessScore(outcomes["cheap-model"]);
  outcomes["premium-model"].userSuccessScore = userSuccessScore(outcomes["premium-model"]);

  const withOutcomes = rankCandidates(cards, { task: "full_build", outcomes });
  assert.equal(withOutcomes.usedOutcomes, true);
  assert.equal(withOutcomes.ranked[0].key, "premium-model", "user success outweighs raw price");
  assert.deepEqual(withOutcomes.weights, WEIGHTS_WITH_OUTCOMES);
  assert.match(explainChoice(withOutcomes.ranked, { task: "full_build" }), /users completed and kept its builds more often/);
});

test("partial outcome evidence never ranks on an uneven basis", () => {
  const rows = [];
  for (let i = 0; i < 10; i += 1) {
    rows.push({ provider: "p", model: "a", mode: "balanced", task: "ui", owner: "o", cost: 1, inputTokens: 10, cachedTokens: 0, requestMs: 10, verified: true, cancelled: false, buildMs: 100, repairRounds: 0, retries: 0, buildId: `a${i}`, createdAt: new Date().toISOString() });
    rows.push({ provider: "p", model: "b", mode: "balanced", task: "ui", owner: "o", cost: 2, inputTokens: 10, cachedTokens: 0, requestMs: 10, verified: true, cancelled: false, buildMs: 100, repairRounds: 0, retries: 0, buildId: `b${i}`, createdAt: new Date().toISOString() });
  }
  const cards = buildScorecards(rows);
  // Only one model has outcome evidence -> fall back to technical weights.
  const ranking = rankCandidates(cards, { task: "ui", outcomes: { a: { userSuccessScore: 90, collecting: false } } });
  assert.equal(ranking.usedOutcomes, false, "an uneven picture is not used for ranking");
  assert.equal(ranking.ranked[0].key, "a", "technical ranking still applies");
});

test("models below the floor report collecting instead of a score", () => {
  const outcomes = outcomesByModel([
    deriveOutcome({ run: run({ id: "x", model: "thin" }), signals: ["exported"], followUps: 0 }),
  ]);
  assert.equal(outcomes.thin.collecting, true);
  assert.equal(outcomes.thin.userSuccessScore, undefined, "no score without enough evidence");
});

test("signals are validated, idempotent and free of identifying data", async () => {
  const inserted = [];
  const client = { from: () => ({ insert: async (row) => { inserted.push(row); return { error: null }; } }) };
  await recordBuildSignal({ buildId: "b1", owner: "o1", signal: "exported", client });
  assert.equal(inserted[0].signal, "exported");
  assert.deepEqual(Object.keys(inserted[0]).sort(), ["build_id", "created_at", "id", "owner", "signal"], "no prompt or content fields");
  await assert.rejects(recordBuildSignal({ buildId: "b1", owner: "o1", signal: "liked_it", client }), /Unknown build signal/);
  assert.ok(!SIGNALS.includes("rating") && !SIGNALS.includes("like"), "no subjective signals exist");
  // A duplicate is swallowed, not surfaced (unique index makes it idempotent).
  const dupClient = { from: () => ({ insert: async () => ({ error: { message: 'duplicate key value violates unique constraint "build_signals_unique_idx"' } }) }) };
  await recordBuildSignal({ buildId: "b1", owner: "o1", signal: "exported", client: dupClient });
});

test("analytics never carry prompt text or user identifiers", async () => {
  const source = await readFile(fileURLToPath(new URL("../../shell/server/lib/buildOutcomes.mjs", import.meta.url)), "utf8");
  // Turn CONTENT is never selected — only role and timestamp, for counting.
  assert.match(source, /select\("role, created_at"\)/, "conversation turns are read for counts only");
  assert.doesNotMatch(source, /select\([^)]*content/, "message content is never read");
  const outcomes = outcomesByModel(Array.from({ length: 6 }, (_, i) =>
    deriveOutcome({ run: run({ id: `o${i}`, model: "m" }), signals: ["exported"], followUps: 0 })));
  const serialised = JSON.stringify(outcomes);
  assert.doesNotMatch(serialised, /owner|email|prompt|user_id/i, "aggregate output is anonymous");
});

test("a build's outcome window ends when the next build begins", () => {
  // Superseded builds are settled immediately — the user moved on to new work, so later
  // messages must not be counted against the earlier build.
  const superseded = deriveOutcome({
    run: run({ id: "early" }), signals: [], followUps: 1,
    lastActivityAt: new Date(Date.now() - 90 * 60_000).toISOString(), superseded: true,
  });
  assert.equal(superseded.settled, true, "a later build settles this one");
  assert.equal(superseded.accepted, true, "verified, kept, few follow-ups inside its own window");
  assert.equal(superseded.followUps, 1, "only the follow-ups inside the window are counted");

  // Without that windowing, a long session would make every early build look abandoned.
  const active = deriveOutcome({
    run: run({ id: "latest" }), signals: [], followUps: 0,
    lastActivityAt: new Date().toISOString(), superseded: false,
  });
  assert.equal(active.settled, false, "the current build is still in play");
});
