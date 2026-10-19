import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { applyPatches } from "../../shell/server/lib/builderV2/patchEngine.mjs";
import { renderBoundedEditPrompt, renderPatchPrompt } from "../../shell/server/lib/builderV2/modelLanes.mjs";
import { headroomRetryConsumesAttempt } from "../../shell/server/lib/builderV2/orchestrator.mjs";
import {
  classifyEditRequest, directEditEnabled, directEditFailureMessage, renderDirectEditPrompt, settleDirectEdit,
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
  const settled = settleDirectEdit({ spentCredits: 2.13, outcome: "fallback" });
  assert.equal(settled.profile, "direct_edit");
  assert.equal(settled.compensationEligible, false);
  assert.equal(settled.creditsProtected, false);
  assert.equal(customerFailureMessage({ code: "direct_edit_unchanged", consumedCredits: 2.13 }).includes("2.13"), true);
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
