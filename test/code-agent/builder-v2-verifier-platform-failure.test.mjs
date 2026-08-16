import test from "node:test";
import assert from "node:assert/strict";

import { createOrchestrator, memoryBuildStore } from "../../shell/server/lib/builderV2/orchestrator.mjs";
import { createSnapshotStore } from "../../shell/server/lib/builderV2/snapshotStore.mjs";
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
  newFile: "src/routes/BookingPanel.jsx",
  content: `import { useState } from "react";
import { makeBookingSystem } from "../lib/capabilities/index.js";
const booking = makeBookingSystem({ entity: "booking" });
export default function BookingPanel() {
  const [done, setDone] = useState(false);
  return <main><h1>Booking</h1><button onClick={async () => {
    await booking.createBooking({ date: "2026-08-20", slot: "10:00", partySize: 2 });
    setDone(true);
  }}>Submit booking</button>
    {done ? <p>Booking confirmed</p> : null}</main>;
}`,
}];

function harness(browserResult) {
  const patchCalls = [];
  const snapshotStore = createSnapshotStore();
  const orchestrator = createOrchestrator({
    contractFn: async () => CONTRACT,
    patchesFn: async ({ step }) => {
      patchCalls.push(step);
      if (step === "core") return CORE_PATCH;
      return [{ file: "src/routes/HomePage.jsx", ops: [{ op: "append", content: "\n// must not run\n" }] }];
    },
    assetService: { resolveIntents: async () => ({ resolved: [], providerCalls: 0 }) },
    snapshotStore,
    buildStore: memoryBuildStore(),
    journeysFn: async () => browserResult,
    baseTree: () => clone(fromScaffold(REACT_VITE)),
    baseline: REACT_VITE,
  });
  return { orchestrator, patchCalls };
}

for (const [name, browserResult, expectedCode] of [
  ["unavailable verifier", { unavailable: true, error: "preview transport unavailable", journeys: [] },
    "journey_verifier_unavailable"],
  ["invalid verifier fixture", {
    verifierDefects: [{ code: "verifier_fixture_invalid", field: "sourceIdea",
      detail: "the verifier fixture violates the control's native constraints" }],
    journeys: [{ id: "book", title: "Book", priority: "primary", status: "undriveable", steps: [] }],
  }, "verifier_fixture_invalid"],
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
