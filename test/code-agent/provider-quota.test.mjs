// Provider quota management: early plain-language warnings, real alternatives, automatic
// switching that resumes rather than restarts, honest copy when nothing else is available,
// and private diagnostics for every switch.

process.env.CODE_AGENT_STORE = "memory";

import assert from "node:assert/strict";
import test from "node:test";

import {
  providerHeadroom, thresholdCrossed, alternativeProviders, lowQuotaMessage,
  switchedMessage, exhaustedNoAlternativeMessage, providerBadge, modelLabel,
  recordProviderSwitch, WARN_THRESHOLDS,
} from "../../shell/server/lib/providerQuota.mjs";
import { announceQuotaState, processConversation } from "../../shell/server/lib/leadAgentService.mjs";
import { MemoryConversationStore } from "../../shell/server/lib/conversationStore.mjs";
import { applyEvent, emptyConversationView } from "../../shell/web/src/chat/conversationState.js";

const OWNER = "owner-1";
const TECHNICAL = /(429|5\d\d|rate.?limit exceeded|quota_exceeded|insufficient_quota|api key|token bucket|http)/i;

test("managed headroom is exact; BYOK headroom is an honest estimate", async () => {
  const exact = await providerHeadroom(OWNER, {
    provider: "managed",
    overview: { budgets: { managedTokens: { remaining: 150_000, limit: 1_000_000 } } },
  });
  assert.equal(exact.exact, true);
  assert.equal(exact.percentRemaining, 15);

  // No soft ceiling configured -> we say we don't know rather than inventing a number.
  delete process.env.THRALLO_BYOK_SOFT_CEILING_CREDITS;
  const unknown = await providerHeadroom(OWNER, { provider: "openai" });
  assert.equal(unknown.unknown, true);

  process.env.THRALLO_BYOK_SOFT_CEILING_CREDITS = "100";
  const db = { from: () => ({ select: () => ({ eq: function () { return this; }, gte: function () { return this; }, limit: async () => ({ data: [{ cost: 92 }] }) }) }) };
  const estimated = await providerHeadroom(OWNER, { provider: "openai", client: db });
  assert.equal(estimated.exact, false);
  assert.equal(estimated.estimated, true);
  assert.equal(estimated.percentRemaining, 8);
  delete process.env.THRALLO_BYOK_SOFT_CEILING_CREDITS;
});

test("thresholds fire at 20/10/5 once each, in order", () => {
  assert.deepEqual(WARN_THRESHOLDS, [20, 10, 5]);
  assert.equal(thresholdCrossed(25, []), null, "quiet above 20%");
  assert.equal(thresholdCrossed(18, []), 20);
  assert.equal(thresholdCrossed(18, [20]), null, "never repeats a band");
  assert.equal(thresholdCrossed(9, [20]), 10);
  assert.equal(thresholdCrossed(4, [20, 10]), 5);
  assert.equal(thresholdCrossed(null, []), null, "unknown headroom never warns");
});

test("alternatives list only providers the owner can actually reach", () => {
  assert.deepEqual(
    alternativeProviders({ current: "managed", credentials: [{ provider: "xai" }, { provider: "anthropic" }], managedAvailable: false }).sort(),
    ["anthropic", "xai"],
  );
  assert.deepEqual(alternativeProviders({ current: "openai", credentials: [], managedAvailable: true }), ["managed"]);
  assert.deepEqual(alternativeProviders({ current: "managed", credentials: [], managedAvailable: false }), [],
    "nothing connected -> no false promises");
  assert.equal(
    alternativeProviders({ current: "managed", credentials: [{ provider: "codex" }], managedAvailable: false }).length, 0,
    "Codex is not a build-time alternative",
  );
});

test("user-facing copy is natural, actionable and never technical", () => {
  const warn = lowQuotaMessage({ provider: "openai", percent: 10, alternatives: ["xai", "gemini", "anthropic"] });
  assert.match(warn, /Just a heads up/);
  assert.match(warn, /OpenAI budget is getting low \(about 10% remaining\)/);
  assert.match(warn, /Grok, Gemini, or Anthropic/);
  assert.match(warn, /continue using OpenAI until it's exhausted/);
  assert.doesNotMatch(warn, TECHNICAL);

  const alone = lowQuotaMessage({ provider: "openai", percent: 5, alternatives: [] });
  assert.match(alone, /no other provider connected/);
  assert.doesNotMatch(alone, TECHNICAL);

  const switched = switchedMessage({ from: "openai", to: "xai", toModel: "grok-4.5", reason: "quota" });
  assert.match(switched, /OpenAI has reached its limit/);
  assert.match(switched, /switched this build to Grok 4\.5/);
  assert.match(switched, /continued from the last successful step/);
  assert.doesNotMatch(switched, TECHNICAL);

  const stuck = exhaustedNoAlternativeMessage({ provider: "managed", kind: "quota" });
  assert.match(stuck, /nothing is lost/i);
  assert.match(stuck, /connect another provider|raise the limit|wait for the allowance/i);
  assert.match(stuck, /pick up exactly where I stopped/);
  assert.doesNotMatch(stuck, TECHNICAL);
  // Estimates are labelled as estimates, never presented as exact.
  assert.match(lowQuotaMessage({ provider: "xai", percent: 9, estimated: true, alternatives: [] }), /roughly 9%/);
});

test("badges name the model and mark switches and deep thinking", () => {
  assert.deepEqual(providerBadge({ provider: "openai", model: "gpt-5.6-terra" }), { icon: "🤖", text: "Building with GPT-5.6 Terra" });
  assert.deepEqual(providerBadge({ provider: "xai", model: "grok-4.5", switched: true }), { icon: "⚡", text: "Switched to Grok 4.5" });
  assert.deepEqual(providerBadge({ provider: "openai", model: "gpt-5.6-sol", mode: "deep" }), { icon: "🧠", text: "Using Deep Thinking mode" });
  assert.equal(modelLabel("grok-4.5"), "Grok 4.5");
  assert.equal(modelLabel("claude-sonnet-5"), "Claude sonnet 5");
});

test("warnings post once per band and offer the owner's real alternatives", async () => {
  const store = new MemoryConversationStore();
  const conversation = await store.createConversation(OWNER, { title: "t" });
  const emitted = [];
  const emit = async (type, payload) => { emitted.push({ type, payload }); await store.appendEvent(conversation, type, payload); };
  const quota = await import("../../shell/server/lib/providerQuota.mjs");
  const args = {
    store, conversation, emit, quota, owner: OWNER, provider: "managed",
    overviewResolver: async () => ({ budgets: { managedTokens: { remaining: 90_000, limit: 1_000_000 } } }),
    runStore: {},
    credentialStore: { listCredentials: async () => [{ provider: "xai" }] },
  };

  const first = await announceQuotaState(args);
  assert.equal(first.threshold, 10, "9% headroom crosses the 10% band");
  const message = emitted.find((e) => e.type === "message");
  assert.match(message.payload.text, /getting low \(about 9% remaining\)/);
  assert.match(message.payload.text, /Grok/, "offers the connected alternative");

  // Same band again -> silent (the durable event stream remembers).
  emitted.length = 0;
  assert.equal(await announceQuotaState(args), null);
  assert.equal(emitted.length, 0);

  // Dropping into the next band speaks again.
  const lower = await announceQuotaState({
    ...args,
    overviewResolver: async () => ({ budgets: { managedTokens: { remaining: 40_000, limit: 1_000_000 } } }),
  });
  assert.equal(lower.threshold, 5);
});

test("exhausted managed budget switches to a connected provider and resumes", async () => {
  const store = new MemoryConversationStore();
  const conversation = await store.createConversation(OWNER, { title: "build" });
  await store.appendTurn(conversation, { role: "user", content: "Build me a shop" });

  let turns = 0;
  await processConversation(conversation, {
    store,
    credentialResolver: async () => ({ provider: "managed", secret: null, routing: { allowFallback: true } }),
    overviewResolver: async () => ({ budgets: { managedTokens: { remaining: 0, limit: 1_000_000 } } }),
    credentialStoreFactory: () => ({ listCredentials: async () => [{ provider: "xai" }] }),
    modelFactory: async () => ({ turn: async () => { turns += 1; return { text: "Done.", output: [], usage: {} }; } }),
  });

  const events = await store.listEvents(OWNER, conversation.id, 0);
  const texts = events.filter((e) => e.type === "message").map((e) => e.payload.text);
  const all = texts.join("\n");
  assert.match(all, /switched this build to/i, "switched rather than hard-stopping");
  assert.match(all, /continued from the last successful step/);
  assert.doesNotMatch(all, TECHNICAL, "no raw provider/API detail");
  assert.equal(turns, 1, "the work continued — the build was not restarted");
  assert.match(all, /Done\./, "the original task completed");
});

test("no alternative -> plain explanation with a way forward, never a raw error", async () => {
  const store = new MemoryConversationStore();
  const conversation = await store.createConversation(OWNER, { title: "build" });
  await store.appendTurn(conversation, { role: "user", content: "Build me a shop" });
  await processConversation(conversation, {
    store,
    credentialResolver: async () => ({ provider: "managed", secret: null, routing: { allowFallback: true } }),
    overviewResolver: async () => ({ budgets: { managedTokens: { remaining: 0, limit: 1_000_000 } } }),
    credentialStoreFactory: () => ({ listCredentials: async () => [] }),
    modelFactory: async () => ({ turn: async () => ({ text: "unused", output: [], usage: {} }) }),
  });
  const events = await store.listEvents(OWNER, conversation.id, 0);
  const text = events.filter((e) => e.type === "message").map((e) => e.payload.text).join("\n");
  assert.match(text, /no other provider connected to switch to/);
  assert.match(text, /Everything done so far is saved/);
  assert.doesNotMatch(text, TECHNICAL);
});

test("every switch is recorded privately with its reason", async () => {
  const rows = [];
  const client = { from: () => ({ insert: async (v) => { rows.push(v); return { data: v, error: null }; } }) };
  const record = await recordProviderSwitch({
    owner: OWNER, conversationId: "c1", from: "openai", to: "xai",
    model: "grok-4.5", reason: "rate_limit", detail: "429 from upstream", client,
  });
  assert.equal(record.reason, "rate_limit");
  assert.equal(record.from, "openai");
  assert.equal(record.to, "xai");
  assert.equal(rows.length, 1, "captured into the private incident trail");
  assert.match(rows[0].message, /provider switch openai -> xai \(rate_limit\)/);
  // Unknown reasons are coerced, never stored raw.
  const coerced = await recordProviderSwitch({ owner: OWNER, from: "a", to: "b", reason: "something odd", client });
  assert.equal(coerced.reason, "quota");
});

test("the shell renders the badge and a switch receipt", () => {
  let view = emptyConversationView();
  view = applyEvent(view, { sequence: 1, type: "provider_badge", payload: { icon: "🤖", text: "Building with GPT-5.6 Terra" } });
  assert.deepEqual(view.badge, { icon: "🤖", text: "Building with GPT-5.6 Terra", switched: false });
  view = applyEvent(view, { sequence: 2, type: "provider_badge", payload: { icon: "⚡", text: "Switched to Grok 4.5", switched: true } });
  assert.equal(view.badge.switched, true);
  const receipt = view.items.find((i) => i.kind === "receipt");
  assert.match(receipt.text, /Switched to Grok 4\.5/);
});
