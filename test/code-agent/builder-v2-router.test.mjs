import test from "node:test";
import assert from "node:assert/strict";
import { requiredTier, routeV2Step } from "../../shell/server/lib/builderV2/router.mjs";

const managed = { primaryProvider: "managed", allowManagedFallback: true, allowedFallbackProviders: [] };
const codex = { primaryProvider: "codex", allowManagedFallback: false, allowedFallbackProviders: [] };

const candidate = (model, tier, estimatedCredits, provider = "openai", billingLane = "managed") => ({
  provider, laneProvider: billingLane === "managed" ? "managed" : provider,
  model, tier, estimatedCredits, billingLane, available: true,
});
const history = (model, count, passed, provider = "managed") => Array.from({ length: count }, (_, i) => ({
  provider, model, taskClass: "edit", verified: i < passed, cost: model === "gpt-5.6-luna" ? 0.2 : 1,
}));

test("deterministic implementation is always considered before a model", () => {
  const out = routeV2Step({ step: "repair", deterministicSolution: { available: true, reason: "known migration" } });
  assert.deepEqual([out.kind, out.estimatedCredits, out.reason], ["deterministic", 0, "known migration"]);
});

test("complexity, retrieval and repeated repair raise the minimum reasoning tier", () => {
  assert.equal(requiredTier({ step: "edit", complexity: "simple", retrievalTokens: 1000 }), "fast");
  assert.equal(requiredTier({ step: "repair", complexity: "medium" }), "balanced");
  assert.equal(requiredTier({ step: "edit", retrievalTokens: 13_000 }), "quality");
  assert.equal(requiredTier({ step: "repair", repairRound: 2 }), "quality");
});

test("router selects the cheapest model with proven success for the class", () => {
  const out = routeV2Step({
    step: "edit", taskClass: "edit", complexity: "simple", policy: managed,
    candidates: [candidate("gpt-5.6-luna", "fast", 0.2), candidate("gpt-5.6-sol", "quality", 1)],
    history: [...history("gpt-5.6-luna", 8, 7, "openai"), ...history("gpt-5.6-sol", 8, 8, "openai")],
  });
  assert.equal(out.model, "gpt-5.6-luna");
  assert.match(out.reason, /cheapest model/);
});

test("router does not buy a cheap model with failed evidence", () => {
  const out = routeV2Step({
    step: "edit", taskClass: "edit", policy: managed,
    candidates: [candidate("gpt-5.6-luna", "fast", 0.2), candidate("gpt-5.6-sol", "quality", 1)],
    history: [...history("gpt-5.6-luna", 8, 2, "openai"), ...history("gpt-5.6-sol", 8, 8, "openai")],
  });
  assert.equal(out.model, "gpt-5.6-sol");
});

test("Codex selection cannot silently route onto managed", () => {
  const out = routeV2Step({
    step: "contract", complexity: "complex", policy: codex,
    candidates: [candidate("gpt-5.6-sol", "quality", 1), candidate("gpt-5.5", "quality", 0.5, "codex", "connected_allowance")],
  });
  assert.equal(out.provider, "codex");
  assert.throws(() => routeV2Step({
    step: "contract", complexity: "complex", policy: codex,
    candidates: [candidate("gpt-5.6-sol", "quality", 1)],
  }), /selected billing lane/);
});

test("manual model selection remains policy- and availability-checked", () => {
  const candidates = [candidate("gpt-5.6-luna", "fast", 0.2), candidate("gpt-5.6-sol", "quality", 1)];
  const out = routeV2Step({ step: "edit", policy: managed, candidates, manualModel: "managed:openai:gpt-5.6-sol" });
  assert.equal(out.reason, "manual model selection");
  assert.throws(() => routeV2Step({ step: "edit", policy: managed, candidates, manualModel: "managed:openai:missing" }), /not executable|unavailable/);
});

test("manual provider:model selections match the wire provider without changing billing lane", () => {
  const candidates = [
    candidate("gpt-5.6-sol", "quality", 1, "openai", "managed"),
  ];
  const out = routeV2Step({
    step: "edit", policy: managed, candidates, manualModel: "managed:openai:gpt-5.6-sol",
  });
  assert.equal(out.provider, "openai");
  assert.equal(out.billingLane, "managed");
  assert.throws(() => routeV2Step({
    step: "edit", policy: managed, candidates, manualModel: "managed:anthropic:claude-sonnet-5",
  }), /not executable|unavailable/);
});
