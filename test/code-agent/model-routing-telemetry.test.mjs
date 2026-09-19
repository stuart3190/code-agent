import { test } from "node:test";
import assert from "node:assert/strict";

import { createRoutedCodingModel } from "../../shell/server/lib/modelRouting.mjs";

/*
 * THR-04DC8D: a conversation failed and left NO provider attempt row, so the
 * only failure mode that permanently blocks a conversation was also the one
 * that recorded nothing about why. The cause was ordering, not logic - the
 * catch block settled billing before it wrote telemetry, and dispatchFailed
 * throwing (provider_replay_unsafe) skipped everything after it.
 *
 * These tests pin the ordering. They must fail if recordAttempt is ever moved
 * back below the settlement call.
 */

function fakeStore() {
  const attempts = [];
  return {
    attempts,
    async listRecentAttempts() { return []; },
    async recordAttempt(owner, row) { attempts.push({ owner, ...row }); },
  };
}

function throwingProvider(error) {
  return () => ({ async turn() { throw error; } });
}

async function routed({ store, providerFactory }) {
  return createRoutedCodingModel({
    owner: "owner-1",
    run: { id: "run-1", prompt: "build me a thing" },
    credential: { provider: "codex", auth_mode: "chatgpt" },
    requested: "connected_allowance:codex:gpt-5.5",
    policy: { allowFallback: false },
    store,
    providerFactory,
    intelligence: null,
  });
}

test("attempt telemetry is recorded even when dispatchFailed throws", async () => {
  const store = fakeStore();
  const providerError = Object.assign(new Error("no auth file"), { code: "ENOENT" });
  const model = await routed({ store, providerFactory: throwingProvider(providerError) });

  const settlementError = Object.assign(new Error("replay unsafe"), { code: "provider_replay_unsafe" });
  await assert.rejects(
    model.turn({
      messages: [],
      beforeDispatch: async () => ({ reservationId: "res-1" }),
      dispatchFailed: async () => { throw settlementError; },
    }),
    (thrown) => thrown.code === "provider_replay_unsafe",
  );

  assert.equal(store.attempts.length, 1, "the failed attempt must still be recorded");
  assert.equal(store.attempts[0].status, "error");
  assert.equal(store.attempts[0].error_code, "ENOENT");
});

test("settlement failure carries the provider error that caused it", async () => {
  const store = fakeStore();
  const providerError = Object.assign(new Error("no auth file"), { code: "ENOENT" });
  const model = await routed({ store, providerFactory: throwingProvider(providerError) });

  await assert.rejects(
    model.turn({
      messages: [],
      beforeDispatch: async () => ({ reservationId: "res-1" }),
      dispatchFailed: async () => { throw new Error("settlement exploded"); },
    }),
    (thrown) => {
      assert.equal(thrown.code, "billing_settlement_failed");
      assert.equal(thrown.providerError, providerError, "incident evidence must reach the shield");
      return true;
    },
  );
});

test("a plain provider failure still records telemetry and rethrows the provider error", async () => {
  const store = fakeStore();
  const providerError = Object.assign(new Error("upstream 500"), { code: "provider_error" });
  const model = await routed({ store, providerFactory: throwingProvider(providerError) });

  await assert.rejects(
    model.turn({ messages: [], beforeDispatch: async () => ({ reservationId: "res-1" }), dispatchFailed: async () => {} }),
    (thrown) => thrown === providerError,
  );
  assert.equal(store.attempts.length, 1);
  assert.equal(store.attempts[0].error_code, "provider_error");
});

test("a successful turn records exactly one success attempt", async () => {
  const store = fakeStore();
  const model = await routed({
    store,
    providerFactory: () => ({ async turn() { return { text: "ok", usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 } }; } }),
  });

  const response = await model.turn({ messages: [], beforeDispatch: async () => ({ reservationId: "res-1" }), afterDispatch: async () => {} });
  assert.equal(response.text, "ok");
  assert.equal(store.attempts.length, 1);
  assert.equal(store.attempts[0].status, "success");
  assert.equal(store.attempts[0].total_tokens, 7);
});
