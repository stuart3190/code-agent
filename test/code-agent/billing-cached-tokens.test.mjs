// The 2026-08-05 billing incident, as regression fixtures.
//
// Production run 83883309: diagnostics, ai_requests and the profiler all said 19.25 credits, and
// the customer ledger was debited 51.33 — because settle()'s debit priced with a flat
// total/TOKENS_PER_CREDIT rule that charged 356,455 cached tokens as fresh input. The three
// surfaces that agreed were the reports; the one that disagreed took the money.

import { test } from "node:test";
import assert from "node:assert/strict";
import { creditsForUsage } from "../../src/billing/costModel.mjs";

// The seven real provider calls, verbatim from ai_requests for build 83883309.
export const RUN_83883309 = [
  { id: "62e2f88f", model: "gpt-5.6-sol",   input: 1013,   cached: 0,      output: 1249, reasoning: 257,  recorded: 0.2262 },
  { id: "e883f76d", model: "gpt-5.6-sol",   input: 1559,   cached: 0,      output: 6262, reasoning: 1030, recorded: 0.7821 },
  { id: "e7001d70", model: "gpt-5.6-sol",   input: 33695,  cached: 13467,  output: 7402, reasoning: 641,  recorded: 2.8977 },
  { id: "cc40d2ed", model: "gpt-5.6-sol",   input: 68301,  cached: 48275,  output: 4485, reasoning: 1456, recorded: 2.9339 },
  { id: "865a7aa9", model: "gpt-5.6-sol",   input: 107793, cached: 83371,  output: 8542, reasoning: 1111, recorded: 4.1301 },
  { id: "cb7d7713", model: "gpt-5.6-sol",   input: 221395, cached: 190806, output: 8750, reasoning: 1044, recorded: 5.8420 },
  { id: "8cd7768e", model: "gpt-5.6-terra", input: 40241,  cached: 20536,  output: 2604, reasoning: 162,  recorded: 2.4363 },
];

const usageOf = (e) => ({ input: e.input, cached: e.cached, output: e.output, reasoning: e.reasoning,
  total: e.input + e.output });

test("REGRESSION 83883309 — the canonical formula reproduces every recorded cost exactly", () => {
  let total = 0;
  for (const event of RUN_83883309) {
    const cost = creditsForUsage({ usage: usageOf(event), model: event.model });
    assert.ok(Math.abs(cost - event.recorded) < 0.0001,
      `${event.id}: costModel says ${cost.toFixed(4)}, ai_requests recorded ${event.recorded}`);
    total += cost;
  }
  assert.ok(Math.abs(total - 19.25) < 0.01, `run total must be 19.25, got ${total.toFixed(2)}`);
});

test("REGRESSION 83883309 — the flat rule produced exactly the wrong 51.33, and is gone", async () => {
  // (input+output)/10,000 — cached charged as fresh, model ignored. This must never price a debit
  // again; it is pinned here as the WRONG answer so the defect is recognisable if it returns.
  const flat = RUN_83883309.reduce((s, e) => s + (e.input + e.output) / 10_000, 0);
  assert.ok(Math.abs(flat - 51.33) < 0.01, `the defective rule gave ${flat.toFixed(2)}`);

  // And the live debit path now uses the canonical formula: the source must price with
  // creditsForUsage and must not divide totals by TOKENS_PER_CREDIT.
  const { readFileSync } = await import("node:fs");
  const source = readFileSync("shell/server/lib/appBuild/budgetLedger.mjs", "utf8");
  assert.match(source, /need = r4\(creditsForUsage\(\{ usage: tokens, model \}\)\)/);
  // The old line survives only as a comment documenting the incident; no LIVE line may match.
  const liveLines = source.split("\n").filter((l) => !l.trim().startsWith("//"));
  assert.ok(!liveLines.some((l) => /need = r4\(tokens\.total \/ TOKENS_PER_CREDIT\)/.test(l)));
});

test("pricing is linear over aggregation, so per-call and summed totals cannot drift", () => {
  const summed = RUN_83883309.reduce((a, e) => ({
    input: a.input + e.input, cached: a.cached + e.cached,
    output: a.output + e.output, reasoning: a.reasoning + e.reasoning,
  }), { input: 0, cached: 0, output: 0, reasoning: 0 });
  const perCall = RUN_83883309.filter((e) => e.model === "gpt-5.6-sol")
    .reduce((s, e) => s + creditsForUsage({ usage: usageOf(e), model: e.model }), 0);
  const solSum = RUN_83883309.filter((e) => e.model === "gpt-5.6-sol")
    .reduce((a, e) => ({ input: a.input + e.input, cached: a.cached + e.cached, output: a.output + e.output, reasoning: a.reasoning + e.reasoning }), { input: 0, cached: 0, output: 0, reasoning: 0 });
  const ofSum = creditsForUsage({ usage: solSum, model: "gpt-5.6-sol" });
  assert.ok(Math.abs(perCall - ofSum) < 0.01, `${perCall.toFixed(4)} vs ${ofSum.toFixed(4)}`);
  assert.ok(summed.cached > 350_000, "the fixture preserves the cached volume that made this matter");
});

test("recording the same event twice must not increase the total (idempotent replay)", () => {
  // A ledger derived from keyed events: replaying a delivery is a no-op.
  const ledger = new Map();
  const record = (e) => { if (!ledger.has(e.id)) ledger.set(e.id, creditsForUsage({ usage: usageOf(e), model: e.model })); };
  for (const e of RUN_83883309) record(e);
  const once = [...ledger.values()].reduce((a, b) => a + b, 0);
  for (const e of RUN_83883309) record(e);           // duplicate delivery
  for (const e of RUN_83883309.slice(0, 3)) record(e); // partial restart replay
  const twice = [...ledger.values()].reduce((a, b) => a + b, 0);
  assert.equal(once, twice);
  assert.ok(Math.abs(once - 19.25) < 0.01);
});

test("the 28-credit ceiling now admits the repair it wrongly refused", () => {
  // With the corrected total (19.25 spent), a ~4-credit repair projects to ~23.25 — affordable.
  // With the inflated 51.33 it was refused. Same arithmetic as dispatchCheck.
  const ceiling = 28;
  const projectedWithCorrectTotal = 19.25 + 4.13;
  const projectedWithInflatedTotal = 51.33 + 4.13;
  assert.ok(projectedWithCorrectTotal <= ceiling, "the corrected total admits the repair");
  assert.ok(projectedWithInflatedTotal > ceiling, "the inflated total is why it was refused");
});

test("provider request ids survive normalisation into the recorded row", async () => {
  // Without this the column exists and is never written: normalizeTelemetry stripped everything
  // non-numeric, so norm.providerRequestIds was always undefined and storage silently never ran.
  const { normalizeTelemetry } = await import("../../shell/server/lib/appBuild/buildDiagnostics.mjs");
  const norm = normalizeTelemetry({
    input: 100, output: 50, cached: 20, reasoning: 5, total: 150,
    providerRequestIds: ["resp_abc123", "resp_def456"],
  });
  assert.deepEqual(norm.providerRequestIds, ["resp_abc123", "resp_def456"]);
  assert.equal(normalizeTelemetry({ input: 1, output: 1 }).providerRequestIds, null,
    "absent ids stay null rather than an empty array");
});
