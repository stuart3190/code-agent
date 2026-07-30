import assert from "node:assert/strict";
import test from "node:test";

process.env.CODE_AGENT_STORE = "memory";
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "test-openai";

const {
  buildCompletionPrompt, cleanCompletion, completeCode, completionRateAllowed,
  parseCompletionInput, resetCompletionRateForTests,
} = await import("../../shell/server/lib/completions.mjs");
const { MemoryCodeAgentStore } = await import("../../shell/server/lib/codeAgentStore.mjs");

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
  resetCompletionRateForTests();
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

test("managed completions are blocked when the token budget is spent; BYOK is not", async () => {
  resetCompletionRateForTests();
  const store = new MemoryCodeAgentStore();
  await store.upsertSubscription(OWNER, { managed_token_limit_override: 10 });
  await store.recordStandaloneUsage(OWNER, {
    billing_source: "managed", input_tokens: 8, output_tokens: 8, compute_seconds: 0,
  });
  const input = parseCompletionInput({ prefix: "const x = " });
  await assert.rejects(
    completeCode(OWNER, input, {
      store,
      credentialResolver: async () => ({ provider: "managed", secret: null }),
      providerFactory: fakeProvider("1;"),
    }),
    (error) => error.code === "budget_exceeded" && error.status === 402,
  );
  const byok = await completeCode(OWNER, input, {
    store,
    credentialResolver: async () => ({ provider: "openai", secret: "sk-user" }),
    providerFactory: fakeProvider("1;"),
  });
  assert.equal(byok.completion, "1;");
  assert.equal([...store.usageRecords.values()].at(-1).billing_source, "byok");
});

test("codex credentials fall back to managed models for completions", async () => {
  resetCompletionRateForTests();
  const store = new MemoryCodeAgentStore();
  const capture = {};
  const result = await completeCode(OWNER, parseCompletionInput({ prefix: "let y = " }), {
    store,
    credentialResolver: async () => ({ provider: "codex", secret: "{}" }),
    providerFactory: (candidate, credential) => {
      capture.candidate = candidate;
      capture.credential = credential;
      return fakeProvider("2;")();
    },
  });
  assert.equal(result.completion, "2;");
  assert.equal(capture.credential.provider, "managed");
  assert.equal(capture.candidate.tier, "fast");
});

test("the per-owner completion limiter rolls over a one-minute window", () => {
  resetCompletionRateForTests();
  process.env.CODE_AGENT_COMPLETIONS_PER_MINUTE = "2";
  const t0 = 1_000_000;
  assert.equal(completionRateAllowed("o1", t0), true);
  assert.equal(completionRateAllowed("o1", t0 + 1), true);
  assert.equal(completionRateAllowed("o1", t0 + 2), false);
  assert.equal(completionRateAllowed("o2", t0 + 3), true);
  assert.equal(completionRateAllowed("o1", t0 + 61_000), true);
  delete process.env.CODE_AGENT_COMPLETIONS_PER_MINUTE;
  resetCompletionRateForTests();
});

test("prompt building survives missing repository context", () => {
  const prompt = buildCompletionPrompt(
    { path: "a.py", language: "python", prefix: "def f():", suffix: "" },
    [],
  );
  assert.match(prompt, /File: a\.py \(python\)/);
  assert.match(prompt, /SUFFIX:\n\(end of file\)/);
});
