import assert from "node:assert/strict";
import test from "node:test";

process.env.OPENAI_API_KEY ||= "sk-test-package13";

import {
  MODEL_LANES, assertCapabilityModel, assertExecutableCandidate, canonicalModelIdentity, executableModelCatalogue, parseSelection, selectionValue,
} from "../../shell/server/lib/modelCatalogue.mjs";
import { selectableModels } from "../../shell/server/lib/modelSelector.mjs";
import { routeCandidates } from "../../shell/server/lib/modelRouting.mjs";
import { createModelLanes } from "../../shell/server/lib/builderV2/modelLanes.mjs";
import { memoryModelReservations } from "../../shell/server/lib/builderV2/modelReservations.mjs";
import { creditsForUsage } from "../../src/billing/costModel.mjs";
import { memoryKnowledgeStore } from "../../shell/server/lib/builderV2/knowledge.mjs";
import { readFileSync } from "node:fs";

const CONTRACT = { summary: "proof", journeys: [], entities: [], roles: [], nonGoals: [], risks: [], acceptance: [] };
const TIERS = { essential: { journeys: [], entities: [] }, secondary: { journeys: [], entities: [] } };
const call = (lanes) => lanes.patchesFn({
  owner: "owner", projectId: "project", buildId: "build", step: "core",
  contract: CONTRACT, tiers: TIERS, tree: {}, rejections: [], problems: [],
});

test("Package 13 catalogue identities are unique and every public selection pins a lane", () => {
  const rows = executableModelCatalogue();
  const identities = [];
  for (const row of rows) {
    for (const lane of row.lanes) {
      const identity = canonicalModelIdentity({ provider: row.provider, model: row.model, lane });
      identities.push(identity.key);
      assert.deepEqual(parseSelection(selectionValue(identity)), { lane, provider: row.provider, model: row.model });
      assert.ok(identity.billingPolicy);
    }
  }
  assert.equal(new Set(identities).size, identities.length);
  assert.throws(() => canonicalModelIdentity({ provider: "xai", model: "grok-4.5", lane: MODEL_LANES.managed }), /not executable/);
  assert.throws(() => canonicalModelIdentity({ provider: "openai", model: "invented", lane: MODEL_LANES.byok }), /not executable/);
  assert.throws(() => assertExecutableCandidate({
    provider: "openai", model: "gpt-5.6-terra", billingLane: MODEL_LANES.managed, executable: false,
  }), (error) => error.code === "model_unavailable");
});

test("Package 13 UI catalogue exposes only executable lane/provider/model triples", () => {
  const catalog = selectableModels({ credentials: [
    { provider: "openai" }, { provider: "anthropic" }, { provider: "gemini" }, { provider: "xai" }, { provider: "codex" },
  ] });
  for (const option of catalog.options.filter((row) => row.value !== "auto")) {
    const parsed = parseSelection(option.value);
    const identity = canonicalModelIdentity(parsed);
    assert.equal(identity.key, option.identity);
  }
  assert.equal(catalog.options.some((row) => row.model === "claude-haiku-4-5"), false, "ambiguous alias hidden");
  assert.equal(catalog.options.some((row) => row.model === "claude-sonnet-4-6"), false, "deprecated model hidden");
});

test("Package 13 capability-runtime models are internal, operation-scoped and never enter the builder selector", () => {
  const catalog = selectableModels({ credentials: [{ provider: "openai" }] });
  for (const model of ["gpt-5.4-mini", "gpt-5.4", "text-embedding-3-small", "bytedance/seedance-1-pro"]) {
    assert.equal(catalog.options.some((row) => row.model === model), false);
  }
  assert.equal(assertCapabilityModel({
    provider: "openai", model: "gpt-5.4-mini", lane: MODEL_LANES.managed, operation: "text",
  }).model, "gpt-5.4-mini");
  assert.throws(() => assertCapabilityModel({
    provider: "openai", model: "gpt-5.4-mini", lane: MODEL_LANES.managed, operation: "image",
  }), (error) => error.code === "model_capability_unavailable");
  assert.throws(() => assertCapabilityModel({
    provider: "replicate", model: "someone/arbitrary-model", lane: MODEL_LANES.byok, operation: "prediction",
  }), (error) => error.code === "model_unsupported");
});

test("Package 13 manual routing cannot substitute the active BYOK provider or lane", () => {
  assert.throws(() => routeCandidates({
    credential: { provider: "anthropic", secret: "synthetic" },
    requested: "byok_api:openai:gpt-5.6-terra",
  }), (error) => error.code === "model_lane_unavailable");
  const exact = routeCandidates({
    credential: { provider: "anthropic", secret: "synthetic" },
    requested: "byok_api:anthropic:claude-sonnet-5",
  });
  assert.deepEqual([exact[0].provider, exact[0].model, exact[0].billingLane], ["anthropic", "claude-sonnet-5", "byok_api"]);
});

test("Package 13 provider failures have deterministic reservation outcomes", async () => {
  const cases = [
    { name: "validation 4xx", error: { message: "bad request", status: 400, dispatchState: "provider_rejected", retrySafe: false }, state: "released", code: null },
    { name: "transport failure", error: { message: "fetch failed", dispatchState: "provider_dispatch_ambiguous" }, state: "held", code: "provider_replay_unsafe" },
    { name: "stream interruption with id", error: { message: "stream ended", dispatchState: "provider_dispatch_ambiguous", providerRequestId: "req-stream" }, state: "held", code: "provider_replay_unsafe" },
    { name: "usage without output", error: { message: "provider failed", dispatchState: "provider_dispatch_ambiguous", providerRequestId: "req-usage", usage: { input: 100, output: 20, reasoning: 10, cached: 40, total: 120 } }, state: "settled", code: "provider_replay_unsafe" },
  ];
  for (const item of cases) {
    const reservations = memoryModelReservations();
    const provider = { model: "gpt-5.6-terra", provider: "openai", runTurn: async () => { throw Object.assign(new Error(item.error.message), item.error); } };
    const lanes = createModelLanes({
      provider, reservations, billingLane: "byok_api", ceilingCredits: 20, knowledgeStore: memoryKnowledgeStore(),
      providerForStep: async () => ({ provider, decision: { provider: "openai", model: provider.model, billingLane: "byok_api", estimatedCredits: 3, callCeilingCredits: 3 } }),
    });
    let caught = null;
    try { await call(lanes); } catch (error) { caught = error; }
    assert.ok(caught, item.name);
    if (item.code) assert.equal(caught.code, item.code, item.name);
    assert.equal(reservations.rows().length, 1, item.name);
    assert.equal(reservations.rows()[0].state, item.state, item.name);
  }
});

test("Package 13 BYOK and Codex reservations cannot become managed debits", async () => {
  for (const [providerId, model, lane] of [
    ["anthropic", "claude-sonnet-5", MODEL_LANES.byok],
    ["codex", "gpt-5.5", MODEL_LANES.codex],
  ]) {
    const reservations = memoryModelReservations();
    let managedAvailabilityReads = 0;
    const provider = {
      provider: providerId, model,
      runTurn: async () => ({ text: "", toolCalls: [{ id: "p", name: "emit_patches", arguments: { patches: [] } }],
        usage: { input: 100, cached: 40, output: 20, reasoning: 10, total: 120, providerRequestId: `${providerId}:proof` } }),
    };
    const lanes = createModelLanes({
      provider, reservations, billingLane: lane, ceilingCredits: 20, knowledgeStore: memoryKnowledgeStore(),
      accountCreditResolver: async () => { managedAvailabilityReads += 1; return 999; },
      providerForStep: async () => ({ provider, decision: { provider: providerId, model, billingLane: lane, estimatedCredits: 3, callCeilingCredits: 3 } }),
    });
    await call(lanes);
    const row = reservations.rows()[0];
    assert.equal(row.billingLane, lane);
    assert.equal(row.state, "settled");
    assert.equal(managedAvailabilityReads, 0);
    assert.equal(row.actualCredits, creditsForUsage({ usage: row.usage, model }));
  }
});

test("Package 13 step ceiling blocks before reserve or provider dispatch", async () => {
  const reservations = memoryModelReservations();
  let dispatches = 0;
  const provider = { provider: "openai", model: "gpt-5.6-sol", runTurn: async () => { dispatches += 1; } };
  const lanes = createModelLanes({
    provider, reservations, ceilingCredits: 50, knowledgeStore: memoryKnowledgeStore(),
    providerForStep: async () => ({ provider, decision: { provider: "openai", billingLane: "managed", estimatedCredits: 0.01, callCeilingCredits: 0.01 } }),
    accountCreditResolver: async () => 100,
  });
  await assert.rejects(call(lanes), (error) => error.code === "step_budget_ceiling");
  assert.equal(dispatches, 0);
  assert.equal(reservations.rows().length, 0);
});

test("Package 13 production canary is statically bounded away from providers, Stripe and ingress", () => {
  const source = readFileSync(new URL("../../ops/prove-package13-provider-billing-production.mjs", import.meta.url), "utf8");
  assert.match(source, /THRALLO_MANAGED_SETTLEMENT_PAUSED/);
  assert.match(source, /THRALLO_BUILD_WORKER_ENABLED/);
  assert.match(source, /THRALLO_ATOMIC_PUBLISH_ENABLED/);
  assert.doesNotMatch(source, /from ["'][^"']*(?:Provider|stripe|provision|caddy|atomicPublisher|child_process)[^"']*["']/i);
  assert.doesNotMatch(source, /create(?:OpenAI|Anthropic|Gemini|Xai|Codex)|provider\.runTurn|fetch\(/);
});

test("Package 13 capability runtime validates models and blocks managed dispatch while settlement is paused", () => {
  const runtime = readFileSync(new URL("../../shell/server/lib/capabilityRuntime.mjs", import.meta.url), "utf8");
  assert.match(runtime, /assertCapabilityModel/);
  assert.match(runtime, /RUNTIME_CAPABILITY_OPERATIONS/);
  const pauseGuard = runtime.indexOf('action.execution_mode === "managed" && managedSettlementPaused()');
  const dispatch = runtime.indexOf("return await finishJob(client, job, action, await execute(action, job, client))");
  assert.ok(pauseGuard > 0 && dispatch > pauseGuard, "managed pause must be checked before capability provider dispatch");
});

test("a no-migration dark deploy inherits only validated immutable ledger provenance", () => {
  const source = readFileSync(new URL("../../ops/create-deployment-manifest.mjs", import.meta.url), "utf8");
  assert.match(source, /validateDeploymentIdentity/);
  assert.match(source, /previous-manifest/);
  assert.match(source, /previous\.migrationLedgerCount/);
  assert.match(source, /previous\.migrationLedgerSha256/);
});
