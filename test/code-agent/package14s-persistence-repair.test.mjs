import { test } from "node:test";
import assert from "node:assert/strict";

import { buildTree, ensureDeps } from "../../harness/workspace.mjs";
import { fromScaffold } from "../../src/engine/fileTree.mjs";
import { REACT_VITE } from "../../src/scaffolds/reactVite.mjs";
import {
  deriveModulePlan, persistenceOwnershipPlan, tierContract,
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
import { create, recover, cancel } from "../../data/booking.js";

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
  return <section><p>{message}</p>
    <button aria-label="date" aria-pressed={false}>Date</button><button aria-label="slot" aria-pressed={false}>Slot</button>
    <button aria-label="party" aria-pressed={false}>Party</button><input aria-label="contact" name="contact" />
    <button onClick={confirmBooking}>Confirm</button>
    <button onClick={restoreBooking}>Restore</button><button onClick={cancelBooking}>Cancel</button></section>;
}
`;

const correctedBookingFlow = `
import React, { useState } from "react";
import { create, recover, cancel } from "../../data/booking.js";

export function BookingFlow(){
  const [message, setMessage] = useState("Booking review");
  async function confirmBooking(){ await create({ date: "2026-08-20", slot: "18:00", partySize: 2 }); setMessage("Booking confirmed with reference"); }
  async function restoreBooking(){ await recover("BK-1"); setMessage("Confirmed booking restored"); }
  async function cancelBooking(){ await cancel("BK-1"); setMessage("Booking cancelled"); }
  return <section><p>{message}</p>
    <button aria-label="date" aria-pressed={false}>Date</button><button aria-label="slot" aria-pressed={false}>Slot</button>
    <button aria-label="party" aria-pressed={false}>Party</button><input aria-label="contact" name="contact" />
    <button onClick={confirmBooking}>Confirm</button>
    <button onClick={restoreBooking}>Restore</button><button onClick={cancelBooking}>Cancel</button></section>;
}
`;

const plannedPresentation = {
  "src/components/recover-booking/RecoverBookingReview.jsx": "export function BookingReview({ draft }){ return <section>Booking review {draft.date} {draft.slot} {draft.partySize} {draft.contact}</section>; }",
  "src/components/recover-booking/RecoverBookingConfirmation.jsx": "export function BookingConfirmation({ booking }){ return <section>Booking confirmed with reference {booking.reference}</section>; }",
  "src/components/recover-booking/RecoverBookingStatus.jsx": "export function BookingStatus(){ return <section>Confirmed booking restored Booking cancelled</section>; }",
};

function candidateTree(flow = retainedBookingFlow) {
  const tree = fromScaffold(REACT_VITE);
  tree["src/data/booking.js"] = bookingSystem;
  tree["src/data/wizard.js"] = bookingWizard;
  tree["src/components/recover-booking/RecoverBookingFlow.jsx"] = flow;
  Object.assign(tree, plannedPresentation);
  tree["src/routes/HomePage.jsx"] = `
import { BookingFlow } from "../components/recover-booking/RecoverBookingFlow.jsx";
import { BookingReview } from "../components/recover-booking/RecoverBookingReview.jsx";
import { BookingConfirmation } from "../components/recover-booking/RecoverBookingConfirmation.jsx";
import { BookingStatus } from "../components/recover-booking/RecoverBookingStatus.jsx";
export default function HomePage(){ return <main><BookingFlow/><BookingReview/><BookingConfirmation/><BookingStatus/></main>; }
`;
  tree["src/App.jsx"] = `import HomePage from "./routes/HomePage.jsx"; export default function App(){ return <HomePage/>; }`;
  // The mounted scaffold screen must be composed, not left on its placeholder slot, or the
  // scaffold gate blocks the build before the persistence concern under test is reached.
  tree["src/screens/scaffold/BookingScreen.jsx"] = `
import { BookingFlow } from "../../components/recover-booking/RecoverBookingFlow.jsx";
import { BookingReview } from "../../components/recover-booking/RecoverBookingReview.jsx";
import { BookingConfirmation } from "../../components/recover-booking/RecoverBookingConfirmation.jsx";
import { BookingStatus } from "../../components/recover-booking/RecoverBookingStatus.jsx";
export default function BookingScreen(){
  return <main><BookingFlow/><BookingReview/><BookingConfirmation/><BookingStatus/></main>;
}
`;
  return tree;
}

function fullCandidatePatches(flow = retainedBookingFlow) {
  const tree = candidateTree(flow);
  const scaffold = fromScaffold(REACT_VITE);
  return Object.entries(tree).filter(([path, content]) => scaffold[path] !== content)
    // Composed scaffold screens are created by the composer during the build, so they are
    // replaced rather than added even though the base scaffold does not carry them.
    .map(([path, content]) => scaffold[path] === undefined && !path.startsWith("src/screens/scaffold/")
      ? { newFile: path, content } : { replaceFile: path, content });
}

test("14S persistence ownership is machine-readable in the plan and hard generation prompt", () => {
  const modulePlan = deriveModulePlan(BOOKING, BOOKING.journeys);
  const ownership = persistenceOwnershipPlan(BOOKING, BOOKING.journeys, modulePlan);
  assert.deepEqual(ownership.durableJourneys, ["recover-booking"]);
  assert.ok(ownership.forbiddenBusinessPersistence.includes("sessionStorage"));
  assert.equal(ownership.modules.find((row) => row.path.endsWith("RecoverBookingFlow.jsx")).survivesReload, false);
  assert.match(ownership.modules.find((row) => row.path.endsWith("RecoverBookingFlow.jsx")).durableStateOwner,
    /makeBookingSystem.*makeWizardMachine/);
  const prompt = renderPatchPrompt({ step: "core", contract: BOOKING, tiers: tierContract(BOOKING),
    tree: fromScaffold(REACT_VITE), modulePlan });
  assert.match(prompt, /PERSISTENCE OWNERSHIP CONTRACT \(machine-enforced JSON; hard constraints/);
  assert.match(prompt, /"sessionStorage"/);
  assert.match(prompt, /BookingFlow\.jsx[\s\S]*ephemeral UI orchestration only[\s\S]*survivesReload=false/);
  assert.match(prompt, /makeBookingSystem \+ makeWizardMachine/);
});

test("14S early AST persistence verdict is precise and remains strict for every forbidden store", () => {
  const modulePlan = deriveModulePlan(BOOKING, BOOKING.journeys);
  const tree = candidateTree();
  tree["src/data/badMemory.js"] = `let bookingState = null; export function save(row){ bookingState = row; }`;
  tree["src/routes/Other.jsx"] = `export function Other(){ localStorage.setItem("x", "1"); indexedDB.open("x"); new IndexedDB(); return null; }`;
  const verdict = lintDurablePersistence(tree, { contract: BOOKING, journeys: BOOKING.journeys, modulePlan });
  assert.equal(verdict.ok, false);
  const apis = new Set(verdict.findings.map((row) => row.api));
  for (const api of ["localStorage", "sessionStorage", "indexedDB", "IndexedDB", "process_memory"]) assert.ok(apis.has(api), api);
  const retained = verdict.findings.filter((row) => row.file.endsWith("RecoverBookingFlow.jsx"));
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
  const timeline = [];
  let contractCalls = 0;
  const compileSteps = [];
  let compileCalls = 0;
  const orchestrator = createOrchestrator({
    contractFn: async () => { contractCalls += 1; return BOOKING; },
    patchesFn: async (input) => {
      patchCalls.push(input);
      if (input.step === "core") return fullCandidatePatches();
      // Pre-compile corrections dispatch under their own step so they cannot consume the
      // single browser-informed repair slot.
      assert.equal(input.step, "correction");
      assert.equal(input.originalStep, "core");
      assert.equal(input.repairScope.kind, "precompile_persistence");
      assert.deepEqual(input.repairScope.files, ["src/components/recover-booking/RecoverBookingFlow.jsx"]);
      return [{ replaceFile: "src/components/recover-booking/RecoverBookingFlow.jsx", content: correctedBookingFlow }];
    },
    assetService: {
      async resolveIntents() { return { resolved: [], providerCalls: 0 }; },
      async assetManifestFor() { return []; },
    },
    snapshotStore: snapshots, buildStore: memoryBuildStore(), baseTree: () => fromScaffold(REACT_VITE),
    baseline: REACT_VITE,
    compile: async (_tree, execution) => { compileCalls += 1; compileSteps.push(execution?.step || "candidate"); return { ok: true }; },
    journeysFn: async ({ journeys }) => {
      timeline.push("browser-verification");
      return { journeys: journeys.map((journey) => ({ ...journey, status: "pass" })) };
    },
    events: { checkpoint: async (event) => { checkpoints.push(event); timeline.push(`checkpoint:${event.reason}`); } },
  });
  const result = await orchestrator.runBuild({ owner: "owner", projectId: "project", request: "durable booking" });
  assert.equal(result.state, "green", JSON.stringify(result));
  assert.equal(contractCalls, 1);
  assert.deepEqual(patchCalls.map((call) => call.step), ["core", "correction"]);
  // The platform compiles its own composed scaffold once before any model output exists, so a
  // bare total no longer states the guarantee. What must hold is that exactly one CANDIDATE
  // compile happens - the corrected one - and the rejected candidate never reaches the
  // compiler at all.
  assert.deepEqual(compileSteps.filter((step) => step === "scaffold_foundation").length, 1,
    "the composed scaffold foundation is compiled once, before generation");
  assert.equal(compileSteps.filter((step) => step !== "scaffold_foundation").length, 1,
    `invalid candidate never reaches compilation: ${compileSteps.join(" -> ")}`);
  const invalid = checkpoints.find((row) => row.reason === "candidate:core:1");
  assert.ok(invalid?.snapshot?.id);
  assert.match((await snapshots.getSnapshot(invalid.snapshot.id)).reason, /^candidate:/,
    "the rejected candidate remains immutable and resumable evidence");
  const finalCandidate = timeline.findIndex((row) => row === "checkpoint:candidate:core:2");
  const browser = timeline.findIndex((row) => row === "browser-verification");
  const working = timeline.findIndex((row) => row === "checkpoint:working:core");
  assert.ok(finalCandidate >= 0 && browser > finalCandidate && working > browser,
    `candidate must remain non-promotable through browser verification: ${timeline.join(" -> ")}`);
  assert.doesNotMatch(result.state === "green" ? correctedBookingFlow : retainedBookingFlow,
    /localStorage|sessionStorage|indexedDB/);
});

test("14S pre-compile repair scope is limited to the offending file and relevant adapters/interfaces", () => {
  const modulePlan = deriveModulePlan(BOOKING, BOOKING.journeys);
  const verdict = lintDurablePersistence(candidateTree(), { contract: BOOKING, journeys: BOOKING.journeys, modulePlan });
  const scope = persistenceRepairScope(verdict, modulePlan);
  assert.deepEqual(scope.files, ["src/components/recover-booking/RecoverBookingFlow.jsx"]);
  assert.ok(scope.allowedFiles.includes("src/data/booking.js"));
  assert.ok(scope.allowedFiles.includes("src/data/wizard.js"));
  assert.ok(scope.capabilityPaths.includes("src/lib/capabilities/booking.js"));
  assert.ok(scope.capabilityPaths.includes("src/lib/capabilities/wizard.js"));
  let trace = null;
  const prompt = renderPatchPrompt({ step: "repair", contract: BOOKING, tiers: tierContract(BOOKING),
    tree: candidateTree(), modulePlan, repairScope: scope,
    problems: verdict.findings.map((row) => row.message), onRetrieval: (value) => { trace = value; } });
  assert.deepEqual(trace.included.filter((row) => row.form === "full").map((row) => row.path),
    ["src/components/recover-booking/RecoverBookingFlow.jsx"]);
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
      // First dispatch resumes the failed build as a repair; the persistence violation then
      // selects a scoped pre-compile correction.
      assert.ok(["repair", "correction"].includes(step), step);
      return [{ replaceFile: "src/components/recover-booking/RecoverBookingFlow.jsx", content: correctedBookingFlow }];
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

test("14S platform re-verification refreshes protected runtime and makes zero model calls", async () => {
  const snapshots = createSnapshotStore();
  const oldTree = { ...candidateTree(correctedBookingFlow),
    "src/lib/capabilities/wizard.js": "// stale runtime" };
  await snapshots.createSnapshot("owner", "project", oldTree, {
    buildId: "paid-repair", reason: "working:resumed-repair",
  });
  let patchCalls = 0;
  const current = fromScaffold(REACT_VITE);
  const orchestrator = createOrchestrator({
    contractFn: async () => { throw new Error("contract must not replay"); },
    patchesFn: async () => { patchCalls += 1; throw new Error("model must not run"); },
    assetService: { async resolveIntents() { throw new Error("assets must not replay"); },
      async assetManifestFor() { return []; } },
    snapshotStore: snapshots, buildStore: memoryBuildStore(), baseTree: () => current,
    baseline: current, compile: async (tree) => {
      assert.equal(tree["src/lib/capabilities/wizard.js"], current["src/lib/capabilities/wizard.js"]);
      return { ok: true, tree };
    },
    journeysFn: async ({ journeys, tree }) => {
      assert.equal(tree["src/lib/capabilities/wizard.js"], current["src/lib/capabilities/wizard.js"]);
      return { journeys: journeys.map((journey) => ({ ...journey, status: "pass", steps: [] })) };
    },
  });
  const result = await orchestrator.runVerifyFromCheckpoint({ owner: "owner", projectId: "project",
    sourceBuildId: "paid-repair", request: "platform re-verification", contract: BOOKING });
  assert.equal(result.state, "green", JSON.stringify(result));
  assert.equal(result.providerCalls, 0);
  assert.equal(patchCalls, 0);
});

test("14S repair retry promotes a retained greenable candidate before any provider call", async () => {
  const snapshots = createSnapshotStore();
  await snapshots.createSnapshot("owner", "project", candidateTree(correctedBookingFlow), {
    buildId: "failed-verifier", reason: "candidate:final-pre-green",
  });
  let patchCalls = 0;
  let journeyCalls = 0;
  const orchestrator = createOrchestrator({
    contractFn: async () => { throw new Error("contract must not replay"); },
    patchesFn: async () => { patchCalls += 1; throw new Error("model must not run"); },
    assetService: { async resolveIntents() { throw new Error("assets must not replay"); },
      async assetManifestFor() { return []; } },
    snapshotStore: snapshots, buildStore: memoryBuildStore(), baseTree: () => fromScaffold(REACT_VITE),
    baseline: REACT_VITE, compile: async (tree) => ({ ok: true, tree }),
    journeysFn: async ({ journeys }) => {
      journeyCalls += 1;
      return { journeys: journeys.map((journey) => ({ ...journey, status: "pass", steps: [] })) };
    },
  });
  const result = await orchestrator.runRepairFromCheckpoint({ owner: "owner", projectId: "project",
    sourceBuildId: "failed-verifier", request: "try the retained build again", contract: BOOKING,
    initialProblems: ["required contracted journeys remain red"] });
  assert.equal(result.state, "green", JSON.stringify(result));
  assert.equal(result.providerCalls, 0);
  assert.equal(patchCalls, 0, "a now-green retained candidate never enters model repair");
  assert.equal(journeyCalls, 1, "the affected contracted journeys are genuinely reverified");
});

test("14S deterministically corrected retained candidate compiles without weakening persistence", async () => {
  const modulePlan = deriveModulePlan(BOOKING, BOOKING.journeys);
  const tree = candidateTree(correctedBookingFlow);
  assert.equal(lintDurablePersistence(tree, { contract: BOOKING, journeys: BOOKING.journeys, modulePlan }).ok, true);
  await ensureDeps(() => {});
  const compiled = await buildTree(tree, "package14s_persistence_repaired", () => {});
  assert.equal(compiled.ok, true, compiled.stderr);
});
