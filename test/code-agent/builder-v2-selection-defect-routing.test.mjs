import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFECT_CLASS,
  DEFECT_OWNER,
  REPAIR_TIER,
  verificationDefects,
} from "../../shell/server/lib/builderV2/verificationDefects.mjs";
import {
  MINIMAL_CONTRACT_VERIFIER_POLICY,
  VERIFICATION_RESULT_CLASS,
} from "../../shell/server/lib/appBuild/verifierPolicy.mjs";

test("a missing contracted catalogue option stays repairable when control identity is ambiguous", () => {
  const journeyId = "inspect-software-catalogue";
  const controlId = "ctl_catalogue_selection";
  const owner = "src/screens/CatalogueScreen.jsx";
  const requiredValue = "atlas-notes";
  const contract = {
    journeys: [{
      id: journeyId,
      steps: [{
        action: "Select Atlas Notes from the software catalogue",
        expect: "the detail panel shows Atlas Notes",
      }],
    }],
    operations: [],
  };
  const interactionContract = {
    flows: [{
      id: "flow_catalogue_selection",
      journeyId,
      stepIndex: 0,
      kind: "selection",
      stateOwner: owner,
      responsibleModules: [owner],
      control: {
        machineId: controlId,
        logicalField: "selectedSoftwareId",
        roles: ["button"],
        accessibleNames: ["Select software"],
      },
    }],
  };
  const journeyResults = {
    verifierPolicy: MINIMAL_CONTRACT_VERIFIER_POLICY,
    mechanics: {
      outcomes: [],
      failures: [],
      skipped: [{
        id: controlId,
        reason: "ambiguous_identity",
        candidates: 2,
        addressedBy: "identity",
      }],
    },
    journeys: [{
      id: journeyId,
      owners: [owner],
      steps: [{
        status: "undriveable",
        drove: false,
        classification: VERIFICATION_RESULT_CLASS.PLATFORM_INCONCLUSIVE,
        action: "Select Atlas Notes from the software catalogue",
        expect: "the detail panel shows Atlas Notes",
        detail: `the contracted verification value "${requiredValue}" is not an available option`,
        controlEvidence: {
          fixtureAuthority: "contract",
          verificationValue: requiredValue,
          selectedOptions: [{ value: "atlas-reader", label: "Atlas Reader" }],
        },
      }],
    }],
  };

  const defects = verificationDefects({
    contract,
    interactionContract,
    journeyResults,
    manifest: {
      mapping: { [controlId]: { logicalField: "selectedSoftwareId" } },
    },
  });
  const defect = defects.find((row) => row.control?.id === controlId);

  assert.ok(defect);
  assert.equal(defect.defectClass, DEFECT_CLASS.INTERACTION);
  assert.equal(defect.owner, DEFECT_OWNER.UNKNOWN);
  assert.equal(defect.uncertain, true);
  assert.equal(defect.tier, REPAIR_TIER.REPAIR);
});
