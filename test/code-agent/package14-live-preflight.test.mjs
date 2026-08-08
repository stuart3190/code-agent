import assert from "node:assert/strict";
import test from "node:test";

import { createStoredAccessTokenProvider } from "../../src/providers/auth.mjs";
import { conservativeCallReservation, createModelLanes } from "../../shell/server/lib/builderV2/modelLanes.mjs";
import { memoryModelReservations } from "../../shell/server/lib/builderV2/modelReservations.mjs";

const jwt = (exp) => `x.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.y`;

test("Package 14 Codex auth refreshes owner-scoped stored state without filesystem auth", async () => {
  let stored = { auth_mode: "chatgpt", tokens: {
    access_token: jwt(1), refresh_token: "refresh-old", account_id: "account-1",
  } };
  let persisted = 0;
  const provider = createStoredAccessTokenProvider({
    loadAuth: async () => stored,
    persistAuth: async (next) => { stored = structuredClone(next); persisted += 1; },
    now: () => 2_000_000,
    fetchImpl: async () => ({ ok: true, json: async () => ({
      access_token: jwt(9_999_999), refresh_token: "refresh-rotated",
    }) }),
  });
  const token = await provider();
  assert.equal(token.accountId, "account-1");
  assert.equal(token.accessToken, stored.tokens.access_token);
  assert.equal(stored.tokens.refresh_token, "refresh-rotated");
  assert.equal(persisted, 1);
});

test("Package 14 step output policy bounds the network request and reservation", async () => {
  const reservations = memoryModelReservations();
  const seen = [];
  const provider = { provider: "codex", model: "gpt-5.5", runTurn: async (options) => {
    seen.push(options.maxOutputTokens);
    return { text: JSON.stringify({
      summary: "A one page site", projectType: "landing",
      journeys: [{ id: "view", title: "Visitor views the page", priority: "primary", stage: "primary_journey",
        steps: [{ action: "open the page", expect: "the heading is visible" }, { action: "read the page", expect: "the introduction is visible" }],
        acceptance: ["the heading is visible"] }],
      routes: [{ path: "/", name: "Home", purpose: "introduce the site", auth: false }],
      entities: [], auth: { required: false, model: null, rules: [] }, operations: [], integrations: [],
      states: [], acceptance: [
        { id: "a1", statement: "the heading is visible", journey: "view", kind: "ui" },
        { id: "a2", statement: "the introduction is visible", journey: "view", kind: "ui" },
        { id: "a3", statement: "the page is responsive", journey: "view", kind: "ui" },
      ], deferred: [],
    }), toolCalls: [], usage: { input: 100, output: 20, total: 120 } };
  } };
  const lanes = createModelLanes({
    providerForStep: async () => ({ provider, decision: {
      provider: "codex", model: "gpt-5.5", billingLane: "connected_allowance",
      estimatedCredits: 0.2, callCeilingCredits: 1, maxOutputTokens: 2_000,
    } }),
    ceilingCredits: 2, reservations, billingLane: "connected_allowance",
  });
  await lanes.contractFn({ owner: "o", projectId: "p", buildId: "b", request: "one page" });
  assert.ok(seen.length >= 1);
  assert.ok(seen.every((value) => value === 2_000));
  assert.ok(reservations.rows().every((row) => row.state === "settled"));
  assert.ok(reservations.rows().every((row) => row.reservedCredits <= 1));
});

test("Package 14 conservative reservation remains above the bounded worst-case usage", () => {
  const reserve = conservativeCallReservation({ systemPrompt: "s", messages: [{ role: "user", content: "x" }] }, "gpt-5.5", {
    maxOutputTokens: 2_000, minimumCredits: 0.2,
  });
  assert.ok(reserve >= 0.2 && reserve < 1);
});
