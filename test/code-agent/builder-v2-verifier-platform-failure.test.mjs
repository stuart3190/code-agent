import test from "node:test";
import assert from "node:assert/strict";

import { createOrchestrator, memoryBuildStore } from "../../shell/server/lib/builderV2/orchestrator.mjs";
import { createSnapshotStore } from "../../shell/server/lib/builderV2/snapshotStore.mjs";
import {
  MINIMAL_CONTRACT_VERIFIER_POLICY,
  VERIFICATION_RESULT_CLASS,
} from "../../shell/server/lib/appBuild/verifierPolicy.mjs";
import { REACT_VITE } from "../../src/scaffolds/reactVite.mjs";
import { clone, fromScaffold } from "../../src/engine/fileTree.mjs";

const CONTRACT = {
  summary: "Booking site",
  entities: [{ name: "booking" }],
  operations: [{ id: "create-booking", description: "create a booking" }],
  routes: [{ path: "/", name: "Home" }],
  auth: { required: false },
  journeys: [{ id: "book", title: "Book", priority: "primary",
    steps: [{ action: "submit the booking form", expect: "booking confirmed" }] }],
};

const CORE_PATCH = [{
  replaceFile: "src/screens/scaffold/HomeScreen.jsx",
  content: `import { useState } from "react";
import { makeBookingSystem } from "../../lib/capabilities/index.js";
const booking = makeBookingSystem({ entity: "booking" });
export default function HomeScreen() {
  const [done, setDone] = useState(false);
  return <main><h1>Booking</h1><button onClick={async () => {
    await booking.createBooking({ date: "2026-08-20", slot: "10:00", partySize: 2 });
    setDone(true);
  }}>Submit booking</button>
    {done ? <p>Booking confirmed</p> : null}</main>;
}`,
}];

function harness(browserResult, contract = CONTRACT) {
  const patchCalls = [];
  const snapshotStore = createSnapshotStore();
  const orchestrator = createOrchestrator({
    contractFn: async () => contract,
    patchesFn: async ({ step }) => {
      patchCalls.push(step);
      if (step === "core") return CORE_PATCH;
      return [{ file: "src/screens/scaffold/HomeScreen.jsx", ops: [{ op: "append", content: "\n// must not run\n" }] }];
    },
    assetService: { resolveIntents: async () => ({ resolved: [], providerCalls: 0 }) },
    snapshotStore,
    buildStore: memoryBuildStore(),
    journeysFn: async () => browserResult,
    baseTree: () => clone(fromScaffold(REACT_VITE)),
    baseline: REACT_VITE,
    maxJourneyRepairs: 1,
  });
  return { orchestrator, patchCalls };
}

test("a derived platform-inconclusive journey defect stops before repair", async () => {
  const h = harness({
    verifierPolicy: MINIMAL_CONTRACT_VERIFIER_POLICY,
    journeys: [{
      ...CONTRACT.journeys[0],
      status: "undriveable",
      steps: [{
        ...CONTRACT.journeys[0].steps[0],
        status: "undriveable",
        classification: VERIFICATION_RESULT_CLASS.PLATFORM_INCONCLUSIVE,
        drove: false,
        detail: "the driver could not establish a unique contracted control",
      }],
    }],
    blockingErrors: [],
    consoleErrors: [],
    failedRequests: [],
    mechanics: { failures: [] },
  });

  const result = await h.orchestrator.runBuild({
    owner: "owner",
    projectId: "project-derived-platform-defect",
    request: "booking site",
  });

  assert.equal(result.state, "blocked", JSON.stringify(result));
  assert.equal(result.failureClassification, "verification_platform_defect", JSON.stringify(result));
  assert.ok(result.platformDefects.some((defect) => defect.owner === "platform"), JSON.stringify(result));
  assert.ok(result.workingSnapshotId, "the candidate remains available for zero-model re-verification");
  assert.deepEqual(h.patchCalls, ["core"], "a derived platform defect must not dispatch correction or repair");
});

test("mixed platform and application defects retain application repair authority", async () => {
  const contract = {
    ...CONTRACT,
    journeys: [{
      ...CONTRACT.journeys[0],
      steps: [
        ...CONTRACT.journeys[0].steps,
        { action: "review the booking confirmation", expect: "booking confirmed" },
      ],
    }],
  };
  const h = harness({
    verifierPolicy: MINIMAL_CONTRACT_VERIFIER_POLICY,
    journeys: [{
      ...contract.journeys[0],
      status: "fail",
      steps: [{
        ...contract.journeys[0].steps[0],
        status: "undriveable",
        classification: VERIFICATION_RESULT_CLASS.PLATFORM_INCONCLUSIVE,
        drove: false,
        detail: "the driver could not establish a unique contracted control",
      }, {
        ...contract.journeys[0].steps[1],
        status: "fail",
        classification: VERIFICATION_RESULT_CLASS.APP_FUNCTIONAL_FAILURE,
        drove: true,
        detail: "the expected confirmation was not visible",
      }],
    }],
    blockingErrors: [],
    consoleErrors: [],
    failedRequests: [],
    mechanics: { failures: [] },
  }, contract);

  const result = await h.orchestrator.runBuild({
    owner: "owner",
    projectId: "project-mixed-defects",
    request: "booking site",
  });

  assert.equal(result.state, "blocked", JSON.stringify(result));
  assert.equal(result.failureClassification, "contracted_journeys_red", JSON.stringify(result));
  assert.ok(h.patchCalls.some((step) => step === "repair"), JSON.stringify(h.patchCalls));
});

for (const [name, browserResult, expectedCode] of [
  ["unavailable verifier", { unavailable: true, error: "preview transport unavailable", journeys: [] },
    "journey_verifier_unavailable"],
  ["invalid verifier fixture", {
    verifierDefects: [{ code: "verifier_fixture_invalid", field: "sourceIdea",
      detail: "the verifier fixture violates the control's native constraints" }],
    journeys: [{ id: "book", title: "Book", priority: "primary", status: "undriveable", steps: [] }],
  }, "verifier_fixture_invalid"],
  ["platform app-auth rate limit", {
    verifierDefects: [{ code: "journey_verifier_auth_rate_limited",
      detail: "the platform app-auth verifier identity was rate limited" }],
    failedRequests: ["429 POST https://example.supabase.co/functions/v1/app-auth"],
    journeys: [{ id: "book", title: "Book", priority: "primary", status: "undriveable", steps: [] }],
  }, "journey_verifier_auth_rate_limited"],
]) {
  test(`${name} preserves the candidate and spends zero repair turns`, async () => {
    const h = harness(browserResult);
    const result = await h.orchestrator.runBuild({ owner: "owner", projectId: `project-${expectedCode}`,
      request: "booking site" });
    assert.equal(result.state, "blocked", JSON.stringify(result));
    assert.equal(result.failureClassification, "verification_platform_defect", JSON.stringify(result));
    assert.ok(result.platformDefects.some((defect) => defect.code === expectedCode), JSON.stringify(result));
    assert.ok(result.workingSnapshotId, "the candidate remains available for zero-model re-verification");
    assert.deepEqual(h.patchCalls, ["core"], "a verifier defect must not dispatch correction or repair");
  });
}
