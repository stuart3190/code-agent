// Model selector: users only see providers they can actually use, unavailable models are
// unselectable, selections persist per project, switching affects future requests only,
// and fallback never happens silently.

process.env.CODE_AGENT_STORE = "memory";

import assert from "node:assert/strict";
import test from "node:test";

import {
  selectableModels, validateModelChoice, resolveConversationModel,
  parseModelPref, formatModelPref, modesForProvider, mapModeForProvider,
  modelStats, autoStrategy, MODES, STATS_MIN_SAMPLES,
} from "../../shell/server/lib/modelSelector.mjs";
import { providerOptionsForMode } from "../../shell/server/lib/modelRouting.mjs";
import { MemoryConversationStore } from "../../shell/server/lib/conversationStore.mjs";
import { postUserMessage } from "../../shell/server/lib/leadAgentService.mjs";

// Managed OpenAI is configured in the test env catalog only when the env key exists —
// pin the env so the catalog is deterministic.
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "sk-test-000000000000000000";
delete process.env.XAI_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.GEMINI_API_KEY;

test("users only see models from providers they have configured or the platform runs", () => {
  const none = selectableModels({ credentials: [] });
  assert.equal(none.options[0].value, "auto", "Auto is always first and default");
  assert.equal(none.options.some((o) => o.provider === "anthropic"), false, "no Anthropic key -> no Anthropic models");
  assert.equal(none.options.some((o) => o.provider === "xai"), false, "no xAI -> no Grok models");
  assert.ok(none.unconfigured.includes("anthropic"), "unconfigured providers listed for the Configure link");

  const withAnthropic = selectableModels({ credentials: [{ provider: "anthropic" }] });
  assert.ok(withAnthropic.options.some((o) => o.provider === "anthropic" && o.source === "Your API key"));
  const withCodex = selectableModels({ credentials: [{ provider: "codex" }] });
  const codex = withCodex.options.find((o) => o.provider === "codex");
  assert.equal(codex.source, "Included plan");
});

test("every option carries provider, source, label and relative cost; no secrets anywhere", () => {
  const catalog = selectableModels({ credentials: [{ provider: "anthropic" }] });
  for (const option of catalog.options) {
    assert.ok(option.provider && option.model && option.source && option.label !== undefined);
  }
  const flat = JSON.stringify(catalog);
  assert.doesNotMatch(flat, /sk-|xai-|AIza|secret|api_key/i, "catalog response carries no key material");
});

test("unavailable models cannot be selected", () => {
  const catalog = selectableModels({ credentials: [] });
  assert.throws(() => validateModelChoice(catalog, "anthropic:claude-opus-5"), /isn't available/);
  assert.throws(() => validateModelChoice(catalog, "xai:grok-4.5"), /isn't available/);
  assert.equal(validateModelChoice(catalog, "auto"), "auto");
  const openai = catalog.options.find((o) => o.provider === "openai");
  assert.equal(validateModelChoice(catalog, openai.value), openai.value);
});

test("the selected model is stored against the project at creation", async () => {
  const store = new MemoryConversationStore();
  const { conversation } = await postUserMessage("owner-1", {
    text: "Build me a store", modelPref: `openai:${selectableModels({ credentials: [] }).options[1].model}`,
  }, { store, processOptions: { modelFactory: async () => ({ turn: async () => ({ text: "ok", output: [], usage: {} }) }) } });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const stored = await store.getConversationIncludingDeleted("owner-1", conversation.id);
  assert.match(String(stored.model_pref || ""), /^openai:/, "preference stored on the conversation row");
});

test("switching models affects future requests only — history, events and state untouched", async () => {
  const store = new MemoryConversationStore();
  const conversation = await store.createConversation("owner-1", { title: "t" });
  await store.appendTurn(conversation, { role: "user", content: "hello" });
  await store.appendEvent(conversation, "message", { role: "user", text: "hello" });
  const turnsBefore = (await store.listTurns("owner-1", conversation.id, { limit: 50 })).length;
  const eventsBefore = (await store.listEvents("owner-1", conversation.id, 0)).length;
  await store.updateConversation(conversation, { model_pref: "openai:gpt-5.6-terra" });
  assert.equal((await store.listTurns("owner-1", conversation.id, { limit: 50 })).length, turnsBefore, "no turns added or removed");
  assert.equal((await store.listEvents("owner-1", conversation.id, 0)).length, eventsBefore, "no events replayed or reset");
  const row = await store.getConversation("owner-1", conversation.id);
  assert.equal(row.model_pref, "openai:gpt-5.6-terra");
  assert.notEqual(row.state, "thinking", "no build or processing was triggered");
});

test("automatic fallback only occurs when enabled — never silently", () => {
  const catalog = { options: [{ value: "auto", available: true }], allowFallback: false };
  const blocked = resolveConversationModel({ model_pref: "xai:grok-4.5" }, catalog);
  assert.equal(blocked.requested, null, "no silent switch");
  assert.match(blocked.warning, /fallback is off/i);
  assert.match(blocked.warning, /Auto/, "offers the escape hatches");

  const withFallback = resolveConversationModel({ model_pref: "xai:grok-4.5" }, { ...catalog, allowFallback: true });
  assert.equal(withFallback.requested, "auto", "falls back when the user enabled it");
  assert.match(withFallback.notice, /automatic fallback is enabled/i, "and says so visibly");

  const healthy = resolveConversationModel({ model_pref: "openai:gpt-5.6-terra" }, {
    options: [{ value: "openai:gpt-5.6-terra", available: true }], allowFallback: false,
  });
  assert.equal(healthy.requested, "openai:gpt-5.6-terra");
  assert.equal(healthy.warning, null);
});

test("providers and models load dynamically from adapter metadata (no hardcoded UI list)", () => {
  const catalog = selectableModels({ credentials: [{ provider: "anthropic" }] });
  const ids = catalog.providers.map((p) => p.id);
  assert.deepEqual(ids.slice(0, 1), ["auto"], "Auto first");
  for (const id of ["openai", "anthropic", "gemini", "xai"]) assert.ok(ids.includes(id), `${id} present`);
  const anthropic = catalog.providers.find((p) => p.id === "anthropic");
  assert.equal(anthropic.available, true);
  assert.ok(anthropic.models.length >= 2, "models come from the adapter meta");
  const gemini = catalog.providers.find((p) => p.id === "gemini");
  assert.equal(gemini.available, false);
  assert.equal(gemini.configure, true, "unconfigured -> Configure provider, never selectable");
  // Env-config change flows straight into the catalog — no code change for new models.
  process.env.OPENAI_BALANCED_MODEL = "gpt-9.9-nova";
  const updated = selectableModels({ credentials: [] });
  assert.ok(updated.providers.find((p) => p.id === "openai").models.some((m) => m.id === "gpt-9.9-nova"));
  delete process.env.OPENAI_BALANCED_MODEL;
});

test("modes: full vocabulary, per-provider support, unsupported modes map to closest", () => {
  assert.deepEqual(MODES.map((m) => m.id), ["fast", "balanced", "deep", "cheapest", "max_quality"]);
  assert.ok(modesForProvider("openai").some((m) => m.id === "deep"));
  assert.equal(modesForProvider("gemini").some((m) => m.id === "deep"), false, "unsupported mode hidden for gemini");
  // Adapter mapping: openai deep -> high reasoning effort; xai fast -> low.
  assert.equal(mapModeForProvider("openai", "deep").reasoningEffort, "high");
  assert.equal(mapModeForProvider("xai", "fast").reasoningEffort, "low");
  // Routing-layer options never leak tier hints into provider constructors.
  assert.deepEqual(providerOptionsForMode("anthropic", "deep"), {}, "tierHint stripped — steering happens in tier selection");
  assert.equal(providerOptionsForMode("openai", "deep").reasoningEffort, "high");
  // Validation coerces an unsupported mode to balanced instead of storing nonsense.
  process.env.GEMINI_API_KEY = "AIza-test-000000000000";
  const catalog = selectableModels({ credentials: [{ provider: "gemini" }] });
  const geminiModel = catalog.options.find((o) => o.provider === "gemini");
  const stored = validateModelChoice(catalog, `${geminiModel.value}#deep`);
  assert.equal(stored, geminiModel.value, "gemini has no deep mode -> falls back to balanced (no suffix)");
  delete process.env.GEMINI_API_KEY;
});

test("preference format round-trips provider, model and mode", () => {
  assert.deepEqual(parseModelPref("auto"), { value: "auto", mode: "balanced" });
  assert.deepEqual(parseModelPref("openai:gpt-5.6-terra#deep"), { value: "openai:gpt-5.6-terra", mode: "deep" });
  assert.equal(formatModelPref("openai:gpt-5.6-terra", "deep"), "openai:gpt-5.6-terra#deep");
  assert.equal(formatModelPref("openai:gpt-5.6-terra", "balanced"), "openai:gpt-5.6-terra");
  const catalog = selectableModels({ credentials: [] });
  const openai = catalog.options.find((o) => o.provider === "openai");
  assert.equal(validateModelChoice(catalog, `${openai.value}#deep`), `${openai.value}#deep`);
  const resolved = resolveConversationModel({ model_pref: `${openai.value}#deep` }, catalog);
  assert.equal(resolved.requested, openai.value);
  assert.equal(resolved.mode, "deep", "mode reaches the routing policy");
});

test("benchmark stats aggregate from real telemetry and gate on sample count", async () => {
  const rows = [];
  for (let i = 0; i < 6; i += 1) {
    rows.push({ model: "gpt-5.6-terra", status: i === 0 ? "failed" : "passed", duration_ms: 30_000, totals: { cost: 1.2 }, repair_rounds: i === 0 ? 2 : 0 });
  }
  rows.push({ model: "grok-4.5", status: "passed", duration_ms: 20_000, totals: { cost: 0.5 }, repair_rounds: 0 });
  const fakeDb = { from: () => ({ select: () => ({ order: () => ({ limit: async () => ({ data: rows }) }) }) }) };
  const stats = await modelStats({ client: fakeDb });
  const terra = stats["gpt-5.6-terra"];
  assert.equal(terra.samples, 6);
  assert.equal(terra.successRate, Number(((5 / 6) * 100).toFixed(1)));
  assert.equal(terra.avgCostCredits, 1.2);
  assert.equal(terra.avgDurationMs, 30_000);
  assert.ok(stats["grok-4.5"].collecting, `under ${STATS_MIN_SAMPLES} samples -> "Collecting benchmark data"`);
});

test("Auto explanation reflects the real routing decision and measured stats", () => {
  const stats = { "gpt-5.6-sol": { successRate: 98.9, samples: 40, avgCostCredits: 1.1, avgDurationMs: 38_000, avgRepairRounds: 0.2 } };
  const strategy = autoStrategy({ credential: { provider: "managed" }, routing: { routingMode: "balanced" }, stats: {} });
  assert.ok(strategy.provider && strategy.model, "explains a concrete provider+model");
  assert.equal(strategy.mode, "balanced");
  // Provider Intelligence uses the mandated wording when there isn't enough evidence.
  assert.match(strategy.reason, /Collecting benchmark data/i, "honest before data exists");
  assert.equal(strategy.learned, false);
  const measured = autoStrategy({ credential: { provider: "managed" }, routing: { routingMode: "quality" }, stats });
  if (measured.model === "gpt-5.6-sol") {
    assert.match(measured.reason, /98\.9% verified/, "measured reason quotes real telemetry");
  }
});

test("model usage flows into routing accounting with the requested model", async () => {
  // createRoutedCodingModel with requested != auto pins the exact candidate — the same
  // model string that lands in ai_requests / routing attempts.
  const { routeCandidates } = await import("../../shell/server/lib/modelRouting.mjs");
  const pinned = routeCandidates({ credential: { provider: "managed" }, requested: "openai:gpt-5.6-terra", policy: {} });
  assert.equal(pinned.length, 1);
  assert.equal(pinned[0].model, "gpt-5.6-terra");
});
