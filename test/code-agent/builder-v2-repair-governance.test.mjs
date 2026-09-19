// REPAIR GOVERNANCE: ownership before patching, feasibility before dispatch, reclassification
// instead of blind regeneration.
//
// Retained: repair rounds were spent on defects the application could not fix (a producer chain the
// contract never declared, a verifier that could not run, a sandbox missing shell/shared), scoped
// repairs failed on scope because the boundary omitted the modules the fix had to touch or named a
// planned module the tree never contained, and a repair that moved nothing was escalated to
// regenerate its owner although the control was bound and operated. Each rule below is a pure
// decision over the defects and the tree - no provider, no prose.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  REPAIR_OWNERSHIP, bindingSitesOf, classifyRepairOwnership, dependencyClosure, governRepairRound,
  reclassifyStalledDefects, repairFeasibility,
} from "../../shell/server/lib/builderV2/repairGovernance.mjs";
import { DEFECT_CLASS, DEFECT_OWNER, REPAIR_TIER } from "../../shell/server/lib/builderV2/verificationDefects.mjs";
import { controlIdFor } from "../../shell/server/lib/builderV2/verificationManifest.mjs";

const appDefect = (overrides = {}) => ({
  code: "contracted_outcome_missing", defectClass: DEFECT_CLASS.BEHAVIOUR, owner: DEFECT_OWNER.APP, tier: REPAIR_TIER.REPAIR,
  journeyId: "create-task", stepIndex: 2, action: "create the task",
  control: { id: controlIdFor("task.status"), logicalField: "status", scope: "task" },
  modules: ["src/screens/scaffold/ProjectScreen.jsx"], failureRefs: ["src/screens/scaffold/ProjectScreen.jsx"],
  evidence: { expected: "the task appears", observed: "no task row appeared", drove: true },
  ...overrides,
});

const TREE = {
  "src/screens/scaffold/ProjectScreen.jsx": `import React from "react";
import { useSemanticField, useSemanticSelection } from "../../lib/capabilities/react.js";
import { TaskForm } from "../../components/TaskForm.jsx";
import { taskStore } from "../../lib/tasks.js";
export default function ProjectScreen() { const status = useSemanticSelection({ name: "status", scope: "task" }); return <TaskForm status={status} store={taskStore} />; }
`,
  "src/components/TaskForm.jsx": `import React from "react";
import { useSemanticField } from "../lib/capabilities/react.js";
export function TaskForm({ status, store }) { const title = useSemanticField({ name: "title", scope: "task" }); return <form><input {...title.inputProps} /></form>; }
`,
  "src/lib/tasks.js": `import { db } from "./backend/index.js";
export const taskStore = db.entity("task");
`,
  "src/screens/scaffold/BoardScreen.jsx": `import React from "react";
import { taskStore } from "../../lib/tasks.js";
export default function BoardScreen() { return <main>{String(Boolean(taskStore))}</main>; }
`,
  "src/lib/capabilities/react.js": "export const useSemanticField = () => ({ inputProps: {} }); export const useSemanticSelection = () => ({});",
  "src/lib/backend/index.js": "export const db = { entity: () => ({}) };",
};

test("ownership: contract, prerequisite, verifier, provider and packaging defects are never the application's", () => {
  const cases = [
    [{ code: "prerequisite_contract_invalid", defectClass: DEFECT_CLASS.CONTRACT, owner: DEFECT_OWNER.PLATFORM, tier: REPAIR_TIER.NONE }, REPAIR_OWNERSHIP.CONTRACT_INVALID],
    [{ code: "verification_evidence_contract_mismatch", defectClass: DEFECT_CLASS.CONTRACT, owner: DEFECT_OWNER.PLATFORM, tier: REPAIR_TIER.NONE }, REPAIR_OWNERSHIP.CONTRACT_INVALID],
    [{ code: "journey_prerequisites_unmet", defectClass: DEFECT_CLASS.UNKNOWN, owner: DEFECT_OWNER.UNKNOWN, tier: REPAIR_TIER.REPAIR, modules: [],
      evidence: { observed: "the journey's starting state could not be established" } }, REPAIR_OWNERSHIP.PREREQUISITE_MISSING],
    [{ code: "journey_verifier_unavailable", defectClass: DEFECT_CLASS.PLATFORM, owner: DEFECT_OWNER.PLATFORM, tier: REPAIR_TIER.NONE,
      evidence: { observed: "browser_verify exited 1: Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/app/shell/shared/implementationContract.mjs'" } }, REPAIR_OWNERSHIP.PACKAGING_RUNTIME],
    [{ code: "journey_verifier_defect", defectClass: DEFECT_CLASS.PLATFORM, owner: DEFECT_OWNER.PLATFORM, tier: REPAIR_TIER.NONE,
      evidence: { observed: "provider rate limit reached (429) before verification" } }, REPAIR_OWNERSHIP.PLATFORM_PROVIDER],
    [{ code: "journey_verifier_defect", defectClass: DEFECT_CLASS.PLATFORM, owner: DEFECT_OWNER.PLATFORM, tier: REPAIR_TIER.NONE,
      evidence: { observed: "the browser context crashed while loading the preview" } }, REPAIR_OWNERSHIP.VERIFIER_INVALID],
  ];
  for (const [defect, expected] of cases) {
    const decision = classifyRepairOwnership(defect, { tree: TREE });
    assert.equal(decision.ownership, expected, `${defect.code}: ${decision.reason}`);
    assert.ok(decision.reason.length > 10);
  }
  // A prerequisite whose named producer RAN and produced nothing is the producer's generated defect.
  const producerFailed = classifyRepairOwnership({ code: "prerequisite_durable_outcome_missing", defectClass: DEFECT_CLASS.DURABILITY,
    owner: DEFECT_OWNER.APP, tier: REPAIR_TIER.REPAIR, control: { id: controlIdFor("create-project") },
    modules: ["src/screens/scaffold/ProjectScreen.jsx"], evidence: { expected: "a project row", observed: "none" } }, { tree: TREE });
  assert.equal(producerFailed.ownership, REPAIR_OWNERSHIP.GENERATED_APP);
});

test("ownership: an attributed application failure is the application's; browser ambiguity is decided by the tree", () => {
  assert.equal(classifyRepairOwnership(appDefect(), { tree: TREE }).ownership, REPAIR_OWNERSHIP.GENERATED_APP);
  const ambiguous = appDefect({ owner: DEFECT_OWNER.UNKNOWN, uncertain: true,
    evidence: { addressing: { reason: "ambiguous_identity" }, observed: "3 visible controls share the identity" } });
  // The tree binds task.status once: the ambiguity is not a duplicate the app wrote.
  assert.equal(classifyRepairOwnership(ambiguous, { tree: TREE }).ownership, REPAIR_OWNERSHIP.UNDETERMINED);
  // Two bindings of the same identity in the tree: the app's own duplicate.
  const duplicated = { ...TREE, "src/components/StatusAgain.jsx": `import { useSemanticSelection } from "../lib/capabilities/react.js";
export function StatusAgain() { const status = useSemanticSelection({ name: "status", scope: "task" }); return null; }` };
  assert.equal(classifyRepairOwnership(ambiguous, { tree: duplicated }).ownership, REPAIR_OWNERSHIP.GENERATED_APP);
  assert.deepEqual(bindingSitesOf(duplicated, ambiguous.control).map((site) => site.file).sort(),
    ["src/components/StatusAgain.jsx", "src/screens/scaffold/ProjectScreen.jsx"]);
  // An unscoped `status` binding is another entity's control, not this one.
  assert.deepEqual(bindingSitesOf(TREE, { id: controlIdFor("status"), logicalField: "status" }), []);
});

test("the dependency closure follows imports transitively and importers one level, platform modules as read context", () => {
  const closure = dependencyClosure(TREE, ["src/screens/scaffold/ProjectScreen.jsx"]);
  assert.deepEqual(closure.files, ["src/components/TaskForm.jsx", "src/lib/tasks.js", "src/screens/scaffold/ProjectScreen.jsx"]);
  assert.deepEqual(closure.importers, [], "nothing imports the screen");
  assert.deepEqual(closure.platformContext, ["src/lib/backend/index.js", "src/lib/capabilities/react.js"]);
  const shared = dependencyClosure(TREE, ["src/lib/tasks.js"]);
  assert.deepEqual(shared.importers, ["src/screens/scaffold/BoardScreen.jsx", "src/screens/scaffold/ProjectScreen.jsx"],
    "a changed shared module must keep every consumer satisfied");
  assert.deepEqual(dependencyClosure(TREE, ["src/lib/planned.js"]).missing, ["src/lib/planned.js"]);
});

test("feasibility: an exact boundary that cannot reach the bound control escalates before dispatch; a missing module regenerates", () => {
  // The verifier attributed the failure to the store module, but task.status is BOUND in the screen.
  const defect = appDefect({ modules: ["src/lib/tasks.js"], failureRefs: ["src/lib/tasks.js"] });
  const narrow = { kind: "browser_repair_boundary", allowedFiles: ["src/lib/tasks.js"], allowedPrefixes: [] };
  const exact = repairFeasibility({ tree: TREE, defects: [defect], boundary: narrow, strategy: "exact_owning_file_repair" });
  assert.equal(exact.feasible, false);
  assert.equal(exact.escalateTo, "causal_dependency_repair");
  assert.deepEqual(exact.outsideBoundary, ["src/screens/scaffold/ProjectScreen.jsx"]);
  assert.ok(exact.contextFiles.includes("src/lib/backend/index.js"), "the full read closure travels with the repair");
  assert.ok(exact.contextFiles.includes("src/screens/scaffold/BoardScreen.jsx"), "the store's other consumer is read context");
  // A defect with no control identity keeps the exact strategy: nothing proves the boundary short.
  const anonymous = repairFeasibility({ tree: TREE, defects: [appDefect({ control: null, modules: ["src/lib/tasks.js"] })], boundary: narrow, strategy: "exact_owning_file_repair" });
  assert.equal(anonymous.feasible, true, anonymous.reasons.join("; "));
  const causal = repairFeasibility({ tree: TREE, defects: [defect], strategy: "causal_dependency_repair",
    boundary: { kind: "browser_repair_dependency_boundary", allowedFiles: ["src/lib/tasks.js", "src/screens/scaffold/ProjectScreen.jsx", "src/screens/scaffold/BoardScreen.jsx"] } });
  assert.equal(causal.feasible, true, causal.reasons.join("; "));
  const planned = repairFeasibility({ tree: TREE, defects: [appDefect({ modules: ["src/lib/planned.js"], failureRefs: [] })],
    boundary: { allowedFiles: ["src/lib/planned.js"] }, strategy: "exact_owning_file_repair" });
  assert.equal(planned.feasible, false);
  assert.equal(planned.escalateTo, "owner_module_regeneration");
  assert.deepEqual(planned.missingModules, ["src/lib/planned.js"]);
});

test("the round gate dispatches only generated_app defects and names who owns the rest", () => {
  const prerequisite = { code: "journey_prerequisites_unmet", defectClass: DEFECT_CLASS.UNKNOWN, owner: DEFECT_OWNER.UNKNOWN,
    tier: REPAIR_TIER.REPAIR, journeyId: "filter-board", stepIndex: null, modules: [], evidence: { observed: "starting state could not be established" } };
  const mixed = governRepairRound({ tree: TREE, defects: [appDefect(), prerequisite], strategy: "exact_owning_file_repair",
    boundary: { allowedFiles: ["src/screens/scaffold/ProjectScreen.jsx"] } });
  assert.equal(mixed.dispatchable.length, 1);
  assert.deepEqual(mixed.withheld.map((row) => [row.journeyId, row.ownership]), [["filter-board", REPAIR_OWNERSHIP.PREREQUISITE_MISSING]]);
  assert.equal(mixed.stopReason, null);
  const onlyPrerequisite = governRepairRound({ tree: TREE, defects: [prerequisite], strategy: "exact_owning_file_repair" });
  assert.deepEqual(onlyPrerequisite.dispatchable, []);
  assert.equal(onlyPrerequisite.stopReason, "repair_withheld_prerequisite_missing");
  const contract = governRepairRound({ tree: TREE, defects: [{ code: "prerequisite_contract_invalid", defectClass: DEFECT_CLASS.CONTRACT,
    owner: DEFECT_OWNER.PLATFORM, tier: REPAIR_TIER.NONE, journeyId: "x" }] });
  assert.equal(contract.stopReason, "repair_withheld_contract_invalid");
});

test("a stalled defect on a bound, operated control is reclassified as undetermined instead of regenerating its owner", () => {
  const stalled = appDefect();
  const before = reclassifyStalledDefects([stalled], { tree: TREE, strategiesTried: ["exact_owning_file_repair"] });
  assert.equal(before.reclassified.length, 0, "one scoped strategy is not yet a stall");
  const after = reclassifyStalledDefects([stalled], { tree: TREE, strategiesTried: ["exact_owning_file_repair", "causal_dependency_repair"] });
  assert.equal(after.reclassified.length, 1);
  assert.equal(after.defects[0].repairOwnership, REPAIR_OWNERSHIP.UNDETERMINED);
  assert.equal(after.defects[0].tier, REPAIR_TIER.NONE);
  assert.equal(after.defects[0].owner, DEFECT_OWNER.UNKNOWN);
  assert.match(after.defects[0].repairOwnershipReason, /bound \(src\/screens\/scaffold\/ProjectScreen\.jsx\)/);
  // A control bound NOWHERE keeps the application as owner: regeneration is justified.
  const unbound = appDefect({ control: { id: controlIdFor("task.dueDate"), logicalField: "dueDate", scope: "task" } });
  const kept = reclassifyStalledDefects([unbound], { tree: TREE, strategiesTried: ["exact_owning_file_repair", "causal_dependency_repair"] });
  assert.equal(kept.reclassified.length, 0);
  assert.equal(kept.defects[0].repairOwnership, REPAIR_OWNERSHIP.GENERATED_APP);
  assert.equal(kept.defects[0].tier, REPAIR_TIER.REPAIR);
  // No identity evidence at all: the existing ladder decides, nothing is reclassified.
  const anonymous = appDefect({ control: null });
  assert.equal(reclassifyStalledDefects([anonymous], { tree: TREE, strategiesTried: ["exact_owning_file_repair", "causal_dependency_repair"] }).reclassified.length, 0);
});
