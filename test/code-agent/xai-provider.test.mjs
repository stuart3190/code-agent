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
  assert.ok(modelWeight("grok-4.5") > modelWeight("grok-4.3"), "weights follow pricing");
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
  const scoped = xaiPolicy({ THRALLO_XAI_AGENTS: "edit,repair", THRALLO_XAI_MODELS: "grok-4.3" });
  assert.equal(xaiEligibleForAgent("edit", scoped), true);
  assert.equal(xaiEligibleForAgent("build", scoped), false, "admin disabled Grok for builds");
  assert.equal(scoped.permittedModels.has("grok-4.5"), false);
  // Simple edits never pay for deep reasoning.
  assert.equal(xaiReasoningForTask("simple_edit"), "low");
  assert.equal(xaiReasoningForTask("bug_repair"), "medium");
  assert.notEqual(xaiReasoningForTask("full_build"), "low");
});

// Both routing tests below compare Grok against another configured provider, so they must
// supply that provider themselves. Relying on the ambient environment made them pass on a
// developer box (shell/.env carries a real OPENAI_API_KEY) and fail in CI, where xAI was
// the ONLY configured provider and therefore sorted first quite correctly.
function withPlatformOpenAI(body) {
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "sk-test-platform-000000000000";
  try { return body(); } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  }
}

test("smart routing respects configuration and admin restrictions", () => withPlatformOpenAI(() => {
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
  // The precondition, asserted rather than assumed: a rival provider is in the pool, so
  // "grok is not first" is a statement about ranking and not about an empty catalog.
  assert.ok(enabled.some((c) => c.provider !== "xai"), "another provider is configured to rank against");
  assert.notEqual(enabled[0].provider, "xai", "grok is never the assumed default");
  // BYOK xai credential -> only their grok connection is used.
  const byok = routeCandidates({ credential: { provider: "xai", secret: "xai-k" }, policy: {} });
  assert.equal(byok.length, 1);
  assert.equal(byok[0].provider, "xai");
  delete process.env.XAI_API_KEY;
}));

test("provider fallback works and failed requests record zero usage (no duplicate charges)", async () => {
  const attempts = [];
  const fakeStore = { recordAttempt: async (_o, row) => { attempts.push(row); }, listRecentAttempts: async () => [] };
  process.env.XAI_API_KEY = "xai-test-key-000000000000";
  // Fallback needs a provider to fall off: OpenAI must be in the pool and ranked first.
  const previousOpenAI = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "sk-test-platform-000000000000";
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
  if (previousOpenAI === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = previousOpenAI;
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
  const engine = createXaiEngineProvider({ apiKey: "xai-k-000000000000000000", model: "grok-4.5", reasoningEffort: "low", fetchImpl: capture });
  const turn = await engine.runTurn({ systemPrompt: "s", messages: [{ role: "user", content: "hi" }], tools: [{ name: "write_file", description: "d", parameters: {} }] });
  assert.equal(turn.toolCalls[0].name, "write_file");
  assert.equal(turn.toolCalls[0].arguments.path, "a.js");
  assert.equal(sentBody.reasoning.effort, "low");
  assert.equal(sentBody.store, false, "never stored provider-side");
  assert.equal(sentBody.model, "grok-4.5");
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

// The application's own provider registry, read from source so the test cannot drift from it.
async function applicationProviders() {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(
    fileURLToPath(new URL("../../shell/server/lib/aiCredentialStore.mjs", import.meta.url)), "utf8");
  return /const API_KEY_PROVIDERS = new Set\(\[([^\]]+)\]\)/.exec(source)[1]
    .split(",").map((s) => s.trim().replace(/['"]/g, "")).filter(Boolean);
}

// EVERY AI-provider CHECK constraint the migrations define, discovered by pattern rather than
// by a hardcoded list of table names. Later migrations win, so a drop-and-recreate is honoured.
async function providerConstraints() {
  const { readFile, readdir } = await import("node:fs/promises");
  const dir = fileURLToPath(new URL("../../supabase/migrations", import.meta.url));
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const found = new Map();
  for (const file of files) {
    const sql = await readFile(`${dir}/${file}`, "utf8");
    // Named constraints: `<name>_provider[_x]_check ... check (...)`.
    for (const match of sql.matchAll(/(\w*provider\w*_check)\b[\s\S]{0,80}?check\s*\(([\s\S]*?)\)\s*;/gi)) {
      found.set(match[1], match[2]);
    }
    // Inline column constraints. The table BODY is captured first (up to its closing `);`) so a
    // check belonging to a later table in the same file cannot be attributed to this one.
    for (const table of sql.matchAll(/create table (?:if not exists )?public\.(\w+)\s*\(([\s\S]*?)\n\);/gi)) {
      const inline = /check\s*\(\s*provider\s+in\s*\(([^)]*)\)/i.exec(table[2]);
      if (!inline) continue;
      const key = `${table[1]}__inline_provider`;
      if (!found.has(key)) found.set(key, inline[1]);
    }
  }
  // A named constraint on a table SUPERSEDES that table's original inline definition — the
  // inline form is what CREATE TABLE shipped, and a later ALTER drops and recreates it.
  for (const key of [...found.keys()]) {
    if (!key.endsWith("__inline_provider")) continue;
    const table = key.replace("__inline_provider", "");
    const superseded = [...found.keys()].some((other) => other !== key && other.startsWith(`${table}_`));
    if (superseded) found.delete(key);
  }
  return found;
}

// A constraint governs AI providers if its permitted values overlap the AI provider universe.
// Derived rather than name-listed, so `ca_repositories` (github) and `custom_oauth_providers`
// (oauth2/oidc) exclude themselves, and a new AI-provider table includes itself automatically —
// which is the whole point: a name list is what let two tables drift unnoticed.
const AI_PROVIDER_UNIVERSE = ["openai", "anthropic", "gemini", "xai", "codex"];

function governsAiProviders(definition) {
  return AI_PROVIDER_UNIVERSE.some((provider) => definition.includes(`'${provider}'`));
}

test("every application provider is permitted by EVERY AI provider constraint", async () => {
  // A provider added in code but missing from a schema CHECK fails at INSERT. When the write is
  // fire-and-forget (modelRouting's recordAttempt swallows errors) the failure is *silent*:
  // that is how xai reached production with ca_model_attempts and
  // ca_model_evaluation_results still listing only openai/anthropic/gemini, leaving provider
  // health scoring permanently blind to it. The previous version of this guard checked only the
  // two credential constraints and passed throughout.
  const appProviders = await applicationProviders();
  assert.ok(appProviders.includes("xai"), "xai is an application provider");

  const constraints = await providerConstraints();
  const aiConstraints = [...constraints].filter(([, definition]) => governsAiProviders(definition));
  assert.ok(aiConstraints.length >= 4,
    `expected to discover the AI provider constraints, found: ${aiConstraints.map(([n]) => n).join(", ")}`);

  for (const [name, definition] of aiConstraints) {
    for (const provider of appProviders) {
      assert.match(definition, new RegExp(`'${provider}'`),
        `${provider} must be permitted by ${name} — add it in a migration`);
    }
  }
});

test("the provider-constraint discovery actually sees the tables that drifted", async () => {
  // Guards the guard: if the discovery regex stops matching these, the test above would pass
  // vacuously for exactly the two tables that caused the incident.
  const constraints = await providerConstraints();
  for (const name of [
    "ca_ai_credentials_provider_check",
    "ca_ai_preferences_active_provider_check",
    "ca_model_attempts_provider_check",
    "ca_model_evaluation_results_provider_check",
  ]) {
    assert.ok(constraints.has(name), `${name} must be discovered by the constraint scan`);
  }
});

test("the adapter self-corrects when a model rejects a parameter it was told to send", async () => {
  // grok-build-0.1 rejects `reasoning` (probed live 2026-08-02). A wrong catalog flag —
  // or a brand new model — must cost one failed call, not every call forever.
  const seen = [];
  let calls = 0;
  const fetchImpl = async (_url, options) => {
    calls += 1;
    const body = JSON.parse(options.body);
    seen.push(Object.keys(body).includes("reasoning"));
    if (body.reasoning) {
      return { ok: false, status: 400, json: async () => ({ code: "invalid-argument", error: { message: "Model probe-model does not support parameter reasoning." } }) };
    }
    return { ok: true, json: async () => ({ output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }], usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 } }) };
  };
  const provider = createXaiProvider({ apiKey: "xai-k-000000000000000000", model: "probe-model", reasoningEffort: "high", fetchImpl });
  const first = await provider.turn({ instructions: "i", input: [], tools: [] });
  assert.equal(first.text, "ok", "recovered on the same call");
  assert.deepEqual(seen, [true, false], "sent reasoning, then retried without it");

  // The lesson is remembered: the next call skips the doomed attempt entirely.
  const before = calls;
  await provider.turn({ instructions: "i", input: [], tools: [] });
  assert.equal(calls - before, 1, "no wasted request second time around");
});

test("the catalog only lists models proven to exist on a live account", () => {
  // grok-4.5-fast was an assumed name and does not exist (probed live: "Model not found").
  assert.equal("grok-4.5-fast" in XAI_MODELS, false);
  assert.ok("grok-4.5" in XAI_MODELS && "grok-build-0.1" in XAI_MODELS && "grok-4.3" in XAI_MODELS);
  assert.equal(XAI_MODELS["grok-build-0.1"].reasoning, false, "probed: rejects reasoning");
  assert.equal(XAI_MODELS["grok-4.5"].reasoning, true, "probed: accepts reasoning");
});
