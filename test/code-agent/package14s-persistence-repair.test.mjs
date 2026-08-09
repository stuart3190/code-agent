import { test } from "node:test";
import assert from "node:assert/strict";

import { buildTree, ensureDeps } from "../../harness/workspace.mjs";
import { fromScaffold } from "../../src/engine/fileTree.mjs";
import { REACT_VITE } from "../../src/scaffolds/reactVite.mjs";
import {
  bookingModulePlan, persistenceOwnershipPlan, tierContract,
} from "../../shell/server/lib/builderV2/contractTiering.mjs";
import { renderPatchPrompt } from "../../shell/server/lib/builderV2/modelLanes.mjs";
import { createOrchestrator, memoryBuildStore } from "../../shell/server/lib/builderV2/orchestrator.mjs";
import {
  lintDurablePersistence, persistenceRepairScope,
} from "../../shell/server/lib/builderV2/persistenceLint.mjs";
import { createSnapshotStore } from "../../shell/server/lib/builderV2/snapshotStore.mjs";

const BOOKING = Object.freeze({
  summary: "A durable multi-step table booking application",
  entities: [{ name: "booking" }],
  operations: [{ id: "create-booking", entity: "booking", action: "create" }],
  routes: [{ path: "/", name: "Booking" }], auth: { required: false },
  journeys: [{
    id: "recover-booking", title: "Create, review, recover and cancel a booking", priority: "primary",
    steps: [
      { action: "select date, slot, party and contact", expect: "Booking review" },
      { action: "confirm booking", expect: "Booking confirmed with reference" },
      { action: "reload", expect: "Confirmed booking restored" },
      { action: "cancel", expect: "Booking cancelled" },
    ],
  }],
});

const bookingSystem = `
import { makeBookingSystem } from "../lib/capabilities/index.js";
const booking = makeBookingSystem({ entity: "booking" });
export async function create(input){ return booking.createBooking(input); }
export async function recover(reference){ return booking.getBooking(reference); }
export async function cancel(reference){ return booking.cancelBooking(reference); }
`;

const bookingWizard = `
import { makeWizardMachine } from "../lib/capabilities/index.js";
const wizard = makeWizardMachine({ id: "booking", steps: ["date", "slot", "details", "review", "confirmation"] });
wizard.getState(); wizard.subscribe(() => {}); wizard.restore(); wizard.select("date", "2026-08-20");
wizard.next(); wizard.confirm(); wizard.cancel();
export { wizard };
`;

// Reproduces the retained live failure's evidence-backed two-call API/file shape. The cleaned-up
// live run retained exact diagnostics, not the complete source bytes.
const retainedBookingFlow = `
import React, { useState } from "react";
import { create, recover, cancel } from "../../data/bookingSystem.js";

export function BookingFlow(){
  const [message, setMessage] = useState("Booking review");
  async function confirmBooking(){
    const booking = await create({ date: "2026-08-20", slot: "18:00", partySize: 2 });
    sessionStorage.setItem("booking-reference", booking.reference);
    setMessage("Booking confirmed with reference");
  }
  async function restoreBooking(){
    const reference = sessionStorage.getItem("booking-reference");
    await recover(reference); setMessage("Confirmed booking restored");
  }
  async function cancelBooking(){ await cancel("BK-1"); setMessage("Booking cancelled"); }
  return <section><p>{message}</p><button onClick={confirmBooking}>Confirm</button>
    <button onClick={restoreBooking}>Restore</button><button onClick={cancelBooking}>Cancel</button></section>;
}
`;

const correctedBookingFlow = `
import React, { useState } from "react";
import { create, recover, cancel } from "../../data/bookingSystem.js";

export function BookingFlow(){
  const [message, setMessage] = useState("Booking review");
  async function confirmBooking(){ await create({ date: "2026-08-20", slot: "18:00", partySize: 2 }); setMessage("Booking confirmed with reference"); }
  async function restoreBooking(){ await recover("BK-1"); setMessage("Confirmed booking restored"); }
  async function cancelBooking(){ await cancel("BK-1"); setMessage("Booking cancelled"); }
  return <section><p>{message}</p><button onClick={confirmBooking}>Confirm</button>
    <button onClick={restoreBooking}>Restore</button><button onClick={cancelBooking}>Cancel</button></section>;
}
`;

const plannedPresentation = {
  "src/components/booking/BookingReview.jsx": "export function BookingReview(){ return <section>Booking review</section>; }",
  "src/components/booking/BookingConfirmation.jsx": "export function BookingConfirmation(){ return <section>Booking confirmed with reference</section>; }",
  "src/components/booking/BookingStatus.jsx": "export function BookingStatus(){ return <section>Confirmed booking restored Booking cancelled</section>; }",
};

function candidateTree(flow = retainedBookingFlow) {
  const tree = fromScaffold(REACT_VITE);
  tree["src/data/bookingSystem.js"] = bookingSystem;
  tree["src/data/bookingWizard.js"] = bookingWizard;
  tree["src/components/booking/BookingFlow.jsx"] = flow;
  Object.assign(tree, plannedPresentation);
  tree["src/routes/HomePage.jsx"] = `
import { BookingFlow } from "../components/booking/BookingFlow.jsx";
import { BookingReview } from "../components/booking/BookingReview.jsx";
import { BookingConfirmation } from "../components/booking/BookingConfirmation.jsx";
import { BookingStatus } from "../components/booking/BookingStatus.jsx";
export default function HomePage(){ return <main><BookingFlow/><BookingReview/><BookingConfirmation/><BookingStatus/></main>; }
`;
  tree["src/App.jsx"] = `import HomePage from "./routes/HomePage.jsx"; export default function App(){ return <HomePage/>; }`;
  return tree;
}

function fullCandidatePatches(flow = retainedBookingFlow) {
  const tree = candidateTree(flow);
  const scaffold = fromScaffold(REACT_VITE);
  return Object.entries(tree).filter(([path, content]) => scaffold[path] !== content)
    .map(([path, content]) => scaffold[path] === undefined ? { newFile: path, content } : { replaceFile: path, content });
}

test("14S persistence ownership is machine-readable in the plan and hard generation prompt", () => {
  const modulePlan = bookingModulePlan(BOOKING, BOOKING.journeys);
  const ownership = persistenceOwnershipPlan(BOOKING, BOOKING.journeys, modulePlan);
  assert.deepEqual(ownership.durableJourneys, ["recover-booking"]);
  assert.ok(ownership.forbiddenBusinessPersistence.includes("sessionStorage"));
  assert.equal(ownership.modules.find((row) => row.path.endsWith("BookingFlow.jsx")).survivesReload, false);
  assert.match(ownership.modules.find((row) => row.path.endsWith("BookingFlow.jsx")).durableStateOwner,
    /makeBookingSystem.*makeWizardMachine/);
  const prompt = renderPatchPrompt({ step: "core", contract: BOOKING, tiers: tierContract(BOOKING),
    tree: fromScaffold(REACT_VITE), modulePlan });
  assert.match(prompt, /PERSISTENCE OWNERSHIP CONTRACT \(machine-enforced JSON; hard constraints/);
  assert.match(prompt, /"sessionStorage"/);
  assert.match(prompt, /BookingFlow\.jsx[\s\S]*ephemeral UI orchestration only[\s\S]*survivesReload=false/);
  assert.match(prompt, /makeBookingSystem \+ makeWizardMachine/);
});

test("14S early AST persistence verdict is precise and remains strict for every forbidden store", () => {
  const modulePlan = bookingModulePlan(BOOKING, BOOKING.journeys);
  const tree = candidateTree();
  tree["src/data/badMemory.js"] = `let bookingState = null; export function save(row){ bookingState = row; }`;
  tree["src/routes/Other.jsx"] = `export function Other(){ localStorage.setItem("x", "1"); indexedDB.open("x"); new IndexedDB(); return null; }`;
  const verdict = lintDurablePersistence(tree, { contract: BOOKING, journeys: BOOKING.journeys, modulePlan });
  assert.equal(verdict.ok, false);
  const apis = new Set(verdict.findings.map((row) => row.api));
  for (const api of ["localStorage", "sessionStorage", "indexedDB", "IndexedDB", "process_memory"]) assert.ok(apis.has(api), api);
  const retained = verdict.findings.filter((row) => row.file.endsWith("BookingFlow.jsx"));
  assert.equal(retained.length, 2);
  assert.ok(retained.every((row) => row.code === "forbidden_persistence" && row.line > 0));
  assert.ok(retained.every((row) => row.journeys.includes("recover-booking")));
  assert.ok(retained.every((row) => row.requiredOwners.includes("makeBookingSystem")
    && row.requiredOwners.includes("makeWizardMachine")));

  const corrected = lintDurablePersistence(candidateTree(correctedBookingFlow), {
    contract: BOOKING, journeys: BOOKING.journeys, modulePlan,
  });
  assert.equal(corrected.ok, true, JSON.stringify(corrected.findings));
});

test("14S candidate snapshots are immutable, resumable and unpromotable until validated", async () => {
  const snapshots = createSnapshotStore();
  const candidate = await snapshots.createSnapshot("owner", "project", candidateTree(), {
    buildId: "build", reason: "candidate:core:1",
  });
  await assert.rejects(snapshots.promote("owner", "project", "green", candidate.id), /cannot promote/);
  assert.deepEqual(await snapshots.materialize("owner", candidate.id), candidateTree());
  const working = await snapshots.markCandidateValidated("owner", "project", candidate.id, { reason: "working:core" });
  assert.equal(working.reason, "working:core");
  await snapshots.promote("owner", "project", "green", working.id);
  assert.equal(await snapshots.pointer("owner", "project", "green"), working.id);
});

test("14S retained sessionStorage candidate repairs from checkpoint without replaying contract/core", async () => {
  const snapshots = createSnapshotStore();
  const patchCalls = [];
  const checkpoints = [];
  let contractCalls = 0;
  let compileCalls = 0;
  const orchestrator = createOrchestrator({
    contractFn: async () => { contractCalls += 1; return BOOKING; },
    patchesFn: async (input) => {
      patchCalls.push(input);
      if (input.step === "core") return fullCandidatePatches();
      assert.equal(input.step, "repair");
      assert.equal(input.originalStep, "core");
      assert.equal(input.repairScope.kind, "precompile_persistence");
      assert.deepEqual(input.repairScope.files, ["src/components/booking/BookingFlow.jsx"]);
      return [{ replaceFile: "src/components/booking/BookingFlow.jsx", content: correctedBookingFlow }];
    },
    assetService: {
      async resolveIntents() { return { resolved: [], providerCalls: 0 }; },
      async assetManifestFor() { return []; },
    },
    snapshotStore: snapshots, buildStore: memoryBuildStore(), baseTree: () => fromScaffold(REACT_VITE),
    baseline: REACT_VITE,
    compile: async () => { compileCalls += 1; return { ok: true }; },
    journeysFn: async ({ journeys }) => ({ journeys: journeys.map((journey) => ({ ...journey, status: "pass" })) }),
    events: { checkpoint: async (event) => checkpoints.push(event) },
  });
  const result = await orchestrator.runBuild({ owner: "owner", projectId: "project", request: "durable booking" });
  assert.equal(result.state, "green", JSON.stringify(result));
  assert.equal(contractCalls, 1);
  assert.deepEqual(patchCalls.map((call) => call.step), ["core", "repair"]);
  assert.equal(compileCalls, 1, "invalid candidate never reaches compilation");
  const invalid = checkpoints.find((row) => row.reason === "candidate:core:1");
  assert.ok(invalid?.snapshot?.id);
  assert.match((await snapshots.getSnapshot(invalid.snapshot.id)).reason, /^candidate:/,
    "the rejected candidate remains immutable and resumable evidence");
  assert.doesNotMatch(result.state === "green" ? correctedBookingFlow : retainedBookingFlow,
    /localStorage|sessionStorage|indexedDB/);
});

test("14S pre-compile repair scope is limited to the offending file and relevant adapters/interfaces", () => {
  const modulePlan = bookingModulePlan(BOOKING, BOOKING.journeys);
  const verdict = lintDurablePersistence(candidateTree(), { contract: BOOKING, journeys: BOOKING.journeys, modulePlan });
  const scope = persistenceRepairScope(verdict, modulePlan);
  assert.deepEqual(scope.files, ["src/components/booking/BookingFlow.jsx"]);
  assert.ok(scope.allowedFiles.includes("src/data/bookingSystem.js"));
  assert.ok(scope.allowedFiles.includes("src/data/bookingWizard.js"));
  assert.ok(scope.capabilityPaths.includes("src/lib/capabilities/booking.js"));
  assert.ok(scope.capabilityPaths.includes("src/lib/capabilities/wizard.js"));
  let trace = null;
  const prompt = renderPatchPrompt({ step: "repair", contract: BOOKING, tiers: tierContract(BOOKING),
    tree: candidateTree(), modulePlan, repairScope: scope,
    problems: verdict.findings.map((row) => row.message), onRetrieval: (value) => { trace = value; } });
  assert.deepEqual(trace.included.filter((row) => row.form === "full").map((row) => row.path),
    ["src/components/booking/BookingFlow.jsx"]);
  assert.match(prompt, /Remove browser\/process-local business persistence/);
  assert.match(prompt, /PROJECT KNOWLEDGE: omitted for this deterministic pre-compile repair/);
  assert.doesNotMatch(prompt, /const booking = makeBookingSystem/,
    "the adapter body is not sent when its interface is sufficient");
});

test("14S crash recovery locates a candidate checkpoint and resumes repair without contract/core replay", async () => {
  const snapshots = createSnapshotStore();
  const source = await snapshots.createSnapshot("owner", "project", candidateTree(), {
    buildId: "failed-source", reason: "candidate:core:1",
  });
  let patchCalls = 0;
  let compileCalls = 0;
  const orchestrator = createOrchestrator({
    contractFn: async () => { throw new Error("contract must not replay"); },
    patchesFn: async ({ step }) => {
      patchCalls += 1;
      assert.equal(step, "repair");
      return [{ replaceFile: "src/components/booking/BookingFlow.jsx", content: correctedBookingFlow }];
    },
    assetService: { async resolveIntents() { throw new Error("assets must not replay"); },
      async assetManifestFor() { return []; } },
    snapshotStore: snapshots, buildStore: memoryBuildStore(), baseTree: () => fromScaffold(REACT_VITE),
    baseline: REACT_VITE, compile: async () => { compileCalls += 1; return { ok: true }; },
    journeysFn: async ({ journeys }) => ({ journeys: journeys.map((journey) => ({ ...journey, status: "pass" })) }),
  });
  const resumed = await orchestrator.resumeWorkingContext("owner", "project", "failed-source");
  assert.equal(resumed.snapshotId, source.id);
  assert.equal(resumed.reason, "candidate:core:1");
  const result = await orchestrator.runRepairFromCheckpoint({ owner: "owner", projectId: "project",
    sourceBuildId: "failed-source", request: "remove forbidden persistence", contract: BOOKING,
    initialProblems: ["forbidden_persistence"] });
  assert.equal(result.state, "green", JSON.stringify(result));
  assert.equal(patchCalls, 1);
  assert.equal(compileCalls, 1);
});

test("14S deterministically corrected retained candidate compiles without weakening persistence", async () => {
  const modulePlan = bookingModulePlan(BOOKING, BOOKING.journeys);
  const tree = candidateTree(correctedBookingFlow);
  assert.equal(lintDurablePersistence(tree, { contract: BOOKING, journeys: BOOKING.journeys, modulePlan }).ok, true);
  await ensureDeps(() => {});
  const compiled = await buildTree(tree, "package14s_persistence_repaired", () => {});
  assert.equal(compiled.ok, true, compiled.stderr);
});
