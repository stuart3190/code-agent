import test from "node:test";
import assert from "node:assert/strict";

import { validateContract } from "../../shell/shared/implementationContract.mjs";
import { isKeyboardFocusOnlyStep } from "../../shell/server/lib/builderV2/interactionSemantics.mjs";
import { buildInteractionContract } from "../../shell/server/lib/builderV2/interactionContract.mjs";

function softwareCatalogue(steps) {
  return {
    version: 2,
    summary: "A browser-session software catalogue with accessible filtering controls",
    projectType: "tool",
    auth: { required: false, model: null, rules: [] },
    routes: [{ path: "/", name: "Catalogue" }],
    entities: [{
      name: "catalogueSession",
      persistence: "transient",
      fields: [
        { name: "searchQuery", type: "string", required: false },
        { name: "categoryFilter", type: "string", required: false },
        { name: "platformFilter", type: "string", required: false },
      ],
    }],
    operations: [],
    journeys: [{
      id: "use-catalogue-controls",
      title: "Use labelled catalogue controls",
      priority: "primary",
      stage: "polish",
      steps,
      acceptance: [],
    }],
    integrations: [],
    states: [],
    acceptance: [
      { id: "a1", journey: "use-catalogue-controls", kind: "accessibility",
        statement: "search and filter controls expose accessible labels and visible focus states" },
      { id: "a2", journey: "use-catalogue-controls", kind: "functional",
        statement: "the entered search text remains visible in the current browser session" },
      { id: "a3", journey: "use-catalogue-controls", kind: "functional",
        statement: "selected filters remain visible in the current browser session" },
    ],
    deferred: [],
  };
}

test("keyboard focus steps require concrete operated fields and a driveable primitive", () => {
  const contract = softwareCatalogue([
    {
      action: "open the catalogue page",
      target: "/",
      expect: "the catalogue search and filter controls are visible",
    },
    {
      action: "focus the search and filter controls using keyboard navigation",
      target: "catalogue controls",
      expect: "each control has a visible focus state and an accessible text label",
    },
  ]);

  const verdict = validateContract(contract);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.problems.some((problem) => /without naming their operated entity field/.test(problem)));
  assert.ok(verdict.problems.some((problem) => /without a driveable primitive/.test(problem)));
});

test("split keyboard focus steps derive exact textbox and selection controls", () => {
  const contract = softwareCatalogue([
    {
      action: "focus and enter a catalogue search using keyboard navigation",
      target: "catalogue search",
      operates: ["searchQuery"],
      primitive: "textbox",
      expect: "the search control has a visible focus state and retains the entered text",
    },
    {
      action: "tab through and choose the catalogue filters",
      target: "catalogue filters",
      operates: ["categoryFilter", "platformFilter"],
      primitive: "selection",
      expect: "each filter has an accessible text label and the selected values remain visible",
    },
  ]);

  assert.equal(validateContract(contract).ok, true);
  const interaction = buildInteractionContract(contract);
  assert.equal(interaction.valid, true, JSON.stringify(interaction.problems));
  const flows = interaction.flows;
  assert.deepEqual(flows.map((flow) => [flow.valueWritten, flow.kind]), [
    ["searchQuery", "input"],
    ["categoryFilter", "selection"],
    ["platformFilter", "selection"],
  ]);
  assert.ok(flows.every((flow) => flow.control?.machineId && flow.control?.accessibleName));
});

test("focus-only steps retain primitive identity without declaring a value write", () => {
  const steps = [
    {
      action: "move keyboard focus to the catalogue search control",
      target: "catalogue search",
      operates: ["searchQuery"],
      primitive: "textbox",
      expect: "a visible focus indicator appears on the labelled search control",
    },
    {
      action: "move keyboard focus to a catalogue category filter",
      target: "category filter",
      operates: ["categoryFilter"],
      primitive: "selection",
      expect: "a visible focus indicator appears on the labelled category filter",
    },
  ];
  const contract = softwareCatalogue(steps);
  assert.equal(validateContract(contract).ok, true);
  assert.equal(isKeyboardFocusOnlyStep(steps[0]), true);
  assert.equal(isKeyboardFocusOnlyStep({ ...steps[0], action: "focus and enter a search query" }), false);
  const interaction = buildInteractionContract(contract);
  assert.equal(interaction.valid, true, JSON.stringify(interaction.problems));
  const flows = interaction.flows;
  assert.deepEqual(flows.map((flow) => [flow.kind, flow.interactionMode, flow.writes]), [
    ["input", "keyboard_focus", []],
    ["selection", "keyboard_focus", []],
  ]);
  assert.ok(flows.every((flow) => flow.control?.machineId && flow.control?.statePath));
});
