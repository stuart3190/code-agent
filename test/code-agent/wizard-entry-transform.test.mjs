import assert from "node:assert/strict";
import test from "node:test";

import {
  transformWizardEntryState,
} from "../../shell/server/lib/appBuild/wizardEntryTransform.mjs";
import { runStageGate } from "../../shell/server/lib/appBuild/stageGate.mjs";

const contractFor = (name = "Start booking control") => ({
  interactionContract: { flows: [{ kind: "flow_start", control: { accessibleName: name } }] },
});

const treeFor = ({ first = "intro", impossible = "home", name = "Start booking control" } = {}) => ({
  "src/data/wizard.js": `import { makeWizardMachine } from "../lib/capabilities";
export const STEPS = [{ id: "${first}", label: "Start" }, { id: "details", label: "Details" }];
export const bookingWizard = makeWizardMachine({ id: "booking", steps: STEPS });`,
  "src/components/Flow.jsx": `import { bookingWizard } from "../data/wizard";
import { useCapabilityState, useSemanticAction } from "../lib/capabilities";
export function Flow() {
  const wizard = useCapabilityState(bookingWizard);
  const rawStepId = wizard.stepId || wizard.currentStep || wizard.step;
  const stepId = rawStepId || "${impossible}";
  const start = useSemanticAction({ name: "${name}", label: "${name}", onActivate() {} });
  const showStart = stepId === "${impossible}" && !wizard.values?.flowStarted;
  return <main>{showStart && <button aria-label="${name}" {...start.buttonProps}>Start</button>}</main>;
}`,
});

test("retained live shape — an impossible contracted wizard-entry guard aligns to the declared first step", () => {
  const tree = treeFor();
  const result = transformWizardEntryState(tree, { contract: contractFor() });
  assert.equal(result.changes.length, 1);
  assert.deepEqual(result.changes.map(({ from, to }) => ({ from, to })), [{ from: "home", to: "intro" }]);
  assert.match(result.tree["src/components/Flow.jsx"], /const showStart = stepId === "intro"/);
  assert.match(result.tree["src/components/Flow.jsx"], /rawStepId \|\| "home"/,
    "only the provably impossible visibility predicate changes");
});

test("non-booking flow — the transform derives names and entry state from the app, not domain words", () => {
  const tree = treeFor({ first: "welcome", impossible: "landing", name: "Start checkout control" });
  const result = transformWizardEntryState(tree, { contract: contractFor("Start checkout control") });
  assert.equal(result.changes.length, 1);
  assert.equal(result.changes[0].to, "welcome");
  assert.match(result.tree["src/components/Flow.jsx"], /stepId === "welcome"/);
});

test("a dynamic step declaration is ambiguous and is never rewritten", () => {
  const tree = treeFor();
  tree["src/data/wizard.js"] = `import { makeWizardMachine } from "../lib/capabilities";
export const bookingWizard = makeWizardMachine({ id: "booking", steps: getStepsFromProductConfig() });`;
  const result = transformWizardEntryState(tree, { contract: contractFor() });
  assert.equal(result.changes.length, 0);
  assert.strictEqual(result.tree, tree);
});

test("an unrelated conditional cannot be rewritten merely because the file has a start control", () => {
  const tree = treeFor();
  tree["src/components/Flow.jsx"] = tree["src/components/Flow.jsx"]
    .replace("{showStart && <button", "{true && <button");
  const result = transformWizardEntryState(tree, { contract: contractFor() });
  assert.equal(result.changes.length, 0);
});

test("the stage gate adopts the zero-model wizard correction before compilation", async () => {
  const generated = treeFor();
  const tree = {
    ...generated,
    "src/lib/capabilities/index.js": "export const makeWizardMachine = () => ({}); export const useCapabilityState = () => ({}); export const useSemanticAction = () => ({});",
    "package.json": JSON.stringify({ type: "module", scripts: { build: "vite build" } }),
    "index.html": '<div id="root"></div>',
    "vite.config.js": "export default {}",
    "src/main.jsx": "export default null",
  };
  let compiled = null;
  const result = await runStageGate(tree, {
    contract: contractFor(),
    compile: async (candidate) => { compiled = candidate; return { ok: true }; },
  });
  assert.equal(result.ok, true);
  assert.equal(result.deterministicRepair?.applied?.[0]?.code, "wizard_entry_state_aligned");
  assert.match(compiled["src/components/Flow.jsx"], /stepId === "intro"/);
  assert.equal(result.tree, compiled);
});
