import assert from "node:assert/strict";
import test from "node:test";

process.env.CODE_AGENT_STORE = "memory";
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-openai";

const {
  buildCompletionPrompt, cleanCompletion, completeCode, parseCompletionInput,
} = await import("../../shell/server/lib/completions.mjs");
const { MemoryCodeAgentStore } = await import("../../shell/server/lib/codeAgentStore.mjs");
const { memoryDirectModelReservations } = await import("../../shell/server/lib/directModelReservations.mjs");
const { DISPATCH_STATES, providerFailure } = await import("../../shell/server/lib/providerOutcome.mjs");

const OWNER = "66666666-6666-4666-8666-666666666666";

function fakeProvider(text, capture = {}) {
  return () => ({
    async turn(args) {
      capture.args = args;
      return { text, output: [], usage: { inputTokens: 40, outputTokens: 12, totalTokens: 52 } };
    },
  });
}

test("input validation bounds the prefix/suffix and requires content", () => {
  const parsed = parseCompletionInput({
    prefix: `${"x".repeat(10_000)}tail`, suffix: "y".repeat(5_000), path: "src/a.ts", language: "typescript",
  });
  assert.equal(parsed.prefix.length, 6_000);
  assert.ok(parsed.prefix.endsWith("tail"));
  assert.equal(parsed.suffix.length, 2_000);
  assert.throws(() => parseCompletionInput({ prefix: "   " }), /prefix is required/);
});

test("completion cleaning strips fences, trailing space, and runaway length", () => {
  assert.equal(cleanCompletion("```js\nreturn x;\n```"), "return x;");
  assert.equal(cleanCompletion("\n  const a = 1;  \n"), "  const a = 1;");
  assert.equal(cleanCompletion(Array.from({ length: 30 }, (_, i) => `l${i}`).join("\n")).split("\n").length, 15);
});

test("a completion call meters standalone usage and injects index context", async () => {
  const store = new MemoryCodeAgentStore();
  const repository = await store.createRepository(OWNER, {
    provider: "github", full_name: "o/r", clone_url: "https://github.com/o/r.git",
    default_branch: "main", private: true,
  });
  const capture = {};
  const result = await completeCode(OWNER, parseCompletionInput({
    repositoryFullName: "O/R", path: "src/a.ts", language: "typescript",
    prefix: "function add(a, b) {\n  return ", suffix: "\n}",
  }), {
    store,
    credentialResolver: async () => ({ provider: "managed", secret: null }),
    providerFactory: fakeProvider("a + b;", capture),
    contextRetriever: async (owner, repoId) => {
      assert.equal(repoId, repository.id);
      return [{ path: "src/math.ts", startLine: 1, endLine: 4, content: "export const add = ..." }];
    },
  });
  assert.equal(result.completion, "a + b;");
  assert.equal(result.contextExcerpts, 1);
  assert.match(capture.args.input[0].content, /Repository excerpt src\/math\.ts/);
  assert.match(capture.args.input[0].content, /PREFIX:/);
  const usage = [...store.usageRecords.values()];
  assert.equal(usage.length, 1);
  assert.equal(usage[0].run_id, null);
  assert.equal(usage[0].billing_source, "managed");
  assert.equal(usage[0].metadata.kind, "completion");
});

test("managed completions fail before dispatch when included and purchased credits are spent; BYOK is not", async () => {
  const store = new MemoryCodeAgentStore();
  const reservations = memoryDirectModelReservations({
    balanceResolver: async () => ({ included: 0, purchased: 0 }),
    runStore: store,
  });
  const input = parseCompletionInput({ prefix: "const x = " });
  let managedProviderCalled = false;
  await assert.rejects(
    completeCode(OWNER, input, {
      store,
      credentialResolver: async () => ({ provider: "managed", secret: null }),
      reservationStoreFactory: () => reservations,
      providerFactory: () => ({ async turn() { managedProviderCalled = true; return { text: "1;" }; } }),
    }),
    (error) => error.code === "budget_exceeded" && error.status === 402,
  );
  assert.equal(managedProviderCalled, false);
  const byok = await completeCode(OWNER, input, {
    store,
    credentialResolver: async () => ({ provider: "openai", secret: "sk-user" }),
    providerFactory: fakeProvider("1;"),
  });
  assert.equal(byok.completion, "1;");
  assert.equal([...store.usageRecords.values()].at(-1).billing_source, "byok");
});

test("managed completions dispatch against purchased credits after included allowance is exhausted", async () => {
  const store = new MemoryCodeAgentStore();
  const reservations = memoryDirectModelReservations({
    balanceResolver: async () => ({ included: 0, purchased: 100 }),
    runStore: store,
  });
  let providerCalls = 0;
  const result = await completeCode(OWNER, parseCompletionInput({ prefix: "const topup = " }), {
    store,
    credentialResolver: async () => ({ provider: "managed", secret: null }),
    reservationStoreFactory: () => reservations,
    providerFactory: (candidate) => ({
      id: candidate.provider,
      model: candidate.model,
      async turn() {
        providerCalls += 1;
        return { id: "req_topup", text: "true;", output: [], usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } };
      },
    }),
  });
  assert.equal(result.completion, "true;");
  assert.equal(providerCalls, 1);
  const [reservation] = reservations.rows();
  assert.equal(reservation.state, "settled");
  assert.ok(reservation.purchasedReservedCredits > 0);
  assert.equal(reservation.includedReservedCredits, 0);
  assert.equal([...store.usageRecords.values()].length, 0,
    "purchased settlement must not also insert aggregate managed usage");
});

test("an ambiguous managed completion retains its hold and cannot be post-hoc metered", async () => {
  const store = new MemoryCodeAgentStore();
  const reservations = memoryDirectModelReservations({ runStore: store });
  let providerCalls = 0;
  await assert.rejects(
    completeCode(OWNER, parseCompletionInput({ prefix: "const answer = " }), {
      store,
      credentialResolver: async () => ({ provider: "managed", secret: null }),
      reservationStoreFactory: () => reservations,
      providerFactory: (candidate) => ({
        id: candidate.provider,
        model: candidate.model,
        async turn() {
          providerCalls += 1;
          assert.equal(reservations.rows()[0].state, "held", "reservation exists before provider dispatch");
          throw providerFailure(new Error("connection lost"), {
            state: DISPATCH_STATES.ambiguous,
            providerRequestId: "req_completion_ambiguous",
          });
        },
      }),
    }),
    (error) => error.code === "provider_replay_unsafe",
  );
  assert.equal(providerCalls, 1);
  const [hold] = reservations.rows();
  assert.equal(hold.state, "held");
  assert.equal(hold.reconciliationState, "pending");
  assert.deepEqual(hold.providerRequestIds, ["req_completion_ambiguous"]);
  assert.equal([...store.usageRecords.values()].length, 0);
});

test("codex credentials do NOT fall back to managed models for completions", async () => {
  // This test used to assert the silent codex→managed rewrite — the same lane substitution that
  // ran four managed lead-agent turns during a Codex-only build. The policy forbids it: a
  // Codex-selected account is never quietly rebilled to managed, so inline completion is
  // unavailable rather than mis-billed.
  const store = new MemoryCodeAgentStore();
  let providerCalled = false;
  await assert.rejects(
    completeCode(OWNER, parseCompletionInput({ prefix: "let y = " }), {
      store,
      credentialResolver: async () => ({ provider: "codex", secret: "{}" }),
      providerFactory: () => { providerCalled = true; return fakeProvider("2;")(); },
    }),
    (error) => error.code === "completion_unavailable",
  );
  assert.equal(providerCalled, false, "no model is dispatched on any lane");
});

test("prompt building survives missing repository context", () => {
  const prompt = buildCompletionPrompt(
    { path: "a.py", language: "python", prefix: "def f():", suffix: "" },
    [],
  );
  assert.match(prompt, /File: a\.py \(python\)/);
  assert.match(prompt, /SUFFIX:\n\(end of file\)/);
});
