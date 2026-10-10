// ChatGPT-plan (Codex) lane: GPT-5.6 catalogue, live discovery, stored gpt-5.5,
// and a managed preference that must not throw model_lane_unavailable.

process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "sk-test-000000000000000000";

import assert from "node:assert/strict";
import test from "node:test";

import { createCodexProvider, clearCodexModelDiscoveryCache, discoverCodexModels } from "../../src/providers/codexProvider.mjs";
import { codexLeadAdapter, createCodingModelForCredential, resolveModelSelection } from "../../shell/server/lib/modelGateway.mjs";
import {
  CODEX_DEFAULT_MODEL, canonicalModelIdentity, codexExecutionModel, executableModelCatalogue, selectionValue,
} from "../../shell/server/lib/modelCatalogue.mjs";
import { routeCandidates } from "../../shell/server/lib/modelRouting.mjs";
import { resolveConversationModel, selectableModels, validateModelChoice } from "../../shell/server/lib/modelSelector.mjs";
import { FRIENDLY, captureIncident, classifyFailure, friendlyFor } from "../../shell/server/lib/errorShield.mjs";

const TRIO = ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"];

const completed = { type: "response.completed", response: { id: "resp_ok", usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } } };

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) };
}

function fakeDb() {
  const rows = [];
  const from = () => {
    const q = { op: null, patch: null };
    const exec = () => {
      if (q.op === "insert") { rows.push(q.patch); return { data: q.patch, error: null }; }
      return { data: rows, error: null };
    };
    const chain = {
      select: () => chain,
      insert: (value) => { q.op = "insert"; q.patch = value; return chain; },
      then: (resolve) => resolve(exec()),
    };
    return chain;
  };
  return { from, rows };
}

test("catalogue lists the ChatGPT-plan trio, optional astra, and hidden gpt-5.5", () => {
  const rows = executableModelCatalogue().filter((row) => row.provider === "codex");
  assert.deepEqual(rows.filter((row) => row.visibility === "public").map((row) => [row.model, row.tier]), [
    ["gpt-5.6-sol", "quality"],
    ["gpt-5.6-terra", "balanced"],
    ["gpt-5.6-luna", "fast"],
  ]);
  const astra = rows.find((row) => row.model === "gpt-6-astra");
  assert.equal(astra.visibility, "discovered");
  assert.equal(astra.optional, true);
  assert.ok(astra.lanes.includes("connected_allowance"));
  const retired = rows.find((row) => row.model === "gpt-5.5");
  assert.equal(retired.visibility, "deprecated_hidden");
  assert.equal(retired.replacement, "gpt-5.6-sol");
  const identity = canonicalModelIdentity({ provider: "codex", model: "gpt-5.5", lane: "connected_allowance" });
  assert.equal(identity.model, "gpt-5.5");
  assert.equal(selectionValue(identity), "connected_allowance:codex:gpt-5.5");
  assert.equal(codexExecutionModel("gpt-5.5"), "gpt-5.6-sol");
  assert.equal(codexExecutionModel(""), CODEX_DEFAULT_MODEL);
  assert.equal(CODEX_DEFAULT_MODEL, "gpt-5.6-terra");
});

test("selector loops discovered Codex models and hides managed rows while Codex is active", () => {
  const plain = selectableModels({ credentials: [{ provider: "codex" }, { provider: "openai" }] });
  assert.deepEqual(plain.options.filter((row) => row.provider === "codex").map((row) => row.model), TRIO);
  assert.equal(plain.options.some((row) => row.model === "gpt-5.5"), false);
  assert.equal(plain.options.some((row) => row.model === "gpt-6-astra"), false);
  const group = plain.providers.find((row) => row.providerId === "codex");
  assert.deepEqual(group.models.map((row) => row.name), TRIO);

  const discovered = selectableModels({
    credentials: [{ provider: "codex" }, { provider: "openai" }],
    activeProvider: "codex",
    codexModels: [...TRIO, "gpt-6-astra", "gpt-5.5", "gpt-9-nope"],
  });
  assert.deepEqual(discovered.options.filter((row) => row.provider === "codex").map((row) => row.model), [...TRIO, "gpt-6-astra"]);
  assert.equal(discovered.options.some((row) => row.provider === "openai" || row.lane === "managed" || row.lane === "byok_api"), false);
  assert.equal(discovered.options.some((row) => row.model === "gpt-5.5"), false);
  const openai = discovered.providers.find((row) => row.providerId === "openai" || row.id === "openai");
  assert.equal(openai.available, false);
  assert.equal(openai.models.length, 0);

  const stored = validateModelChoice(discovered, "managed:openai:gpt-5.6-sol#deep");
  assert.equal(stored, "connected_allowance:codex:gpt-5.6-sol");
  const retired = validateModelChoice(discovered, "connected_allowance:codex:gpt-5.5");
  assert.equal(retired, "connected_allowance:codex:gpt-5.6-sol");
});

test("a managed gpt-5.6 preference runs on the ChatGPT plan instead of throwing", () => {
  const catalog = selectableModels({
    credentials: [{ provider: "codex" }],
    activeProvider: "codex",
  });
  const resolution = resolveConversationModel({ model_pref: "managed:openai:gpt-5.6-sol#deep" }, catalog);
  assert.equal(resolution.warning, null);
  assert.equal(resolution.requested, "connected_allowance:codex:gpt-5.6-sol");
  assert.equal(resolution.mode, "deep");
  assert.match(resolution.notice, /ChatGPT plan/);

  const routed = routeCandidates({
    credential: { provider: "codex" },
    requested: "managed:openai:gpt-5.6-sol",
    policy: { mode: "deep" },
  });
  assert.equal(routed[0].provider, "codex");
  assert.equal(routed[0].model, "gpt-5.6-sol");
  assert.equal(routed[0].billingLane, "connected_allowance");
  assert.equal(routed[0].reasoningProfile, "high");

  const legacy = routeCandidates({
    credential: { provider: "codex" },
    requested: "connected_allowance:codex:gpt-5.5",
  });
  assert.equal(legacy[0].model, "gpt-5.6-sol");
  assert.equal(legacy[0].provider, "codex");

  assert.throws(() => routeCandidates({
    credential: { provider: "codex" },
    requested: "byok_api:anthropic:claude-sonnet-5",
  }), (error) => error.code === "model_lane_unavailable");
  assert.throws(() => routeCandidates({
    credential: { provider: "anthropic", secret: "synthetic" },
    requested: "byok_api:openai:gpt-5.6-terra",
  }), (error) => error.code === "model_lane_unavailable");
});

test("gateway sends the selected Codex model and defaults to terra", () => {
  assert.deepEqual(resolveModelSelection("auto", { defaultProvider: "codex", defaultLane: "connected_allowance" }), {
    provider: "codex", model: "gpt-5.6-terra",
  });
  assert.deepEqual(resolveModelSelection("connected_allowance:codex:gpt-5.5"), {
    provider: "codex", model: "gpt-5.6-sol",
  });
  assert.equal(createCodexProvider().model, "gpt-5.6-terra");
  const luna = createCodingModelForCredential({ provider: "codex" }, "connected_allowance:codex:gpt-5.6-luna");
  assert.equal(luna.model, "gpt-5.6-luna");
  const fromManaged = createCodingModelForCredential({ provider: "codex" }, "managed:openai:gpt-5.6-sol");
  assert.equal(fromManaged.id, "codex");
  assert.equal(fromManaged.model, "gpt-5.6-sol");
  const auto = routeCandidates({ credential: { provider: "codex" }, requested: "auto", policy: {} });
  assert.equal(auto[0].model, "gpt-5.6-terra");
  assert.equal(auto[0].provider, "codex");
});

test("sol rejection retries terra then luna and surfaces the notice; an unrelated 400 does not", async () => {
  const planBodies = [];
  const plan = createCodexProvider({
    model: "gpt-5.6-sol",
    tokenProvider: async () => ({ accessToken: "tok", accountId: "acc" }),
    fetchImpl: async (_url, init) => {
      const model = JSON.parse(init.body).model;
      planBodies.push(model);
      if (model !== "gpt-5.6-luna") {
        return {
          ok: false, status: 400, headers: { get: () => null },
          text: async () => `The '${model}' model is not supported when using Codex with a ChatGPT account`,
        };
      }
      return {
        ok: true, status: 200, headers: { get: () => null },
        body: (async function* () { yield Buffer.from(`data: ${JSON.stringify(completed)}\n\n`); })(),
        text: async () => "",
      };
    },
  });
  const result = await plan.runTurn({ systemPrompt: "s", messages: [{ role: "user", content: "hi" }] });
  assert.deepEqual(planBodies, ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]);
  assert.match(result.notice, /gpt-5.6-luna/);
  assert.equal(result.model, "gpt-5.6-luna");

  const once = [];
  const other = createCodexProvider({
    model: "gpt-5.6-sol",
    tokenProvider: async () => ({ accessToken: "tok", accountId: "acc" }),
    fetchImpl: async (_url, init) => {
      once.push(JSON.parse(init.body).model);
      return { ok: false, status: 400, headers: { get: () => null }, text: async () => "bad schema" };
    },
  });
  await assert.rejects(other.runTurn({ systemPrompt: "s", messages: [{ role: "user", content: "hi" }] }), /bad schema/);
  assert.deepEqual(once, ["gpt-5.6-sol"]);
});

test("the lead adapter forwards the plan-fallback notice", async () => {
  const provider = {
    model: "gpt-5.6-sol",
    async runTurn() {
      return { text: "ok", toolCalls: [], usage: { input: 1, output: 1, total: 2 }, notice: "Continuing with gpt-5.6-terra.", model: "gpt-5.6-terra" };
    },
  };
  const result = await codexLeadAdapter(provider, "gpt-5.6-sol").turn({ instructions: "s", input: [] });
  assert.equal(result.notice, "Continuing with gpt-5.6-terra.");
  assert.equal(result.model, "gpt-5.6-terra");
});

test("discovery intersects the catalogue, caches briefly, and falls back without logging tokens", async () => {
  clearCodexModelDiscoveryCache();
  const token = "codex-access-token-DO-NOT-LOG";
  const logs = [];
  const originals = ["log", "info", "warn", "error", "debug"].map((name) => [name, console[name]]);
  for (const [name] of originals) console[name] = (...args) => logs.push(args.map(String).join(" "));
  try {
    let calls = 0;
    let seen = null;
    const fetchImpl = async (url, init) => {
      calls += 1;
      seen = { url, headers: init.headers };
      return jsonResponse({ models: [
        { slug: "gpt-5.6-terra" },
        { slug: "gpt-6-astra" },
        { slug: "gpt-5.5" },
        { slug: "gpt-5.6-luna", visibility: "hidden" },
        { slug: "gpt-9-nope" },
      ] });
    };
    const first = await discoverCodexModels(token, "acct-1", { fetchImpl, now: () => 1_000 });
    const second = await discoverCodexModels(token, "acct-1", { fetchImpl, now: () => 2_000 });
    assert.deepEqual(first, ["gpt-5.6-terra", "gpt-6-astra"]);
    assert.deepEqual(second, first);
    assert.equal(calls, 1);
    assert.match(seen.url, /\/backend-api\/codex\/models\?client_version=/);
    assert.equal(seen.headers.Authorization, `Bearer ${token}`);
    assert.equal(seen.headers["ChatGPT-Account-ID"], "acct-1");
    assert.equal(seen.headers.originator, "codex_cli_rs");
    const third = await discoverCodexModels(token, "acct-1", { fetchImpl, now: () => 1_000 + 60_000 });
    assert.equal(calls, 2);
    assert.deepEqual(third, first);

    const empty = await discoverCodexModels(token, "acct-2", {
      fetchImpl: async () => jsonResponse({ models: [] }),
    });
    assert.deepEqual(empty, TRIO);
    const failed = await discoverCodexModels(token, "acct-3", {
      fetchImpl: async () => { throw new Error("network down"); },
    });
    assert.deepEqual(failed, TRIO);
    let called = false;
    const missingAccount = await discoverCodexModels(token, "", {
      fetchImpl: async () => { called = true; return jsonResponse({ models: [] }); },
    });
    assert.equal(called, false);
    assert.deepEqual(missingAccount, TRIO);
  } finally {
    for (const [name, fn] of originals) console[name] = fn;
    clearCodexModelDiscoveryCache();
  }
  assert.equal(logs.join("\n").includes(token), false);
});

test("model_lane_unavailable is a clear user message, not the saving-progress line", async () => {
  const error = Object.assign(new Error("The selected model is not executable with the selected provider and billing lane."), {
    code: "model_lane_unavailable", status: 400,
  });
  const classification = classifyFailure(error);
  assert.equal(classification.retryable, false);
  assert.equal(classification.kind, "needs_user");
  assert.equal(friendlyFor("conversation", classification, error), FRIENDLY.modelLane);
  assert.match(FRIENDLY.modelLane, /isn't available on your connected plan/);
  assert.doesNotMatch(FRIENDLY.modelLane, /saving progress/);
  const incident = await captureIncident({ error, service: "conversation", client: fakeDb() });
  assert.equal(incident.friendly, FRIENDLY.modelLane);
  assert.match(incident.unresolvedMessage, /isn't available on your connected plan/);
  assert.doesNotMatch(incident.unresolvedMessage, /saving progress/);
});
