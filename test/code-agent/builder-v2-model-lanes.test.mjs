// WP-9 — the real model lanes behind the orchestrator seams, proven hermetically: strict
// tool passthrough + forced tool_choice on the Codex wire, one SHARED ceiling across every
// call in a job, spend recorded even when the guard stops the build, machine-readable
// rejection feedback reaching the next prompt.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createCodexProvider } from "../../src/providers/codexProvider.mjs";
import { createModelLanes, jobUsageBucket, renderPatchPrompt } from "../../shell/server/lib/builderV2/modelLanes.mjs";
import { EMIT_PATCHES_SCHEMA } from "../../shell/server/lib/builderV2/patchEngine.mjs";

// ── codex wire format ─────────────────────────────────────────────────────────────────────────

function sseResponse(events) {
  const payload = events.map((e) => `data: ${JSON.stringify(e)}\n`).join("") + "data: [DONE]\n";
  return {
    ok: true,
    headers: { get: () => null },
    body: (async function* () { yield Buffer.from(payload); })(),
  };
}

test("WP9 — codex wire: strict passes through per-tool, forced tool_choice disables parallel calls", async () => {
  const bodies = [];
  const provider = createCodexProvider({
    tokenProvider: async () => ({ accessToken: "t", accountId: "a" }),
    fetchImpl: async (url, { body }) => {
      bodies.push(JSON.parse(body));
      return sseResponse([
        { type: "response.output_item.done", item: { type: "function_call", call_id: "c1", name: "emit_patches", arguments: '{"patches":[]}' } },
        { type: "response.completed", response: { id: "r1", usage: { input_tokens: 100, output_tokens: 40, total_tokens: 140 } } },
      ]);
    },
  });

  const turn = await provider.runTurn({
    systemPrompt: "s",
    messages: [{ role: "user", content: "u" }],
    tools: [EMIT_PATCHES_SCHEMA],
    toolChoice: { type: "function", name: "emit_patches" },
  });
  assert.equal(bodies[0].tools[0].strict, true, "emit_patches opts INTO strict and it reaches the wire");
  assert.deepEqual(bodies[0].tool_choice, { type: "function", name: "emit_patches" });
  assert.equal(bodies[0].parallel_tool_calls, false, "a forced single tool is not parallel");
  assert.equal(bodies[0].reasoning, undefined, "no reasoning field unless asked for");
  assert.equal(turn.toolCalls[0].name, "emit_patches");
  assert.deepEqual(turn.toolCalls[0].arguments, { patches: [] });

  // Default behaviour (v1 callers) is byte-identical to before: auto + parallel + non-strict.
  await provider.runTurn({ systemPrompt: "s", messages: [{ role: "user", content: "u" }],
    tools: [{ name: "plain", description: "d", parameters: { type: "object" } }] });
  assert.equal(bodies[1].tool_choice, "auto");
  assert.equal(bodies[1].parallel_tool_calls, true);
  assert.equal(bodies[1].tools[0].strict, false);
  assert.equal(bodies[1].reasoning, undefined);

  // The lanes ask for thinking room on patch calls; the wire shape is codex_cli_rs's.
  await provider.runTurn({ systemPrompt: "s", messages: [{ role: "user", content: "u" }], reasoningEffort: "medium" });
  assert.deepEqual(bodies[2].reasoning, { effort: "medium" });
});

// ── the lanes ─────────────────────────────────────────────────────────────────────────────────

const CONTRACT = {
  summary: "landing page", journeys: [
    { id: "send-message", title: "Send a message", priority: "primary",
      steps: [{ action: "fill the form", expect: "confirmation shown" }] },
  ], entities: [], routes: [{ path: "/", name: "Home" }], operations: [],
};
const TIERS = { essential: { journeys: ["send-message"], entities: [], operations: [] }, secondary: { journeys: [], entities: [], operations: [] } };

function fakePatchProvider({ usage = { input: 1000, output: 200, cached: 0, reasoning: 0, total: 1200 }, patches = [] } = {}) {
  const calls = [];
  return {
    calls,
    model: "gpt-5.5",
    providerId: "codex",
    runTurn: async (args) => {
      calls.push(args);
      return {
        text: "",
        toolCalls: [{ id: "c1", name: "emit_patches", arguments: { patches } }],
        usage: { ...usage, providerRequestId: "codex:response:r1" },
      };
    },
  };
}

function fakeDiag() {
  const steps = [];
  return { steps, step: (s) => steps.push(s) };
}

test("WP9 — patchesFn: forced strict call, patches returned, rejection feedback reaches the next prompt", async () => {
  const provider = fakePatchProvider({ patches: [{ newFile: "src/routes/A.jsx", content: "x", file: null, ops: null, deleteFile: null }] });
  const diag = fakeDiag();
  const lanes = createModelLanes({ provider, ceilingCredits: 5, diag });

  const patches = await lanes.patchesFn({ step: "core", contract: CONTRACT, tiers: TIERS, tree: { "src/App.jsx": "export default function App() { return null; }" }, rejections: [], problems: [] });
  assert.equal(patches.length, 1);
  assert.deepEqual(provider.calls[0].toolChoice, { type: "function", name: "emit_patches" });
  assert.equal(provider.calls[0].tools[0], EMIT_PATCHES_SCHEMA);
  assert.equal(diag.steps.length, 1);
  assert.equal(diag.steps[0].usage.input, 1000, "spend recorded on the canonical step");

  await lanes.patchesFn({
    step: "core", contract: CONTRACT, tiers: TIERS, tree: {},
    rejections: [{ reason: 'symbol "Nope" not found in src/App.jsx' }],
    problems: ["expectations: confirmation not rendered"],
  });
  const prompt = provider.calls[1].messages[0].content;
  assert.match(prompt, /symbol "Nope" not found/, "machine-readable rejection reaches the model");
  assert.match(prompt, /confirmation not rendered/, "gate problems reach the model");
});

test("WP9 — ONE shared ceiling across all calls: the guard stops the job and spend is still recorded", async () => {
  // ~60k in + 20k out per call on gpt-5.5 ≈ 1 credit; ceiling 1.5 → the pre-emptive floor
  // trips during the FIRST guard check or the second call — never a third.
  const provider = fakePatchProvider({ usage: { input: 60_000, output: 20_000, cached: 0, reasoning: 0, total: 80_000 } });
  const diag = fakeDiag();
  const lanes = createModelLanes({ provider, ceilingCredits: 1.5, diag });
  const args = { step: "core", contract: CONTRACT, tiers: TIERS, tree: {}, rejections: [], problems: [] };

  let stopped = null;
  try {
    await lanes.patchesFn(args);
    await lanes.patchesFn(args);
    await lanes.patchesFn(args);
  } catch (error) {
    stopped = error;
  }
  assert.ok(stopped, "the ceiling must stop the job");
  assert.equal(stopped.reason, "job_credit_limit", stopped.message);
  assert.ok(provider.calls.length <= 2, `no third paid call (made ${provider.calls.length})`);
  assert.equal(diag.steps.length, provider.calls.length, "every paid call reached diagnostics BEFORE the stop");
});

test("WP9 — contractFn drives the v1 contract agent and records the bucket DELTA as its spend", async () => {
  const contractJson = JSON.stringify({
    summary: "Harbor & Sage landing page with contact form",
    projectType: "landing",
    journeys: [
      { id: "send-message", title: "Send a message", priority: "primary",
        steps: [
          { action: "fill in name, email and message", target: "contact form", expect: "fields accept input" },
          { action: "submit the form", target: "submit button", expect: "confirmation that the message was received" },
        ], acceptance: ["confirmation visible"] },
    ],
    routes: [{ path: "/", name: "Home" }],
    entities: [{ name: "contactMessage", fields: ["name", "email", "message"], owned: false }],
    auth: { required: false },
    operations: [{ id: "submit-contact", description: "store a contact message" }],
  });
  const provider = {
    model: "gpt-5.5",
    runTurn: async () => ({ text: contractJson, toolCalls: [], usage: { input: 5000, output: 1500, cached: 0, reasoning: 0, total: 6500 } }),
  };
  const diag = fakeDiag();
  const lanes = createModelLanes({ provider, ceilingCredits: 5, diag });
  const contract = await lanes.contractFn({ request: "landing page" });
  assert.equal(contract.journeys[0].id, "send-message");
  assert.equal(contract.journeys[0].priority, "primary");
  const step = diag.steps.find((s) => /contract/.test(s.label));
  assert.ok(step, "contract call recorded");
  assert.ok(step.usage.input >= 5000, `usage delta captured (got ${JSON.stringify(step.usage)})`);
});

test("WP9 — renderPatchPrompt is byte-stable and scopes core vs increment correctly", () => {
  const tree = { "src/App.jsx": "export default function App() { return null; }" };
  const a = renderPatchPrompt({ step: "core", contract: CONTRACT, tiers: TIERS, tree, rejections: [], problems: [] });
  assert.equal(a, renderPatchPrompt({ step: "core", contract: CONTRACT, tiers: TIERS, tree, rejections: [], problems: [] }));
  assert.match(a, /ESSENTIAL scope only/);
  assert.match(a, /do NOT build it now/i);
  // The v1 transition brief (the run-2 fix): exact verifier keywords + the snapshot rule.
  assert.match(a, /snapshots the page BEFORE each action/);
  assert.match(a, /EXACT words as visible text: \[confirmation\]/, "keywords come from the verifier's own filter");
  assert.match(a, /DISTINCTIVE confirmation copy/);

  const inc = renderPatchPrompt({
    step: "increment:extra", contract: CONTRACT, tiers: TIERS, tree,
    journey: { id: "extra", title: "Extra" }, rejections: [], problems: [],
  });
  assert.match(inc, /EXACTLY this one increment/);
  assert.match(inc, /"extra"/);
});
