// Model selector: users only see providers they can actually use, unavailable models are
// unselectable, selections persist per project, switching affects future requests only,
// and fallback never happens silently.

process.env.CODE_AGENT_STORE = "memory";

import assert from "node:assert/strict";
import test from "node:test";

import { selectableModels, validateModelChoice, resolveConversationModel } from "../../shell/server/lib/modelSelector.mjs";
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

test("model usage flows into routing accounting with the requested model", async () => {
  // createRoutedCodingModel with requested != auto pins the exact candidate — the same
  // model string that lands in ai_requests / routing attempts.
  const { routeCandidates } = await import("../../shell/server/lib/modelRouting.mjs");
  const pinned = routeCandidates({ credential: { provider: "managed" }, requested: "openai:gpt-5.6-terra", policy: {} });
  assert.equal(pinned.length, 1);
  assert.equal(pinned[0].model, "gpt-5.6-terra");
});
