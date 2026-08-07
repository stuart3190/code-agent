import test from "node:test";
import assert from "node:assert/strict";
import { requiredTier, routeV2Step } from "../../shell/server/lib/builderV2/router.mjs";

const managed = { primaryProvider: "managed", allowManagedFallback: true, allowedFallbackProviders: [] };
const codex = { primaryProvider: "codex", allowManagedFallback: false, allowedFallbackProviders: [] };

const candidate = (model, tier, estimatedCredits, provider = "managed") => ({
  provider, model, tier, estimatedCredits, billingLane: provider === "managed" ? "managed" : "connected_allowance", available: true,
});
const history = (model, count, passed, provider = "managed") => Array.from({ length: count }, (_, i) => ({
  provider, model, taskClass: "edit", verified: i < passed, cost: model === "cheap" ? 0.2 : 1,
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
    candidates: [candidate("cheap", "fast", 0.2), candidate("strong", "quality", 1)],
    history: [...history("cheap", 8, 7), ...history("strong", 8, 8)],
  });
  assert.equal(out.model, "cheap");
  assert.match(out.reason, /cheapest model/);
});

test("router does not buy a cheap model with failed evidence", () => {
  const out = routeV2Step({
    step: "edit", taskClass: "edit", policy: managed,
    candidates: [candidate("cheap", "fast", 0.2), candidate("strong", "quality", 1)],
    history: [...history("cheap", 8, 2), ...history("strong", 8, 8)],
  });
  assert.equal(out.model, "strong");
});

test("Codex selection cannot silently route onto managed", () => {
  const out = routeV2Step({
    step: "contract", complexity: "complex", policy: codex,
    candidates: [candidate("managed-quality", "quality", 1), candidate("codex", "quality", 0.5, "codex")],
  });
  assert.equal(out.provider, "codex");
  assert.throws(() => routeV2Step({
    step: "contract", complexity: "complex", policy: codex,
    candidates: [candidate("managed-quality", "quality", 1)],
  }), /selected billing lane/);
});

test("manual model selection remains policy- and availability-checked", () => {
  const candidates = [candidate("fast", "fast", 0.2), candidate("quality", "quality", 1)];
  const out = routeV2Step({ step: "edit", policy: managed, candidates, manualModel: "quality" });
  assert.equal(out.reason, "manual model selection");
  assert.throws(() => routeV2Step({ step: "edit", policy: managed, candidates, manualModel: "missing" }), /unavailable/);
});

test("manual provider:model selections match the wire provider without changing billing lane", () => {
  const candidates = [
    { ...candidate("quality", "quality", 1, "openai"), laneProvider: "managed", billingLane: "managed" },
    { ...candidate("quality", "quality", 1, "anthropic"), laneProvider: "managed", billingLane: "managed" },
  ];
  const out = routeV2Step({
    step: "edit", policy: managed, candidates, manualModel: "openai:quality",
  });
  assert.equal(out.provider, "openai");
  assert.equal(out.billingLane, "managed");
  assert.throws(() => routeV2Step({
    step: "edit", policy: managed, candidates: candidates.slice(0, 1), manualModel: "anthropic:quality",
  }), /unavailable/);
});
