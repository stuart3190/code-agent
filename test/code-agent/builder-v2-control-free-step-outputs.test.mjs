import test from "node:test";
import assert from "node:assert/strict";

import {
  buildInteractionContract,
  validateInteractionContract,
} from "../../shell/server/lib/builderV2/interactionContract.mjs";

test("a catalogue opening step can produce state consumed by a later selection", () => {
  const journeyId = "manage-session-software";
  const contract = {
    entities: [{
      name: "catalogueSession",
      fields: [
        { name: "visibleSoftwareIds", type: "array", required: false },
        { name: "selectedSoftwareId", type: "string", required: false },
      ],
    }],
    operations: [],
    journeys: [{
      id: journeyId,
      steps: [
        {
          action: "open the software catalogue",
          expect: "software cards are visible",
          produces: ["visibleSoftwareIds"],
        },
        {
          action: "select a software card",
          expect: "the software detail panel is visible",
          primitive: "selection",
          operates: ["selectedSoftwareId"],
          reads: ["visibleSoftwareIds"],
        },
      ],
    }],
  };

  const plan = buildInteractionContract(contract, { modulePlan: [], bindings: [] });
  const producedPath = `${journeyId}.draft.visibleSoftwareIds`;
  const producer = plan.flows.find((flow) => flow.stepIndex === 0
    && flow.writes?.includes(producedPath));
  const consumer = plan.flows.find((flow) => flow.stepIndex === 1
    && flow.valueWritten === "selectedSoftwareId");

  assert.ok(producer, "the explicit control-free producer was discarded");
  assert.ok(consumer?.reads.includes(producedPath));
  assert.equal(validateInteractionContract(plan).problems.some((problem) => (
    problem.includes("reads state before it is produced")
  )), false);
});
