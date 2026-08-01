// xAI/Grok provider: adapter contract, exact pricing (cached + long-context), admin
// policy, routing integration + fallback, cancellation, no-duplicate-charge accounting,
// and key-secrecy guards.

process.env.CODE_AGENT_STORE = "memory";

import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  XAI_MODELS, xaiModelMeta, xaiCostForUsage, xaiPolicy, xaiEligibleForAgent,
  xaiReasoningForTask, createXaiProvider, createXaiEngineProvider, normalizeXaiError,
} from "../../shell/server/lib/xaiProvider.mjs";
import { routeCandidates, createRoutedCodingModel } from "../../shell/server/lib/modelRouting.mjs";
import { resolveModelSelection } from "../../shell/server/lib/modelGateway.mjs";
import { creditsForUsage, modelWeight } from "../../src/billing/costModel.mjs";
import { providerForModel } from "../../shell/server/lib/appBuild/buildDiagnostics.mjs";

const okResponse = (usage = {}) => ({
  ok: true,
  json: async () => ({
    id: "r1",
    output: [{ type: "message", content: [{ type: "output_text", text: "hello" }] }],
    usage: { input_tokens: 1000, output_tokens: 100, total_tokens: 1100, input_tokens_details: { cached_tokens: 400 }, ...usage },
  }),
});

test("model catalog carries full metadata and provider inference maps grok -> xai", () => {
  for (const [id, meta] of Object.entries(XAI_MODELS)) {
    for (const field of ["contextLimit", "longContextThreshold", "usdPerMInput", "usdPerMCachedInput", "usdPerMOutput", "usdPerMInputLong", "usdPerMOutputLong", "reasoning", "tools"]) {
      assert.ok(field in meta, `${id}.${field}`);
    }
  }
  assert.equal(providerForModel("grok-4.5"), "xai");
  assert.equal(resolveModelSelection("xai:grok-4.5").provider, "xai");
  assert.equal(resolveModelSelection("grok-build-0.1").provider, "xai");
  assert.ok(modelWeight("grok-4.5") > modelWeight("grok-4.5-fast"), "weights follow pricing");
  assert.ok(creditsForUsage({ usage: { input: 10_000, output: 1_000, cached: 0, total: 11_000 }, model: "grok-4.5" }) > 0);
});

test("exact cost: cached tokens use the cached rate; long-context pricing kicks in at the threshold", () => {
  const meta = xaiModelMeta("grok-4.5");
  // Standard tier, half cached.
  const std = xaiCostForUsage({ model: "grok-4.5", inputTokens: 100_000, cachedTokens: 50_000, outputTokens: 10_000 });
  const expectedStd = (50_000 / 1e6) * meta.usdPerMInput + (50_000 / 1e6) * meta.usdPerMCachedInput + (10_000 / 1e6) * meta.usdPerMOutput;
  assert.equal(std.usd, Number(expectedStd.toFixed(6)));
  assert.equal(std.longContext, false);
  // One token over the threshold -> the whole request bills long-context rates.
  const long = xaiCostForUsage({ model: "grok-4.5", inputTokens: meta.longContextThreshold + 1, cachedTokens: 0, outputTokens: 1_000 });
  assert.equal(long.longContext, true);
  const expectedLong = ((meta.longContextThreshold + 1) / 1e6) * meta.usdPerMInputLong + (1_000 / 1e6) * meta.usdPerMOutputLong;
  assert.equal(long.usd, Number(expectedLong.toFixed(6)));
  assert.ok(long.usd > xaiCostForUsage({ model: "grok-4.5", inputTokens: meta.longContextThreshold + 1, cachedTokens: 0, outputTokens: 1_000, }).usd - 1e-9);
  // Credits accounting applies the cached multiplier (cheaper than uncached).
  const uncached = creditsForUsage({ usage: { input: 100_000, output: 0, cached: 0, total: 100_000 }, model: "grok-4.5" });
  const cached = creditsForUsage({ usage: { input: 100_000, output: 0, cached: 80_000, total: 100_000 }, model: "grok-4.5" });
  assert.ok(cached < uncached, "cached tokens bill at the reduced rate");
});

test("admin policy: enable/disable, per-agent gating, model allowlist, reasoning by task", () => {
  const env = { THRALLO_XAI_ENABLED: "0" };
  assert.equal(xaiPolicy(env).enabled, false);
  const scoped = xaiPolicy({ THRALLO_XAI_AGENTS: "edit,repair", THRALLO_XAI_MODELS: "grok-4.5-fast" });
  assert.equal(xaiEligibleForAgent("edit", scoped), true);
  assert.equal(xaiEligibleForAgent("build", scoped), false, "admin disabled Grok for builds");
  assert.equal(scoped.permittedModels.has("grok-4.5"), false);
  // Simple edits never pay for deep reasoning.
  assert.equal(xaiReasoningForTask("simple_edit"), "low");
  assert.equal(xaiReasoningForTask("bug_repair"), "medium");
  assert.notEqual(xaiReasoningForTask("full_build"), "low");
});

test("smart routing respects configuration and admin restrictions", () => {
  // Not configured -> grok never appears.
  delete process.env.XAI_API_KEY;
  const withoutKey = routeCandidates({ credential: { provider: "managed" }, policy: { routingMode: "balanced" } });
  assert.equal(withoutKey.some((c) => c.provider === "xai"), false);
  // Configured but admin-disabled -> still never appears.
  process.env.XAI_API_KEY = "xai-test-key-000000000000";
  process.env.THRALLO_XAI_ENABLED = "0";
  const disabled = routeCandidates({ credential: { provider: "managed" }, policy: { routingMode: "balanced" } });
  assert.equal(disabled.some((c) => c.provider === "xai"), false);
  delete process.env.THRALLO_XAI_ENABLED;
  // Configured + enabled -> grok joins the pool without displacing the default.
  const enabled = routeCandidates({ credential: { provider: "managed" }, policy: { routingMode: "balanced" } });
  assert.equal(enabled.some((c) => c.provider === "xai"), true);
  assert.notEqual(enabled[0].provider, "xai", "grok is never the assumed default");
  // BYOK xai credential -> only their grok connection is used.
  const byok = routeCandidates({ credential: { provider: "xai", secret: "xai-k" }, policy: {} });
  assert.equal(byok.length, 1);
  assert.equal(byok[0].provider, "xai");
  delete process.env.XAI_API_KEY;
});

test("provider fallback works and failed requests record zero usage (no duplicate charges)", async () => {
  const attempts = [];
  const fakeStore = { recordAttempt: async (_o, row) => { attempts.push(row); }, listRecentAttempts: async () => [] };
  process.env.XAI_API_KEY = "xai-test-key-000000000000";
  const factory = (candidate) => ({
    turn: async () => {
      if (candidate.provider === "openai") {
        const error = new Error("rate limited");
        error.status = 429;
        throw error;
      }
      return { text: "ok", output: [], usage: { inputTokens: 500, outputTokens: 50, totalTokens: 550 } };
    },
  });
  const model = await createRoutedCodingModel({
    owner: "o1", credential: { provider: "managed" }, requested: "auto",
    policy: { routingMode: "balanced", allowFallback: true },
    store: fakeStore, providerFactory: factory,
  });
  const response = await model.turn({ instructions: "x", input: [], tools: [] });
  assert.ok(response.routing.fallbackFrom, "fell back off the failing provider");
  const failed = attempts.filter((a) => a.status === "error");
  assert.ok(failed.length >= 1);
  assert.ok(failed.every((a) => a.input_tokens === 0 && a.output_tokens === 0), "failed attempts meter nothing");
  const success = attempts.filter((a) => a.status === "success");
  assert.equal(success.length, 1, "exactly one billable success recorded");
  delete process.env.XAI_API_KEY;
});

test("adapter: usage normalization, internal retry bills once, cancellation stops generation", async () => {
  // Retry: first attempt 503, second succeeds -> ONE usage result, retries counted.
  let calls = 0;
  const flaky = async () => {
    calls += 1;
    if (calls === 1) return { ok: false, status: 503, json: async () => ({ error: { message: "overloaded" } }) };
    return okResponse();
  };
  const provider = createXaiProvider({ apiKey: "xai-k-000000000000000000", model: "grok-4.5", fetchImpl: flaky });
  const out = await provider.turn({ instructions: "i", input: [], tools: [] });
  assert.equal(calls, 2);
  assert.equal(out.usage.inputTokens, 1000);
  assert.equal(out.usage.cachedTokens, 400);
  assert.equal(out.usage.retries, 1, "retry count surfaced; usage returned once");
  // Cancellation: an aborted signal stops before any network call.
  const controller = new AbortController();
  controller.abort();
  let networkCalls = 0;
  const spy = async () => { networkCalls += 1; return okResponse(); };
  const cancellable = createXaiProvider({ apiKey: "xai-k-000000000000000000", model: "grok-4.5", fetchImpl: spy, signal: controller.signal });
  await assert.rejects(cancellable.turn({ instructions: "i", input: [], tools: [] }), /cancelled/i);
  assert.equal(networkCalls, 0, "cancelled request never reaches the provider");
  // Error normalization.
  const err = normalizeXaiError({ error: { message: "bad key" } }, 401);
  assert.equal(err.code, "xai_key_rejected");
});

test("engine seam: tool calls round-trip and reasoning effort is attached for capable models", async () => {
  let sentBody = null;
  const capture = async (_url, options) => {
    sentBody = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({
        output: [{ type: "function_call", call_id: "c1", name: "write_file", arguments: JSON.stringify({ path: "a.js", contents: "x" }) }],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      }),
    };
  };
  const engine = createXaiEngineProvider({ apiKey: "xai-k-000000000000000000", model: "grok-build-0.1", reasoningEffort: "low", fetchImpl: capture });
  const turn = await engine.runTurn({ systemPrompt: "s", messages: [{ role: "user", content: "hi" }], tools: [{ name: "write_file", description: "d", parameters: {} }] });
  assert.equal(turn.toolCalls[0].name, "write_file");
  assert.equal(turn.toolCalls[0].arguments.path, "a.js");
  assert.equal(sentBody.reasoning.effort, "low");
  assert.equal(sentBody.store, false, "never stored provider-side");
  assert.equal(sentBody.model, "grok-build-0.1");
});

test("xAI keys never reach the browser, logs, or generated apps (source guards)", async () => {
  const read = (p) => readFile(fileURLToPath(new URL(p, import.meta.url)), "utf8");
  const adapter = await read("../../shell/server/lib/xaiProvider.mjs");
  assert.doesNotMatch(adapter, /console\.(log|error)\([^)]*key/i, "adapter never logs the key");
  const credStore = await read("../../shell/server/lib/aiCredentialStore.mjs");
  const publicShape = /function publicCredential[\s\S]*?\n\}/.exec(credStore)[0];
  assert.doesNotMatch(publicShape, /secret[^_h]/, "browser-facing credential shape carries hint only");
  assert.match(publicShape, /secret_hint/);
  const runtimeEnv = await read("../../shell/server/lib/runtimeEnv.mjs");
  assert.doesNotMatch(runtimeEnv, /XAI|xai/, "generated apps never receive xAI config");
  // Cross-user isolation: every credential read in the store is owner-filtered.
  const reads = (credStore.match(/from\("ca_ai_credentials"\)[\s\S]{0,200}?(?=;)/g) || [])
    .filter((q) => !q.includes(".upsert(")); // writes carry owner in the payload
  assert.ok(reads.length > 0);
  for (const q of reads) assert.match(q, /eq\("owner"/, "credential queries are owner-scoped");
});

test("every application provider is permitted by the database constraints", async () => {
  // A provider added in code but missing from the schema's CHECK constraints fails at
  // INSERT with an opaque 500 — exactly what happened to xai (PR #90 shipped the adapter,
  // the constraints still listed only the original providers). This guard keeps the
  // migrations in step with the application's provider list.
  const { readFile, readdir } = await import("node:fs/promises");
  const dir = fileURLToPath(new URL("../../supabase/migrations", import.meta.url));
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  let credentialConstraint = null;
  let preferenceConstraint = null;
  for (const file of files) {
    const sql = await readFile(`${dir}/${file}`, "utf8");
    for (const match of sql.matchAll(/ca_ai_credentials_provider_check[\s\S]*?check \(([^;]*?)\);/gi)) {
      credentialConstraint = match[1];
    }
    for (const match of sql.matchAll(/ca_ai_preferences_active_provider_check[\s\S]*?check \(([^;]*?)\);/gi)) {
      preferenceConstraint = match[1];
    }
  }
  assert.ok(credentialConstraint, "credential provider constraint found in migrations");
  assert.ok(preferenceConstraint, "preference provider constraint found in migrations");
  const { default: credStoreSource } = { default: await readFile(fileURLToPath(new URL("../../shell/server/lib/aiCredentialStore.mjs", import.meta.url)), "utf8") };
  const appProviders = /const API_KEY_PROVIDERS = new Set\(\[([^\]]+)\]\)/.exec(credStoreSource)[1]
    .split(",").map((s) => s.trim().replace(/['"]/g, "")).filter(Boolean);
  assert.ok(appProviders.includes("xai"), "xai is an application provider");
  for (const provider of appProviders) {
    assert.match(credentialConstraint, new RegExp(`'${provider}'`), `${provider} allowed by ca_ai_credentials constraint`);
    assert.match(preferenceConstraint, new RegExp(`'${provider}'`), `${provider} allowed by ca_ai_preferences constraint`);
  }
});
