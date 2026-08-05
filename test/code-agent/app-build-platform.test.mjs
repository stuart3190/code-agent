// Phase 19: the Buildr generation pipeline on Thrallo infrastructure.
//   * budgetLedger — Thrallo budgets exposed through the legacy ledger interface
//   * openaiEngineProvider — engine runTurn contract over the OpenAI Responses API
//   * app_build capability — exposed through the Capability Registry, never hardcoded
//   * previewDomainCheck — the on-demand-TLS ask gate for *.preview.thrallo.com

import assert from "node:assert/strict";
import test from "node:test";

import { createBudgetLedger } from "../../shell/server/lib/appBuild/budgetLedger.mjs";
import { createOpenAIEngineProvider } from "../../shell/server/lib/appBuild/openaiEngineProvider.mjs";
import { TOKENS_PER_CREDIT } from "../../src/cost.mjs";
import {
  registerCoreCapabilities,
} from "../../shell/server/lib/capabilities/coreCapabilities.mjs";
import {
  listCapabilities, capabilityToolDefs, resetCapabilityRegistryForTests,
} from "../../shell/server/lib/capabilityRegistry.mjs";
import { previewDomainAllowed } from "../../shell/server/routes/previewDomainCheck.mjs";

// ── budgetLedger ─────────────────────────────────────────────────────────────────────────────

test("budgetLedger reports remaining managed tokens as legacy credits", async () => {
  const ledger = createBudgetLedger({
    store: {},
    overviewResolver: async () => ({ budgets: { managedTokens: { remaining: TOKENS_PER_CREDIT * 12.5 } } }),
  });
  const balance = await ledger.getBalance("owner-1");
  assert.equal(balance.total, 12.5);
  assert.equal(balance.bundle, 12.5);
  assert.equal(balance.topup, 0);
});

test("budgetLedger clamps a blown budget to zero credits", async () => {
  const ledger = createBudgetLedger({
    store: {},
    overviewResolver: async () => ({ budgets: { managedTokens: { remaining: -50_000 } } }),
  });
  assert.equal((await ledger.getBalance("owner-1")).total, 0);
});

test("budgetLedger.debit records a standalone app_build usage row and always succeeds", async () => {
  const recorded = [];
  const ledger = createBudgetLedger({
    store: { recordStandaloneUsage: async (owner, row) => { recorded.push({ owner, row }); } },
    overviewResolver: async () => ({ budgets: { managedTokens: { remaining: TOKENS_PER_CREDIT * 3 } } }),
  });
  const out = await ledger.debit({
    owner: "owner-1",
    usage: { input: 900, cached: 100, output: 500, reasoning: 200, total: 1600 },
    model: "gpt-test",
    ref: "job:abc",
  });
  assert.equal(out.ok, true);
  assert.equal(out.partial, false);
  // The debit uses the SAME cache-aware, model-weighted formula as every reporting surface.
  // This assertion previously pinned the flat total/TOKENS_PER_CREDIT rule — it encoded the
  // 2026-08-05 billing defect as the expected behaviour, which is how the defect survived
  // 961 tests: the one test that looked at the debit agreed with the wrong answer.
  const { creditsForUsage } = await import("../../src/billing/costModel.mjs");
  const canonical = creditsForUsage({
    usage: { input: 900, cached: 100, output: 500, reasoning: 200, total: 1600 }, model: "gpt-test",
  });
  assert.equal(out.debited, Math.round(canonical * 10_000) / 10_000);
  assert.ok(out.debited > 0, "an unknown model still prices at the default rate rather than zero");
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].owner, "owner-1");
  assert.equal(recorded[0].row.billing_source, "managed");
  assert.equal(recorded[0].row.metadata.kind, "app_build");
  assert.equal(recorded[0].row.metadata.ref, "job:abc");
  assert.equal(recorded[0].row.input_tokens, 900);
  assert.equal(recorded[0].row.output_tokens, 500);
});

// ── openaiEngineProvider ─────────────────────────────────────────────────────────────────────

test("openaiEngineProvider speaks the engine runTurn contract over the Responses API", async () => {
  let captured = null;
  const fetchImpl = async (url, init) => {
    captured = { url, body: JSON.parse(init.body), auth: init.headers.Authorization };
    return {
      ok: true,
      json: async () => ({
        output: [
          { type: "message", content: [{ type: "output_text", text: "Building now." }] },
          { type: "function_call", call_id: "c1", name: "apply_patch", arguments: '{"patch":"x"}' },
          { type: "function_call", call_id: "c2", name: "broken", arguments: "{not json" },
        ],
        usage: {
          input_tokens: 120, output_tokens: 40, total_tokens: 160,
          input_tokens_details: { cached_tokens: 30 },
          output_tokens_details: { reasoning_tokens: 8 },
        },
      }),
    };
  };
  const provider = createOpenAIEngineProvider({ model: "gpt-test", apiKey: "sk-unit", fetchImpl });
  const out = await provider.runTurn({
    systemPrompt: "SYSTEM",
    messages: [
      { role: "user", content: "build it" },
      { role: "assistant", toolCalls: [{ id: "p1", name: "list_files", arguments: "{}" }] },
      { role: "tool", toolCallId: "p1", output: "src/App.jsx" },
      { role: "assistant", content: "ok" },
    ],
    tools: [{ name: "apply_patch", description: "edit", parameters: { type: "object" } }],
  });

  assert.equal(captured.url, "https://api.openai.com/v1/responses");
  assert.equal(captured.auth, "Bearer sk-unit");
  assert.equal(captured.body.model, "gpt-test");
  assert.equal(captured.body.instructions, "SYSTEM");
  assert.equal(captured.body.store, false);
  assert.deepEqual(captured.body.input[0], { role: "user", content: [{ type: "input_text", text: "build it" }] });
  assert.deepEqual(captured.body.input[1], { type: "function_call", call_id: "p1", name: "list_files", arguments: "{}" });
  assert.deepEqual(captured.body.input[2], { type: "function_call_output", call_id: "p1", output: "src/App.jsx" });
  assert.equal(captured.body.input[3].role, "assistant");
  assert.equal(captured.body.tools[0].name, "apply_patch");

  assert.equal(out.text, "Building now.");
  assert.equal(out.toolCalls.length, 2);
  assert.deepEqual(out.toolCalls[0], { id: "c1", name: "apply_patch", rawArguments: '{"patch":"x"}', arguments: { patch: "x" } });
  assert.deepEqual(out.toolCalls[1].arguments, { __raw: "{not json" });
  assert.deepEqual(out.usage, { input: 120, output: 40, reasoning: 8, cached: 30, total: 160 });
});

test("openaiEngineProvider surfaces HTTP errors with status", async () => {
  const provider = createOpenAIEngineProvider({
    model: "gpt-test", apiKey: "sk-unit",
    fetchImpl: async () => ({ ok: false, status: 429, text: async () => "rate limited" }),
  });
  await assert.rejects(
    provider.runTurn({ systemPrompt: "s", messages: [{ role: "user", content: "x" }], tools: [] }),
    (error) => error.status === 429 && /rate limited/.test(error.message),
  );
});

// ── app_build capability registration ────────────────────────────────────────────────────────

test("app_build is exposed through the Capability Registry, not hardcoded", () =>
  withEnv({ OPENAI_API_KEY: "sk-unit-test" }, async () => {
    resetCapabilityRegistryForTests();
    registerCoreCapabilities();
    try {
      const capability = listCapabilities().find((c) => c.id === "app_build");
      assert.ok(capability, "app_build must be a registered capability");
      assert.equal(capability.specialist, "Builder");
      assert.equal(capability.costProfile, "run");

      const defs = await capabilityToolDefs({});
      const def = defs.find((d) => d.name === "app_build");
      assert.ok(def, "the Lead Agent's generated tool list must include app_build");
      // Strict-schema invariant: every property listed, optionality via nullable types.
      assert.deepEqual([...def.parameters.required].sort(), [...Object.keys(def.parameters.properties)].sort());
      assert.deepEqual(def.parameters.properties.productName.type, ["string", "null"]);
    } finally {
      resetCapabilityRegistryForTests();
    }
  }));

// ── previewDomainCheck ───────────────────────────────────────────────────────────────────────

function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return Promise.resolve(fn()).finally(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

test("domain-check approves a preview host only when provisiond says the label exists", () =>
  withEnv({ PROVISIOND_URL: "http://127.0.0.1:8791", PROVISIOND_TOKEN: "tok", LEGACY_DOMAIN_CHECK_URL: undefined }, async () => {
    const asked = [];
    const fetchImpl = async (url, init) => {
      asked.push({ url, auth: init?.headers?.Authorization });
      const exists = url.includes("label=liveapp");
      return { ok: true, json: async () => ({ exists }) };
    };
    assert.equal(await previewDomainAllowed("liveapp.preview.thrallo.com", { fetchImpl }), true);
    assert.equal(await previewDomainAllowed("ghost.preview.thrallo.com", { fetchImpl }), false);
    assert.equal(asked[0].url, "http://127.0.0.1:8791/exists?label=liveapp");
    assert.equal(asked[0].auth, "Bearer tok");
  }));

test("domain-check refuses malformed labels and provisiond failures without calling out", () =>
  withEnv({ PROVISIOND_URL: "http://127.0.0.1:8791", LEGACY_DOMAIN_CHECK_URL: undefined }, async () => {
    let called = 0;
    const fetchImpl = async () => { called += 1; throw new Error("down"); };
    assert.equal(await previewDomainAllowed("Bad_Label!.preview.thrallo.com", { fetchImpl }), false);
    assert.equal(await previewDomainAllowed(".preview.thrallo.com", { fetchImpl }), false);
    assert.equal(called, 0, "malformed labels never reach provisiond");
    assert.equal(await previewDomainAllowed("okay.preview.thrallo.com", { fetchImpl }), false);
    assert.equal(called, 1, "a provisiond failure fails closed");
  }));

test("domain-check passes non-preview hosts through to the legacy Buildr gate", () =>
  withEnv({ PROVISIOND_URL: undefined, LEGACY_DOMAIN_CHECK_URL: "http://10.83.7.1:8787/api/domain-check" }, async () => {
    const asked = [];
    const fetchImpl = async (url) => {
      asked.push(url);
      return { status: url.includes("customersite.com") ? 200 : 404 };
    };
    assert.equal(await previewDomainAllowed("customersite.com", { fetchImpl }), true);
    assert.equal(await previewDomainAllowed("unknown.example", { fetchImpl }), false);
    assert.equal(asked[0], "http://10.83.7.1:8787/api/domain-check?domain=customersite.com");
  }));

test("domain-check fails closed when nothing is configured", () =>
  withEnv({ PROVISIOND_URL: undefined, LEGACY_DOMAIN_CHECK_URL: undefined }, async () => {
    assert.equal(await previewDomainAllowed("app.preview.thrallo.com", { fetchImpl: async () => { throw new Error("no"); } }), false);
    assert.equal(await previewDomainAllowed("random.com", { fetchImpl: async () => { throw new Error("no"); } }), false);
  }));
