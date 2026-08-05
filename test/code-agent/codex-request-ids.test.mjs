// Codex request/turn identifiers — run cf130c23 recorded provider_request_ids: 0 across all six
// calls, because the transport declared providerRequestId and never assigned it.
//
// The transport now persists the strongest STABLE identifiers the ChatGPT backend actually
// exposes, typed so they can never be mistaken for OpenAI-platform request ids:
//   codex:response:<id> — the response object id (arrives on response.created / response.completed)
//   codex:request:<id>  — the HTTP x-request-id header
// and NOTHING is invented when the backend provides neither.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createCodexProvider } from "../../src/providers/codexProvider.mjs";
import { createTelemetry } from "../../src/engine/telemetry.mjs";

const token = async () => ({ accessToken: "test-token", accountId: "test-account" });

function sse(events) {
  const payload = events.map((e) => `data: ${JSON.stringify(e)}\n`).join("\n") + "\ndata: [DONE]\n\n";
  return {
    async *[Symbol.asyncIterator]() { yield Buffer.from(payload); },
  };
}

function fakeResponse({ ok = true, status = 200, headers = {}, events = [], failMidStream = false } = {}) {
  const body = failMidStream
    ? {
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(`data: ${JSON.stringify(events[0])}\n\n`);
        throw new Error("stream reset by peer");
      },
    }
    : sse(events);
  return {
    ok, status, body,
    headers: { get: (name) => headers[String(name).toLowerCase()] || null },
    text: async () => "backend error body",
  };
}

const completed = (id, usage = { input_tokens: 100, output_tokens: 10, total_tokens: 110 }) =>
  ({ type: "response.completed", response: { id, usage } });
const created = (id) => ({ type: "response.created", response: { id } });

function providerFor(responses) {
  let call = 0;
  return createCodexProvider({ tokenProvider: token, fetchImpl: async () => responses[Math.min(call++, responses.length - 1)] });
}

test("one Codex call records the typed response id when the backend provides one", async () => {
  const provider = providerFor([fakeResponse({ events: [created("resp_A"), completed("resp_A")] })]);
  const { usage } = await provider.runTurn({ systemPrompt: "s", messages: [{ role: "user", content: "hi" }] });
  assert.equal(usage.providerRequestId, "codex:response:resp_A");
  assert.equal(usage.total, 110, "usage still parsed alongside the id");
});

test("six calls do not record zero identifiers — every turn carries its own", async () => {
  const provider = providerFor(
    Array.from({ length: 6 }, (_, i) => fakeResponse({ events: [created(`resp_${i}`), completed(`resp_${i}`)] })),
  );
  const telemetry = createTelemetry();
  for (let i = 0; i < 6; i += 1) {
    const { usage } = await provider.runTurn({ systemPrompt: "s", messages: [{ role: "user", content: "hi" }] });
    telemetry.record(usage);
  }
  const ids = telemetry.summary().providerRequestIds;
  assert.equal(ids.length, 6, `recorded: ${ids.join(", ")}`);
  assert.equal(new Set(ids).size, 6, "retried turns record DISTINCT identifiers");
  assert.ok(ids.every((id) => id.startsWith("codex:response:")));
});

test("duplicate deliveries of the same id stay idempotent in telemetry", async () => {
  const telemetry = createTelemetry();
  const usage = { input: 10, output: 1, reasoning: 0, cached: 0, total: 11, providerRequestId: "codex:response:resp_dup" };
  telemetry.record(usage);
  telemetry.record(usage);
  assert.deepEqual(telemetry.summary().providerRequestIds, ["codex:response:resp_dup"]);
  assert.equal(telemetry.summary().turns, 2, "the turns themselves still both count — only the id deduplicates");
});

test("within one stream, created + completed carrying the same id record it once", async () => {
  const provider = providerFor([fakeResponse({ events: [created("resp_B"), completed("resp_B")] })]);
  const { usage } = await provider.runTurn({ systemPrompt: "s", messages: [{ role: "user", content: "hi" }] });
  // providerRequestId is a single field per turn — two sightings of the same id cannot double it.
  assert.equal(usage.providerRequestId, "codex:response:resp_B");
});

test("a failed call retains its identifier when the backend opened a response", async () => {
  // HTTP-level failure: the x-request-id header is the only handle — kept on the error.
  const httpFail = providerFor([fakeResponse({ ok: false, status: 500, headers: { "x-request-id": "rid-1" } })]);
  await assert.rejects(
    httpFail.runTurn({ systemPrompt: "s", messages: [{ role: "user", content: "hi" }] }),
    (error) => error.providerRequestId === "codex:request:rid-1" && /codex:request:rid-1/.test(error.message),
  );

  // Stream death AFTER response.created: the turn happened; its response id survives on the error.
  const midFail = providerFor([fakeResponse({ events: [created("resp_C")], failMidStream: true })]);
  await assert.rejects(
    midFail.runTurn({ systemPrompt: "s", messages: [{ role: "user", content: "hi" }] }),
    (error) => error.providerRequestId === "codex:response:resp_C",
  );
});

test("no identifier is invented when the backend provides none", async () => {
  const provider = providerFor([
    fakeResponse({ events: [{ type: "response.completed", response: { usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 } } }] }),
  ]);
  const { usage } = await provider.runTurn({ systemPrompt: "s", messages: [{ role: "user", content: "hi" }] });
  assert.equal(usage.providerRequestId, null);
  const telemetry = createTelemetry();
  telemetry.record(usage);
  assert.deepEqual(telemetry.summary().providerRequestIds, []);
});
