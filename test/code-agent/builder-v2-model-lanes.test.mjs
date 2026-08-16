// WP-9 — the real model lanes behind the orchestrator seams, proven hermetically: strict
// tool passthrough + forced tool_choice on the Codex wire, one SHARED ceiling across every
// call in a job, spend recorded even when the guard stops the build, machine-readable
// rejection feedback reaching the next prompt.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createCodexProvider } from "../../src/providers/codexProvider.mjs";
import {
  causalRepairProblems, createModelLanes, estimatePromptTokens, HEADROOM_FRAGMENT_SYSTEM_PROMPT, headroomDispatchScope,
  headroomSourceFragments, jobUsageBucket, planCallReservation, renderPatchPrompt,
  repairFailureOwnedPaths, repairFailureReferences,
} from "../../shell/server/lib/builderV2/modelLanes.mjs";
import { EMIT_PATCHES_SCHEMA } from "../../shell/server/lib/builderV2/patchEngine.mjs";
import { memoryKnowledgeStore } from "../../shell/server/lib/builderV2/knowledge.mjs";
import { memoryModelReservations } from "../../shell/server/lib/builderV2/modelReservations.mjs";

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

function oversizedModuleFixture({ source = null } = {}) {
  const modulePlan = ["A", "B", "C", "D"].map((name) => ({
    path: `src/components/${name}.jsx`, role: `${name} feature module`,
  }));
  const moduleContracts = {
    version: 1,
    specifications: modulePlan.map((module) => ({
      path: module.path, role: module.role, ownedJourneys: ["send-message"],
      requiredImports: [], requiredCapabilities: [], forbiddenCapabilityBypasses: [],
      state: { owns: "presentation" }, semanticInteractions: [], downstream: { consumes: [], produces: [] },
      persistence: { owner: null }, requiredExports: [], moduleSizeBoundary: 6_000,
      // Models never see this synthetic field in a scoped continuation. It reproduces the live
      // failure class: a full correction re-sent tens of thousands of irrelevant contract bytes.
      diagnosticPadding: "x".repeat(55_000),
    })),
  };
  const tree = {
    "src/App.jsx": "export default function App(){return <main/>}",
    "src/routes/HomePage.jsx": "export default function HomePage(){return <main/>}",
    ...(source == null ? {} : { "src/components/A.jsx": source }),
  };
  return { modulePlan, moduleContracts, tree };
}

test("oversized pre-dispatch core calls compact into one bounded continuation without another user turn", async () => {
  const fixture = oversizedModuleFixture();
  let providerCalls = 0;
  const logs = [];
  const provider = {
    model: "gpt-5.5", provider: "openai",
    runTurn: async () => {
      providerCalls += 1;
      return {
        text: "", toolCalls: [{ id: "c", name: "emit_patches", arguments: { patches: [{
          newFile: "src/components/A.jsx", content: "export function A(){return <section>A</section>}",
        }] } }],
        usage: { input: 1_000, output: 300, total: 1_300, providerRequestId: "req-headroom" },
      };
    },
  };
  const reservations = memoryModelReservations();
  const lanes = createModelLanes({
    providerForStep: async () => ({ provider, decision: {
      provider: "openai", model: "gpt-5.5", billingLane: "connected_allowance",
      estimatedCredits: 2, callCeilingCredits: 6, maxOutputTokens: 16_000,
    } }),
    ceilingCredits: 30, reservations, knowledgeStore: memoryKnowledgeStore(), log: (line) => logs.push(line),
  });
  const patches = await lanes.patchesFn({
    owner: "owner", projectId: "project", buildId: "build", step: "core", originalStep: "core",
    contract: CONTRACT, tiers: TIERS, tree: fixture.tree, rejections: [], problems: [],
    modulePlan: fixture.modulePlan, moduleContracts: fixture.moduleContracts,
  });
  assert.equal(providerCalls, 1, "the oversized envelope is rejected before dispatch; only the compact call reaches the provider");
  assert.equal(reservations.rows().length, 1, "only the useful compact dispatch acquires a durable reservation");
  assert.deepEqual(patches.dispatchScope.allowedFiles,
    ["src/components/A.jsx", "src/components/B.jsx", "src/components/C.jsx"]);
  assert.match(logs.join("\n"), /continuing internally with 3 module\(s\).*resize 1/);
});

test("scoped correction prompts use compact module contracts while full generation retains full architecture", () => {
  const fixture = oversizedModuleFixture({ source: "export function A(){return <section/>}" });
  const full = renderPatchPrompt({ step: "core", contract: CONTRACT, tiers: TIERS,
    tree: fixture.tree, modulePlan: fixture.modulePlan, moduleContracts: fixture.moduleContracts });
  const repairScope = headroomDispatchScope({
    tree: fixture.tree, modulePlan: fixture.modulePlan, moduleContracts: fixture.moduleContracts,
    repairScope: { files: ["src/components/A.jsx"], allowedFiles: ["src/components/A.jsx"] },
  });
  const compact = renderPatchPrompt({ step: "correction", originalStep: "core", contract: CONTRACT,
    tiers: TIERS, tree: fixture.tree, modulePlan: fixture.modulePlan,
    moduleContracts: fixture.moduleContracts, headroomScope: repairScope });
  assert.ok(estimatePromptTokens({ messages: [{ role: "user", content: full }] }) > 70_000);
  assert.ok(estimatePromptTokens({ messages: [{ role: "user", content: compact }] }) < 15_000,
    "bounded corrections no longer resend every unrelated module contract");
  assert.match(compact, /HEADROOM-SCOPED CONTINUATION/);
  assert.doesNotMatch(compact, /diagnosticPadding/);
});

test("browser-repair headroom batching targets only evidence owners and fits a useful one-file continuation", () => {
  const liveSizedSource = `export default function Planner(){return <main>${"x".repeat(17_000)}</main>}`;
  const fixture = oversizedModuleFixture({ source: liveSizedSource });
  const problem = JSON.stringify({
    code: "interaction_verification_failure",
    responsibleModules: ["src/components/A.jsx"],
    actualObservedState: "the contracted control was missing",
  });
  const cascade = "journey send-message: later step: not reached because step 1 was undriveable";
  const scope = headroomDispatchScope({
    tree: fixture.tree,
    modulePlan: fixture.modulePlan,
    moduleContracts: fixture.moduleContracts,
    problems: [problem, cascade],
    logicalStep: "repair",
  });
  assert.deepEqual(scope.allowedFiles, ["src/components/A.jsx"]);
  assert.deepEqual(scope.remainingFiles, [], "unrelated missing planned modules are not queued behind a repair");

  let retrieval = null;
  const prompt = renderPatchPrompt({
    step: "repair", originalStep: "core", contract: CONTRACT, tiers: TIERS,
    tree: fixture.tree, modulePlan: fixture.modulePlan, moduleContracts: fixture.moduleContracts,
    problems: [problem, cascade], headroomScope: scope,
    onRetrieval: (trace) => { retrieval = trace; },
  });
  assert.doesNotMatch(prompt, /not reached because/, "cascade failures do not consume the smallest continuation");
  assert.doesNotMatch(prompt, /diagnosticPadding/, "unrelated architecture padding stays out of the continuation");
  const plan = planCallReservation({ messages: [{ role: "user", content: prompt }] }, "gpt-5.5", {
    requestedMaxOutputTokens: 10_000,
    callCeilingCredits: 6,
    repairAllowanceCredits: 4,
    repairSizing: {
      retrievedFileCount: 1,
      retrievalTokens: retrieval.tokens,
      problemCount: 2,
      expectedPatchTokens: scope.expectedPatchTokens,
    },
    budget: {
      approvedCeilingCredits: 12,
      consumedCredits: 10.0107,
      reservedCredits: 0,
      remainingCredits: 1.9893,
    },
  });
  assert.ok(plan.maxOutputTokens >= 1_200, "the live remaining headroom fits a useful bounded response");
  assert.ok(plan.estimatedInputTokens > 0, "the dispatch records its deterministic prompt estimate");
});

test("an irreducible large component resizes to exact causal fragments inside retained headroom", async () => {
  const filePath = "src/components/A.jsx";
  const filler = Array.from({ length: 350 }, (_, index) => `  // unrelated retained line ${index}`).join("\n");
  const source = [
    'import { useState } from "react";',
    "export default function Planner() {",
    '  const [user, setUser] = useState(null);',
    '  const [project, setProject] = useState(null);',
    filler,
    '  function newProject() { setProject({ name: "Workspace Project" }); }',
    filler,
    '  if (!user) return <section><button onClick={newProject}>New Project control</button></section>;',
    '  return <main><h1>{project?.name || "No project selected"}</h1><p>Workspace header room setup</p></main>;',
    "}",
  ].join("\n");
  const fixture = oversizedModuleFixture({ source });
  const problem = JSON.stringify({
    code: "interaction_verification_failure", journeyId: "send-message",
    userAction: "create a new project",
    expectedOutcome: "project name appears in workspace header and room setup becomes editable",
    detail: "expected project, name, workspace, header, room; found project, name",
    responsibleModules: [filePath], stateOwners: [filePath],
  });
  const fullFileScope = headroomDispatchScope({
    tree: fixture.tree, modulePlan: fixture.modulePlan, moduleContracts: fixture.moduleContracts,
    problems: [problem], semanticFiles: [filePath], logicalStep: "repair",
  });
  const fragmentScope = headroomDispatchScope({
    tree: fixture.tree, modulePlan: fixture.modulePlan, moduleContracts: fixture.moduleContracts,
    problems: [problem], semanticFiles: [filePath], logicalStep: "repair", previousScope: fullFileScope,
  });
  assert.equal(fragmentScope.fragmented, true);
  assert.deepEqual(fragmentScope.allowedFiles, [filePath]);
  assert.equal(fragmentScope.remainingFiles.length, 0);
  const excerpt = fragmentScope.fragments.map((fragment) => fragment.content).join("\n");
  assert.match(excerpt, /newProject/);
  assert.match(excerpt, /if \(!user\)/);
  assert.ok(excerpt.length < source.length / 3, "unrelated retained source is not resent");
  assert.deepEqual(headroomSourceFragments(source, [problem]),
    fragmentScope.fragments.map(({ path: _path, ...fragment }) => fragment));

  let retrieval;
  const prompt = renderPatchPrompt({
    step: "repair", originalStep: "core", contract: CONTRACT, tiers: TIERS,
    tree: fixture.tree, modulePlan: fixture.modulePlan, moduleContracts: fixture.moduleContracts,
    problems: [problem], headroomScope: fragmentScope,
    onRetrieval: (trace) => { retrieval = trace; },
  });
  assert.match(prompt, /replace_exact/);
  assert.match(HEADROOM_FRAGMENT_SYSTEM_PROMPT, /changing labels, messages, or static copy merely to echo/i);
  assert.match(prompt, /Repair actual handler\/state\/conditional flow/);
  assert.doesNotMatch(prompt, /unrelated retained line 120/);
  const plan = planCallReservation({
    systemPrompt: HEADROOM_FRAGMENT_SYSTEM_PROMPT,
    messages: [{ role: "user", content: prompt }], tools: [EMIT_PATCHES_SCHEMA],
  }, "gpt-5.5", {
    requestedMaxOutputTokens: 10_000, callCeilingCredits: 6, repairAllowanceCredits: 4,
    repairSizing: { retrievedFileCount: 1, retrievalTokens: retrieval.tokens,
      problemCount: 1, expectedPatchTokens: fragmentScope.expectedPatchTokens },
    budget: { approvedCeilingCredits: 12, consumedCredits: 11.4303,
      reservedCredits: 0, remainingCredits: 0.5697 },
  });
  assert.ok(plan.maxOutputTokens >= 1_200);
  assert.ok(plan.estimatedInputTokens < 4_500, plan.estimatedInputTokens);

  let providerCalls = 0;
  const logs = [];
  const reservations = memoryModelReservations();
  const provider = {
    model: "gpt-5.5", provider: "openai",
    runTurn: async (options) => {
      providerCalls += 1;
      assert.match(options.messages[0].content, /RETAINED CANDIDATE MICRO-REPAIR/);
      return {
        text: "", toolCalls: [{ id: "micro", name: "emit_patches", arguments: { patches: [{
          file: filePath, ops: [{ op: "replace_exact", symbol: "if (!user)", content: "if (!user && !project)" }],
        }] } }],
        usage: { input: 500, output: 100, total: 600, providerRequestId: "req-micro" },
      };
    },
  };
  const lanes = createModelLanes({
    providerForStep: async () => ({ provider, decision: {
      provider: "openai", model: "gpt-5.5", billingLane: "connected_allowance",
      estimatedCredits: 2, callCeilingCredits: 6, maxOutputTokens: 10_000,
    } }),
    ceilingCredits: 0.5697, reservations, knowledgeStore: memoryKnowledgeStore(),
    log: (line) => logs.push(line),
  });
  const patches = await lanes.patchesFn({
    owner: "owner", projectId: "project", buildId: "micro-build", step: "repair", originalStep: "core",
    contract: CONTRACT, tiers: TIERS, tree: fixture.tree, rejections: [], problems: [problem],
    modulePlan: fixture.modulePlan, moduleContracts: fixture.moduleContracts,
  });
  assert.equal(providerCalls, 1, "full-file refusals occur before dispatch; only the micro prompt reaches the provider");
  assert.equal(reservations.rows().length, 1);
  assert.equal(patches.dispatchScope.fragmented, true);
  assert.match(logs.join("\n"), /resize 2/);
});

test("repair scoping parses the emitted journey evidence and ignores downstream undriveable cascades", () => {
  const problems = [
    'journey send-message Â· step "fill the form" FAILED in a real browser: control missing',
    'journey send-message Â· step "submit" FAILED in a real browser: not reached because step 1 was undriveable',
  ];
  assert.deepEqual(repairFailureReferences(problems), [{ journeyId: "send-message", action: "fill the form" }]);
});

test("primary browser evidence wins over simultaneous secondary first-step cascades", () => {
  const primary = JSON.stringify({ code: "interaction_verification_failure", journeyId: "primary-flow",
    userAction: "create a project", status: "fail", stateOwners: ["src/Primary.jsx"] });
  const secondary = JSON.stringify({ code: "interaction_verification_failure", journeyId: "secondary-flow",
    userAction: "open the project manager", status: "undriveable", stateOwners: ["src/Secondary.jsx"] });
  const contract = { journeys: [
    { id: "primary-flow", priority: "primary" }, { id: "secondary-flow", priority: "secondary" },
  ] };
  assert.deepEqual(causalRepairProblems(contract, [primary, secondary]), [primary]);
  assert.deepEqual(repairFailureOwnedPaths(contract, [primary, secondary]), ["src/Primary.jsx"]);
});

test("headroom batching maps verifier actions to their semantic owner before planned-module fallback", () => {
  const problems = ['journey planner-flow \u00b7 step "create a new project" FAILED in a real browser: name:missing'];
  const contract = { interactionContract: { flows: [{
    journeyId: "planner-flow",
    action: "create a new project",
    responsibleModules: ["src/components/CreatePlannerFlow.jsx"],
    stateOwner: "src/components/CreatePlannerFlow.jsx",
  }] } };
  const semanticFiles = repairFailureOwnedPaths(contract, problems);
  assert.deepEqual(semanticFiles, ["src/components/CreatePlannerFlow.jsx"]);
  const scope = headroomDispatchScope({
    tree: {
      "src/components/CreatePlannerFlow.jsx": "export function CreatePlannerFlow(){}",
      "src/components/Unrelated.jsx": "export function Unrelated(){}",
    },
    modulePlan: [
      { path: "src/components/Unrelated.jsx" },
      { path: "src/components/CreatePlannerFlow.jsx" },
    ],
    problems,
    semanticFiles,
    logicalStep: "repair",
  });
  assert.deepEqual(scope.allowedFiles, ["src/components/CreatePlannerFlow.jsx"]);
  assert.deepEqual(scope.remainingFiles, []);
});

test("production browser cascades batch the causal structured owner, never unrelated planned journeys", () => {
  const owner = "src/components/create-adjust-save-reopen-export-plan/CreateAdjustSaveReopenExportPlanFlow.jsx";
  const unrelated = "src/components/project-manager-crud/ProjectManagerCrudFlow.jsx";
  const problems = [
    'journey create-adjust-save-reopen-export-plan · step "create a new project" FAILED in a real browser: contracted control(s) could not be driven: name:missing',
    'journey project-manager-crud · step "open the project manager" FAILED in a real browser: not reached: the journey\'s required starting state could not be established (New Project control: no contracted control matched)',
    JSON.stringify({
      code: "interaction_verification_failure", journeyId: "create-adjust-save-reopen-export-plan",
      userAction: "create a new project", status: "undriveable",
      responsibleModules: [
        "src/components/create-adjust-save-reopen-export-plan/CreateAdjustSaveReopenExportPlanConfirmation.jsx",
        owner,
        "src/components/create-adjust-save-reopen-export-plan/CreateAdjustSaveReopenExportPlanOutput.jsx",
        "src/components/create-adjust-save-reopen-export-plan/CreateAdjustSaveReopenExportPlanStatus.jsx",
      ], stateOwners: [owner],
    }),
  ];
  const contract = { interactionContract: { flows: [
    { journeyId: "project-manager-crud", action: "open the project manager", responsibleModules: [unrelated] },
    { journeyId: "create-adjust-save-reopen-export-plan", action: "create a new project", responsibleModules: [owner] },
  ] } };
  assert.deepEqual(repairFailureReferences(problems), [
    { journeyId: "create-adjust-save-reopen-export-plan", action: "create a new project" },
    { journeyId: "create-adjust-save-reopen-export-plan", action: "create a new project" },
  ]);
  assert.deepEqual(repairFailureOwnedPaths(contract, problems), [owner]);
  const scope = headroomDispatchScope({
    tree: {
      [owner]: "export function Planner(){}", [unrelated]: "export function Projects(){}",
      "src/components/create-adjust-save-reopen-export-plan/CreateAdjustSaveReopenExportPlanConfirmation.jsx": "export function Confirmation(){}",
      "src/components/create-adjust-save-reopen-export-plan/CreateAdjustSaveReopenExportPlanOutput.jsx": "export function Output(){}",
      "src/components/create-adjust-save-reopen-export-plan/CreateAdjustSaveReopenExportPlanStatus.jsx": "export function Status(){}",
    },
    modulePlan: [{ path: unrelated }, { path: owner }], problems,
    semanticFiles: repairFailureOwnedPaths(contract, problems), logicalStep: "repair",
  });
  assert.deepEqual(scope.allowedFiles, [owner]);
  assert.deepEqual(scope.remainingFiles, []);
});

test("a single irreducible source fails closed after bounded zero-dispatch compaction", async () => {
  const fixture = oversizedModuleFixture({ source: `export function A(){return <pre>${"x".repeat(240_000)}</pre>}` });
  const scope = { kind: "compile", files: ["src/components/A.jsx"], allowedFiles: ["src/components/A.jsx"],
    allowedPrefixes: [], findings: [], expectedPatchTokens: 1_200, instruction: "Fix A only." };
  let providerCalls = 0;
  const provider = { model: "gpt-5.5", provider: "openai", runTurn: async () => { providerCalls += 1; return {}; } };
  const reservations = memoryModelReservations();
  const lanes = createModelLanes({
    providerForStep: async () => ({ provider, decision: {
      provider: "openai", model: "gpt-5.5", billingLane: "connected_allowance",
      estimatedCredits: 2, callCeilingCredits: 6, maxOutputTokens: 16_000,
    } }),
    ceilingCredits: 30, reservations, knowledgeStore: memoryKnowledgeStore(),
  });
  await assert.rejects(lanes.patchesFn({
    owner: "owner", projectId: "project", buildId: "build", step: "correction", originalStep: "core",
    contract: CONTRACT, tiers: TIERS, tree: fixture.tree, rejections: [], problems: ["src/components/A.jsx"],
    modulePlan: fixture.modulePlan, moduleContracts: fixture.moduleContracts, repairScope: scope,
  }), (error) => error.code === "smallest_scoped_call_exceeds_headroom" && error.headroomResizes === 1);
  assert.equal(providerCalls, 0, "neither oversized preflight is allowed onto the provider wire");
  assert.equal(reservations.rows().length, 0, "no unusable call acquires or consumes a reservation");
});

test("later headroom batches keep repair funding without consuming another logical repair slot", async () => {
  const fixture = oversizedModuleFixture({ source: "export function A(){return <section/>}" });
  const reservations = memoryModelReservations();
  const first = await reservations.reserve({
    owner: "owner", projectId: "project", buildId: "build", callKey: "first-repair", step: "repair",
    provider: "openai", model: "gpt-5.5", billingLane: "connected_allowance",
    usageResponsibility: "thrallo_repair", reservedCredits: 0.1, ceilingCredits: 30,
    maxRepairs: 1, maxCorrections: 2,
  });
  await reservations.settle("owner", first.id, {
    actualCredits: 0.1, usage: { input: 100, output: 20 }, providerRequestIds: ["req-first"],
  });
  const provider = fakePatchProvider({ patches: [{
    replaceFile: "src/components/A.jsx", content: "export function A(){return <section>A</section>}",
  }] });
  const lanes = createModelLanes({
    providerForStep: async () => ({ provider, decision: {
      provider: "openai", model: "gpt-5.5", billingLane: "connected_allowance",
      estimatedCredits: 2, callCeilingCredits: 6, maxOutputTokens: 16_000,
    } }),
    ceilingCredits: 30, reservations, maxRepairs: 1, knowledgeStore: memoryKnowledgeStore(),
  });
  await lanes.patchesFn({
    owner: "owner", projectId: "project", buildId: "build", step: "repair", originalStep: "core",
    contract: CONTRACT, tiers: TIERS, tree: fixture.tree, rejections: [], problems: [],
    modulePlan: fixture.modulePlan, moduleContracts: fixture.moduleContracts,
    headroomScope: {
      kind: "headroom_continuation", logicalStep: "repair", batchIndex: 1,
      files: ["src/components/A.jsx"], allowedFiles: ["src/components/A.jsx"], allowedPrefixes: [],
      remainingFiles: [], expectedPatchTokens: 1_000, instruction: "Complete A only.",
      moduleContracts: { version: 1, specifications: [fixture.moduleContracts.specifications[0]] },
    },
  });
  const continuation = reservations.rows().find((row) => row.callKey.includes("repair:headroom"));
  assert.ok(continuation, "the later call has a distinct durable continuation identity");
  assert.equal(continuation.step, "repair:headroom");
  assert.equal(continuation.usageResponsibility, "thrallo_repair");
  assert.equal(provider.calls.length, 1);
});

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
    runTurn: async () => ({ text: contractJson, toolCalls: [], usage: {
      input: 5000, output: 1500, cached: 0, reasoning: 0, total: 6500,
      providerRequestId: "codex:response:contract-1",
    } }),
  };
  const diag = fakeDiag();
  const knowledgeStore = memoryKnowledgeStore();
  await knowledgeStore.upsert({ owner: "o", project_id: "p", kind: "constraint", key: "brand", value: { text: "keep the existing farm name" } });
  const lanes = createModelLanes({ provider, ceilingCredits: 5, diag, knowledgeStore });
  const contract = await lanes.contractFn({ owner: "o", projectId: "p", request: "landing page" });
  assert.equal(contract.journeys[0].id, "send-message");
  assert.equal(contract.journeys[0].priority, "primary");
  const step = diag.steps.find((s) => /contract/.test(s.label));
  assert.ok(step, "contract call recorded");
  assert.match(step.prompt, /keep the existing farm name/, "persistent project knowledge reaches contract generation");
  assert.ok(step.usage.input >= 5000, `usage delta captured (got ${JSON.stringify(step.usage)})`);
  assert.deepEqual(step.usage.providerRequestIds, ["codex:response:contract-1"]);
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

// ── WP-12: retrieval-sliced context for edit and repair steps ─────────────────────────────────

test("WP12 — edit/repair context is retrieval-sliced under a hard budget, not whole-tree dumps", async () => {
  const { renderScopedContext } = await import("../../shell/server/lib/builderV2/modelLanes.mjs");
  const big = (name, filler) => `export default function ${name}() {\n  return (<main>${`<p>${filler}</p>`.repeat(400)}</main>);\n}`;
  const tree = {
    "src/App.jsx": 'import React from "react";\nexport default function App() { return null; }',
    "src/routes/BookPage.jsx": big("BookPage", "booking wizard slots"),
    "src/routes/FarmPage.jsx": big("FarmPage", "farm story panels"),
    "src/routes/VisitPage.jsx": big("VisitPage", "visit guidance"),
    "src/lib/capabilities/crud.js": "export function makeEntityStore() { return {}; }",
  };

  // Repair: the compiler named BookPage — its body must be IN, the unrelated pages must NOT be full.
  const repair = renderScopedContext(tree, {
    step: "repair",
    problems: ["compiler output:\nsrc/routes/BookPage.jsx:13:7: ERROR: something"],
  });
  assert.match(repair, /BookPage\.jsx — a verifier pointed here/);
  assert.match(repair, /booking wizard slots/, "the named file's BODY is present");
  assert.ok(!/farm story panels/.test(repair), "unrelated page bodies stay out");
  assert.match(repair, /FILE TREE \(paths only/, "the model still sees the full shape");

  // Edit: keyword targeting picks the file; identical inputs render byte-identically.
  let trace = null;
  const edit = renderScopedContext(tree, {
    step: "edit", editRequest: "update the visit guidance opening hours",
    capabilityPaths: ["src/lib/capabilities/crud.js"],
    onRetrieval: (value) => { trace = value; },
  });
  assert.match(edit, /VisitPage\.jsx — will be modified by this step/);
  assert.match(edit, /makeEntityStore/, "bound capability interfaces are integrated into retrieval");
  assert.equal(edit, renderScopedContext(tree, {
    step: "edit", editRequest: "update the visit guidance opening hours",
    capabilityPaths: ["src/lib/capabilities/crud.js"],
  }));
  assert.ok(Array.isArray(trace.included) && trace.included.length > 0,
    "the NOT NULL persisted trace receives the retrieval engine's complete included manifest");
  assert.ok(Number.isInteger(trace.omittedCount));
  assert.ok(trace.included.some((row) => row.path === "src/routes/VisitPage.jsx"));
});

test("WP11 — only an explicitly retry-safe pre-dispatch failure gets one retry", async () => {
  let calls = 0;
  const flaky = {
    model: "gpt-5.5",
    runTurn: async () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error("rejected before dispatch"), { retrySafe: true, dispatchState: "before_dispatch" });
      return { text: "", toolCalls: [{ id: "c", name: "emit_patches", arguments: { patches: [] } }], usage: { input: 10, output: 5, cached: 0, reasoning: 0, total: 15 } };
    },
  };
  const lanes = createModelLanes({ provider: flaky, ceilingCredits: 5, diag: null, log: () => {} });
  const patches = await lanes.patchesFn({ step: "core", contract: CONTRACT, tiers: TIERS, tree: {}, rejections: [], problems: [] });
  assert.deepEqual(patches, []);
  assert.equal(calls, 2, "one retry, then success");

  let modelErrCalls = 0;
  const badModel = {
    model: "gpt-5.5",
    runTurn: async () => { modelErrCalls += 1; throw new Error("Codex responses HTTP 400: bad tool schema"); },
  };
  const lanes2 = createModelLanes({ provider: badModel, ceilingCredits: 5, diag: null, log: () => {} });
  await assert.rejects(() => lanes2.patchesFn({ step: "core", contract: CONTRACT, tiers: TIERS, tree: {}, rejections: [], problems: [] }), /HTTP 400/);
  assert.equal(modelErrCalls, 1, "a real API error never retries");
});

test("ambiguous V2 transport failure settles known usage and blocks replay", async () => {
  let calls = 0;
  const seenOptions = [];
  const provider = {
    model: "gpt-5.5", provider: "openai",
    async runTurn(options) {
      seenOptions.push(options);
      calls += 1;
      if (calls === 1) throw Object.assign(new Error("terminated"), {
        usage: { input: 8, output: 0, total: 8 }, providerRequestId: "req-failed",
      });
      return {
        text: "", toolCalls: [{ id: "c", name: "emit_patches", arguments: { patches: [] } }],
        usage: { input: 10, output: 5, total: 15, providerRequestId: "req-ok" },
      };
    },
  };
  const reservations = memoryModelReservations();
  const controller = new AbortController();
  const lanes = createModelLanes({
    provider, providerForStep: async () => ({ provider, decision: { estimatedCredits: 1, provider: "openai" } }),
    ceilingCredits: 5, reservations, knowledgeStore: memoryKnowledgeStore(), log: () => {},
  });
  await assert.rejects(lanes.patchesFn({
    owner: "owner", projectId: "project", buildId: "build", step: "core",
    contract: CONTRACT, tiers: TIERS, tree: {}, rejections: [], problems: [], signal: controller.signal,
  }), (error) => error.code === "provider_replay_unsafe");
  assert.equal(calls, 1);
  const rows = reservations.rows();
  assert.equal(rows.length, 1, "ambiguous dispatch is never replayed");
  assert.deepEqual(rows.map((row) => row.providerRequestIds), [["req-failed"]]);
  assert.ok(rows.every((row) => row.reservedCredits >= 1));
  assert.ok(seenOptions.every((options) => options.maxOutputTokens === 16_000));
  assert.ok(seenOptions.every((options) => options.signal === controller.signal));
});

test("a stale managed allowance snapshot is refreshed before the only provider dispatch", async () => {
  let balanceReads = 0;
  let reserves = 0;
  let providerCalls = 0;
  const reservations = {
    budget: async () => ({ approvedCeilingCredits: 5, consumedCredits: 0, reservedCredits: 0, remainingCredits: 5 }),
    reserve: async (input) => {
      reserves += 1;
      if (reserves === 1) throw Object.assign(new Error("stale"), { code: "allowance_snapshot_stale" });
      assert.equal(input.accountBalance.usageRowCount, 2);
      return { id: "hold-refreshed", acquired: true };
    },
    settle: async () => ({}),
  };
  const provider = {
    model: "gpt-5.5", provider: "openai",
    runTurn: async () => {
      providerCalls += 1;
      return { text: "", toolCalls: [{ id: "c", name: "emit_patches", arguments: { patches: [] } }],
        usage: { input: 10, output: 5, total: 15 } };
    },
  };
  const lanes = createModelLanes({
    provider,
    providerForStep: async () => ({ provider, decision: { billingLane: "managed", estimatedCredits: 1 } }),
    ceilingCredits: 5,
    reservations,
    knowledgeStore: memoryKnowledgeStore(),
    accountCreditResolver: async () => ({ included: 5, purchased: 0, usageRowCount: ++balanceReads }),
  });
  await lanes.patchesFn({
    owner: "owner", projectId: "project", buildId: "build", step: "core",
    contract: CONTRACT, tiers: TIERS, tree: {}, rejections: [], problems: [],
  });
  assert.equal(balanceReads, 2);
  assert.equal(reserves, 2);
  assert.equal(providerCalls, 1);
});

test("a successful provider response with failed settlement stops without rewriting telemetry", async () => {
  let settles = 0;
  const ambiguous = [];
  const reservations = {
    reserve: async () => ({ id: "hold-1" }),
    settle: async () => { settles += 1; throw new Error("settlement unavailable"); },
    markAmbiguous: async (owner, id, input) => { ambiguous.push({ owner, id, input }); },
  };
  const provider = {
    model: "gpt-5.5",
    runTurn: async () => ({
      text: "", toolCalls: [{ id: "c", name: "emit_patches", arguments: { patches: [] } }],
      usage: { input: 10, output: 5, total: 15, providerRequestId: "req-success" },
    }),
  };
  const lanes = createModelLanes({
    provider, ceilingCredits: 5, reservations, knowledgeStore: memoryKnowledgeStore(),
  });
  await assert.rejects(lanes.patchesFn({
    owner: "owner", projectId: "project", buildId: "build", step: "core",
    contract: CONTRACT, tiers: TIERS, tree: {}, rejections: [], problems: [],
  }), (error) => error.code === "provider_replay_unsafe"
    && error.providerRequestId === "req-success");
  assert.equal(settles, 1, "a settlement acknowledgement failure is not settled again as empty provider telemetry");
  assert.deepEqual(ambiguous, [{
    owner: "owner", id: "hold-1", input: {
      reason: "provider completed but settlement failed: settlement unavailable",
      providerRequestIds: ["req-success"],
    },
  }]);
});

test("qualification correction calls retain qualification funding responsibility", async () => {
  const reserved = [];
  const reservations = {
    reserve: async (input) => { reserved.push(input); return { id: "qualification-hold" }; },
    settle: async () => ({}),
  };
  const provider = {
    model: "gpt-5.5",
    runTurn: async () => ({
      text: "", toolCalls: [{ id: "c", name: "emit_patches", arguments: { patches: [] } }],
      usage: { input: 10, output: 5, total: 15, providerRequestId: "req-qualification" },
    }),
  };
  const lanes = createModelLanes({
    provider, ceilingCredits: 5, reservations, knowledgeStore: memoryKnowledgeStore(),
    defaultUsageResponsibility: "qualification",
  });
  await lanes.patchesFn({
    owner: "owner", projectId: "project", buildId: "build", step: "correction",
    contract: CONTRACT, tiers: TIERS, tree: {}, rejections: [], problems: [],
  });
  assert.equal(reserved[0].usageResponsibility, "qualification");
});
