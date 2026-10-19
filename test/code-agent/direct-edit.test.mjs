import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { applyPatches } from "../../shell/server/lib/builderV2/patchEngine.mjs";
import { createModelLanes, renderBoundedEditPrompt, renderPatchPrompt } from "../../shell/server/lib/builderV2/modelLanes.mjs";
import { memoryModelReservations } from "../../shell/server/lib/builderV2/modelReservations.mjs";
import { headroomRetryConsumesAttempt } from "../../shell/server/lib/builderV2/orchestrator.mjs";
import {
  classifyEditRequest, directEditCeilings, directEditEnabled, directEditFailureMessage,
  renderDirectEditPrompt, runDirectEdit, settleDirectEdit,
} from "../../shell/server/lib/builderV2/directEdit.mjs";
import { customerFailureMessage } from "../../shell/server/lib/builderV2/buildFailure.mjs";
import {
  FIXTURE_DIR, FLOW, loadFixtureTree, recordedCentimetrePatches, runOfflineHarness,
} from "../../scripts/direct-edit-offline.mjs";

test("an insert_after_symbol excerpt of one declaration resolves to that declaration", async () => {
  const tree = await loadFixtureTree();
  const patches = recordedCentimetrePatches(await readFile(`${FIXTURE_DIR}/patches.txt`, "utf8"));
  const applied = applyPatches(tree, patches);
  assert.equal(applied.rejected.length, 0, JSON.stringify(applied.rejected));
  assert.equal(applied.applied.length, 4);
  assert.match(applied.tree[FLOW], /Centimetres \(cm\)/);
  assert.match(applied.tree[FLOW], /function withCentimetreDisplays|const withCentimetreDisplays/);
});

test("a symbol that is not a name and not a unique excerpt still lists present symbols", async () => {
  const tree = await loadFixtureTree();
  const applied = applyPatches(tree, [{
    file: FLOW,
    ops: [{ op: "insert_after_symbol", symbol: "const presets = this excerpt is not in the file at all", content: "const extra = 1;\n" }],
  }]);
  assert.equal(applied.applied.length, 0);
  assert.match(applied.rejected[0].reason, /present symbols:/);
  assert.match(applied.rejected[0].reason, /\bpresets\b/);
});

test("the bounded edit prompt shows rejections and the continuation instruction", () => {
  const rejection = 'symbol "const presets = []" not found in src/Flow.jsx — present symbols: presets';
  const prompt = renderBoundedEditPrompt({
    editRequest: "Add centimeters (cm) as an option",
    tree: { "src/Flow.jsx": "const presets = [];\n" },
    headroomScope: { allowedFiles: ["src/Flow.jsx"], instruction: "Retry only the rejected file." },
    rejections: [{ reason: rejection }],
  });
  assert.match(prompt, /Add centimeters \(cm\) as an option/);
  assert.match(prompt, /Retry only the rejected file/);
  assert.match(prompt, /PREVIOUS EXACT-SOURCE PATCH REJECTIONS \(authoritative\)/);
  assert.match(prompt, /present symbols: presets/);
  const viaScoped = renderPatchPrompt({
    step: "edit",
    editRequest: "Add centimeters (cm) as an option",
    tree: { "src/Flow.jsx": "const presets = [];\n" },
    headroomScope: { allowedFiles: ["src/Flow.jsx"], instruction: "Retry only the rejected file." },
    rejections: [{ reason: rejection }],
    problems: [],
  });
  assert.match(viaScoped, /present symbols: presets/);
});

test("an identical unbriefed headroom retry is free once, then it counts", () => {
  const reason = 'symbol "presets line" not found — present symbols: presets';
  const fed = [{ reason }];
  assert.equal(headroomRetryConsumesAttempt({
    fedRejections: fed, producedRejections: [{ reason }], briefedRejections: [], unbriefedHeadroomRetries: 0,
  }), false);
  assert.equal(headroomRetryConsumesAttempt({
    fedRejections: fed, producedRejections: [{ reason }], briefedRejections: [], unbriefedHeadroomRetries: 1,
  }), true);
  assert.equal(headroomRetryConsumesAttempt({
    fedRejections: fed, producedRejections: [{ reason }], briefedRejections: [reason], unbriefedHeadroomRetries: 0,
  }), true);
  assert.equal(headroomRetryConsumesAttempt({
    fedRejections: [], producedRejections: [{ reason }], briefedRejections: [],
  }), true);
  assert.equal(headroomRetryConsumesAttempt({
    fedRejections: fed, producedRejections: [{ reason }],
  }), true);
});

test("direct edit classification and spend copy stay honest", () => {
  assert.equal(classifyEditRequest("Add centimeters (cm) as an option in the unit selector").size, "small");
  assert.equal(classifyEditRequest("add user accounts and save plans").size, "large");
  assert.equal(classifyEditRequest("change the label", { proposal: "large" }).route, "full_pipeline");
  assert.equal(directEditEnabled({}), true);
  assert.equal(directEditEnabled({ THRALLO_DIRECT_EDIT: "0" }), false);
  assert.equal(directEditEnabled({ THRALLO_DIRECT_EDIT: "off" }), false);
  const message = directEditFailureMessage(2.13);
  assert.match(message, /unchanged/);
  assert.match(message, /2\.13/);
  assert.doesNotMatch(message, /protected/i);
  const infraMessage = directEditFailureMessage(1.06, { infra: true });
  assert.match(infraMessage, /preview check didn't finish/);
  assert.match(infraMessage, /1\.06/);
  assert.doesNotMatch(infraMessage, /protected/i);
  const settled = settleDirectEdit({ spentCredits: 2.13, outcome: "fallback" });
  assert.equal(settled.profile, "direct_edit");
  assert.equal(settled.compensationEligible, false);
  assert.equal(settled.creditsProtected, false);
  assert.equal(customerFailureMessage({ code: "direct_edit_unchanged", consumedCredits: 2.13 }).includes("2.13"), true);
  assert.match(customerFailureMessage({ code: "direct_edit_infra", consumedCredits: 1.06 }), /preview check didn't finish/);
  assert.match(customerFailureMessage({ code: "direct_edit_infra", consumedCredits: 1.06 }), /1\.06/);
  assert.deepEqual(directEditCeilings({}), { callCeilingCredits: 1.5, jobCeilingCredits: 3 });
  assert.deepEqual(directEditCeilings({
    THRALLO_DIRECT_EDIT_CALL_CEILING: "1.25",
    THRALLO_DIRECT_EDIT_JOB_CEILING: "2.5",
  }), { callCeilingCredits: 1.25, jobCeilingCredits: 2.5 });
  assert.deepEqual(directEditCeilings({ THRALLO_DIRECT_EDIT_CALL_CEILING: "nope" }), {
    callCeilingCredits: 1.5, jobCeilingCredits: 3,
  });
  const prompt = renderDirectEditPrompt({
    request: "Add centimeters (cm)",
    tree: { [FLOW]: "const presets = [];\n" },
    turns: [{ role: "user", content: "can you add cm as a unit" }],
    rejections: [{ reason: "present symbols: presets" }],
  });
  assert.match(prompt, /FILE TREE/);
  assert.match(prompt, /can you add cm as a unit/);
  assert.match(prompt, /present symbols: presets/);
});

test("offline harness replays the BeamPlan direct edit", async () => {
  const report = await runOfflineHarness({ live: true });
  assert.equal(report.ok, true, report.lines.join("\n"));
  assert.equal(report.results.live.skipped, true);
});

test("a compile error still buys exactly one corrected model call", async () => {
  const tree = await loadFixtureTree();
  const patches = recordedCentimetrePatches(await readFile(`${FIXTURE_DIR}/patches.txt`, "utf8"));
  let compiles = 0;
  const prompts = [];
  const outcome = await runDirectEdit({
    request: "Add centimeters (cm) as an option",
    tree,
    modelFn: async ({ prompt }) => {
      prompts.push(prompt);
      return { patches, credits: 0.4 };
    },
    compileFn: async () => {
      compiles += 1;
      return compiles === 1 ? { ok: false, error: "vite failed: unexpected token" } : { ok: true };
    },
    smokeFn: async () => ({ pass: true }),
  });
  assert.equal(outcome.modelCalls, 2);
  assert.equal(compiles, 2);
  assert.match(prompts[1], /unexpected token/);
  assert.equal(outcome.outcome, "applied");
});

test("a prompt that cannot fit the direct-edit ceiling escalates before a paid call", async () => {
  const provider = {
    calls: [],
    model: "gpt-5.5",
    providerId: "codex",
    runTurn: async (args) => {
      provider.calls.push(args);
      return {
        text: "",
        toolCalls: [{ name: "emit_patches", arguments: { patches: [] } }],
        usage: { input: 20, output: 20, total: 40, providerRequestId: "codex:response:fit" },
      };
    },
  };
  const reservations = memoryModelReservations();
  const lanes = createModelLanes({
    provider,
    ceilingCredits: 40,
    reservations,
    providerForStep: async () => ({
      provider,
      decision: {
        provider: "codex", model: "gpt-5.5", billingLane: "connected_allowance",
        estimatedCredits: 0.5, callCeilingCredits: 4, maxOutputTokens: 8_000,
      },
    }),
  });
  const outcome = await runDirectEdit({
    request: "Add centimeters (cm) as an option",
    tree: { "src/App.jsx": "export default function App(){return null}\n" },
    modelFn: (call) => lanes.directEditFn({
      owner: "owner", projectId: "project", buildId: "direct-edit-fit",
      ...call,
      prompt: `${call.prompt}\n${"x".repeat(220_000)}`,
    }),
  });
  assert.equal(provider.calls.length, 0);
  assert.equal(outcome.modelCalls, 0);
  assert.equal(outcome.spentCredits, 0);
  assert.equal(outcome.outcome, "escalate");
  assert.equal(outcome.route, "full_pipeline");
  assert.equal(reservations.rows().some((row) => row.state === "settled"), false);
});

test("a fitting direct edit reserves at most the 1.5 credit call ceiling", async () => {
  const provider = {
    calls: [],
    model: "gpt-5.5",
    providerId: "codex",
    runTurn: async (args) => {
      provider.calls.push(args);
      return {
        text: "",
        toolCalls: [{
          name: "emit_patches",
          arguments: {
            patches: [{
              file: "src/App.jsx",
              ops: [{ op: "replace_exact", symbol: "return null", content: "return null" }],
            }],
          },
        }],
        usage: { input: 200, output: 80, total: 280, providerRequestId: "codex:response:cap" },
      };
    },
  };
  const reservations = memoryModelReservations();
  const lanes = createModelLanes({
    provider,
    ceilingCredits: 40,
    reservations,
    providerForStep: async () => ({
      provider,
      decision: {
        provider: "codex", model: "gpt-5.5", billingLane: "connected_allowance",
        estimatedCredits: 0.5, callCeilingCredits: 4, maxOutputTokens: 8_000,
      },
    }),
  });
  const outcome = await runDirectEdit({
    request: "Add centimeters (cm) as an option",
    tree: { "src/App.jsx": "export default function App(){return null}\n" },
    modelFn: (call) => lanes.directEditFn({
      owner: "owner", projectId: "project", buildId: "direct-edit-cap",
      ...call,
    }),
    compileFn: async () => ({ ok: true }),
    smokeFn: async () => ({ pass: true }),
  });
  assert.equal(outcome.outcome, "applied");
  assert.equal(provider.calls.length, 1);
  const settled = reservations.rows().filter((row) => row.state === "settled");
  assert.equal(settled.length, 1);
  assert.equal(settled[0].metadata.budgetPlan.callCeilingCredits, 1.5);
  assert.ok(settled[0].reservedCredits <= 1.5);
  assert.ok(settled[0].reservedCredits > 0);
});

test("the second call is capped by whatever job budget remains", async () => {
  const tree = await loadFixtureTree();
  const patches = recordedCentimetrePatches(await readFile(`${FIXTURE_DIR}/patches.txt`, "utf8"));
  const ceilings = [];
  const outcome = await runDirectEdit({
    request: "Add centimeters (cm) as an option",
    tree,
    callCeilingCredits: 1.5,
    jobCeilingCredits: 1.2,
    modelFn: async ({ callCeilingCredits }) => {
      ceilings.push(callCeilingCredits);
      return { patches, credits: ceilings.length === 1 ? 1.06 : 0.1 };
    },
    compileFn: async () => ({ ok: true }),
    smokeFn: async () => ({ pass: false, fatalErrors: ["TypeError: spacing is not a function"] }),
  });
  assert.deepEqual(ceilings, [1.2, 0.14]);
  assert.equal(outcome.modelCalls, 2);
  assert.equal(outcome.outcome, "fallback");
});
