// EXECUTION-FIRST: a structurally usable candidate must reach the compiler and the browser.
//
// The correction this proves: generate → retain candidate → enforce only genuine safety
// blockers → compile → run → verify behaviour → repair from observed evidence.
//
// The quality bar is unchanged. A build still cannot go green unless every required contracted
// journey passes in a real browser, and every honesty/integrity blocker still stops a build
// dead before it ever runs.

import test from "node:test";
import assert from "node:assert/strict";

import {
  createOrchestrator, memoryBuildStore, rejectedHeadroomContinuation,
} from "../../shell/server/lib/builderV2/orchestrator.mjs";
import { createSnapshotStore } from "../../shell/server/lib/builderV2/snapshotStore.mjs";
import { memoryModelReservations } from "../../shell/server/lib/builderV2/modelReservations.mjs";
import { deriveBuildSpec } from "../../shell/server/lib/builderV2/buildSpec.mjs";
import { composeCapabilityFoundation } from "../../shell/server/lib/builderV2/capabilityComposer.mjs";
import { composeScaffoldFoundation } from "../../shell/server/lib/builderV2/scaffoldComposer.mjs";
import {
  SEVERITY, assertSeverityTablesDisjoint, partitionFindings, severityOf,
} from "../../shell/server/lib/builderV2/validationSeverity.mjs";
import { fromScaffold } from "../../src/engine/fileTree.mjs";
import { REACT_VITE } from "../../src/scaffolds/reactVite.mjs";
import { buildTree, ensureDeps } from "../../harness/workspace.mjs";

const CONTRACT = {
  summary: "A booking workflow with durable confirmation",
  entities: [{ name: "booking", fields: [{ name: "date" }, { name: "slot" }] }],
  operations: [{ id: "create-booking", entity: "booking", action: "create" }],
  routes: [{ path: "/", name: "Booking" }], auth: { required: false },
  journeys: [{ id: "book", title: "Complete a booking", priority: "primary", steps: [
    { action: "select a date", target: "date", expect: "selected date becomes active" },
    { action: "review the booking", target: "review", expect: "review shows the date" },
    { action: "confirm booking", target: "confirm", expect: "durable booking reference" },
    { action: "cancel booking", target: "cancel booking", expect: "cancelled status" },
  ] }],
};

const SCREEN_PATH = "src/screens/scaffold/BookingScreen.jsx";

// A working application composed inside the mounted model-owned screen slot. The platform owns
// the route and capability infrastructure; product-specific interaction composition stays free.
const UNPRESCRIBED = {
  [SCREEN_PATH]: `import { useSyncExternalStore } from "react";
import { makeBookingSystem, makeWizardMachine } from "../../lib/capabilities/index.js";
const bookings = makeBookingSystem({ entity: "booking" });
const wizard = makeWizardMachine({ id: "book", steps: ["date", "review", "confirm"] });
export default function BookingScreen() {
  const state = useSyncExternalStore(wizard.subscribe, wizard.getState);
  return <main>
    <label htmlFor="date">Date</label>
    <input id="date" name="date" value={state.values.date || ""} onChange={(e) => { wizard.restore(); wizard.select("date", e.target.value); wizard.next(); }} />
    <p>Review: {state.values.date}</p>
    <button onClick={async () => wizard.confirm(await bookings.createBooking(state.values))}>Confirm booking</button>
    <button onClick={async () => { await bookings.cancelBooking("BK-1"); wizard.cancel(); }}>Cancel booking</button>
    <button onClick={() => bookings.getBooking("BK-1")}>Look up booking</button>
  </main>;
}`,
};

function harness({ patches, journeyStatus = "pass", maxCoreAttempts = 3 } = {}) {
  const events = { checkpoints: [], findings: [] };
  const timeline = [];
  const patchInputs = [];
  const snapshotStore = createSnapshotStore();
  const orchestrator = createOrchestrator({
    contractFn: async () => CONTRACT,
    patchesFn: async (input) => {
      timeline.push(`patch:${input.step}`);
      patchInputs.push(input);
      return patches(input);
    },
    assetService: {
      async resolveIntents() { return { resolved: [], providerCalls: 0 }; },
      async assetManifestFor() { return []; },
    },
    snapshotStore,
    buildStore: memoryBuildStore(),
    baseTree: () => fromScaffold(REACT_VITE),
    baseline: REACT_VITE,
    compile: async (_tree, context) => { timeline.push(`compile:${context?.step || "unknown"}`); return { ok: true }; },
    journeysFn: async ({ journeys }) => {
      timeline.push("browser");
      return { journeys: journeys.map((journey) => ({ ...journey, status: journeyStatus, steps: [] })) };
    },
    maxCoreAttempts,
    events: {
      checkpoint: async (event) => { events.checkpoints.push(event); timeline.push(`checkpoint:${event.reason}`); },
      candidateFindings: async (event) => { events.findings.push(event); },
    },
  });
  return { orchestrator, snapshotStore, events, timeline, patchInputs };
}

const asPatches = (tree) => Object.entries(tree).map(([path, content]) => (
  Object.hasOwn(REACT_VITE, path) || path.startsWith("src/screens/scaffold/")
    ? { replaceFile: path, content } : { newFile: path, content }
));

test("the severity model has exactly one authority per finding code", () => {
  assert.equal(assertSeverityTablesDisjoint(), true);
  assert.equal(severityOf("forbidden_persistence"), SEVERITY.BLOCKING);
  assert.equal(severityOf("capability_owner_bypassed"), SEVERITY.BLOCKING);
  assert.equal(severityOf("required_method_uninvoked"), SEVERITY.ADVISORY);
  assert.equal(severityOf("required_module_missing"), SEVERITY.ADVISORY);
  // A validator added later must make an explicit, reviewed claim to be able to stop a build.
  assert.equal(severityOf("some_future_heuristic"), SEVERITY.ADVISORY);
});

test("a structurally usable candidate is checkpointed, compiled, run and verified", async () => {
  const h = harness({ patches: () => asPatches(UNPRESCRIBED) });
  const result = await h.orchestrator.runBuild({ owner: "o", projectId: "p", request: "booking" });

  // The candidate exists BEFORE any shape gate, and the order is checkpoint → compile → browser.
  const candidate = h.timeline.findIndex((row) => row.startsWith("checkpoint:candidate:"));
  const compiled = h.timeline.indexOf("compile:core");
  const browser = h.timeline.indexOf("browser");
  assert.ok(candidate >= 0, `no candidate checkpoint: ${h.timeline.join(" → ")}`);
  assert.ok(compiled > candidate, `compile must follow the checkpoint: ${h.timeline.join(" → ")}`);
  assert.ok(browser > compiled, `the browser must follow compilation: ${h.timeline.join(" → ")}`);
  assert.equal(result.state, "green", JSON.stringify(result));

  // Shape differences were recorded, not enforced.
  const recorded = h.events.findings.flatMap((event) => event.advisory);
  assert.ok(recorded.every((finding) => finding.severity === SEVERITY.ADVISORY));
  assert.ok(recorded.every((finding) => finding.rationale), "every advisory carries its rationale");
  assert.equal(h.events.findings.every((event) => event.blocking.length === 0), true);
});

test("the candidate is non-promotable until compile and browser verification pass", async () => {
  const h = harness({ patches: () => asPatches(UNPRESCRIBED), journeyStatus: "fail" });
  const result = await h.orchestrator.runBuild({ owner: "o", projectId: "p", request: "booking" });

  assert.equal(result.state, "blocked");
  assert.equal(result.failureClassification, "contracted_journeys_red");
  // It ran — that is the point — but a red contracted journey still cannot promote.
  assert.ok(h.timeline.includes("compile:core"));
  assert.ok(h.timeline.includes("browser"));
  assert.equal(await h.snapshotStore.pointer("o", "p", "green"), null, "nothing was promoted");
  for (const event of h.events.checkpoints) assert.equal(event.promotable, false);
  const retained = h.events.checkpoints.at(-1);
  assert.match(retained.snapshot.reason, /^candidate:/, "the tree remains resumable evidence");
});

test("a red contracted journey can never be argued green by advisory silence", async () => {
  const h = harness({ patches: () => asPatches(UNPRESCRIBED), journeyStatus: "undriveable" });
  const result = await h.orchestrator.runBuild({ owner: "o", projectId: "p", request: "booking" });
  assert.equal(result.state, "blocked");
  assert.match(result.error, /remain red/);
});

// ── the blockers that must NOT be weakened ────────────────────────────────────────────────────

const BLOCKERS = {
  "browser storage owning contracted durable state": {
    "src/data/unsafe-store.js": 'export const save = (row) => localStorage.setItem("booking", JSON.stringify(row));',
    [SCREEN_PATH]: UNPRESCRIBED[SCREEN_PATH],
  },
  "a raw write to a capability-owned entity": {
    "src/data/unsafe-store.js": 'import { db } from "../lib/backend/index.js";\nexport const save = (row) => db.entity("booking").create(row);',
    [SCREEN_PATH]: UNPRESCRIBED[SCREEN_PATH],
  },
};

// Session establishment moved to the runtime, so this shape is CORRECT and must run.
const RUNTIME_HANDLED = {
  "src/data/note-store.js": 'import { db } from "../lib/backend/index.js";\nexport const saveNote = (row) => db.entity("note").create(row);',
  [SCREEN_PATH]: UNPRESCRIBED[SCREEN_PATH],
};

test("genuine safety blockers still stop a build before it ever runs", async () => {
  for (const [name, tree] of Object.entries(BLOCKERS)) {
    const h = harness({ patches: () => asPatches(tree), maxCoreAttempts: 1 });
    const result = await h.orchestrator.runBuild({ owner: "o", projectId: "p", request: "booking" });
    assert.equal(result.state, "blocked", `${name} must block: ${JSON.stringify(result)}`);
    assert.equal(h.timeline.includes("browser"), false, `${name} must never reach the browser`);
    const blocking = h.events.findings.flatMap((event) => event.blocking);
    assert.ok(blocking.length, `${name} must produce a blocking finding`);
    assert.ok(blocking.every((finding) => finding.severity === SEVERITY.BLOCKING), JSON.stringify(blocking));
  }
});

test("an entity mutation with no explicit session call now RUNS — the runtime owns it", async () => {
  const h = harness({ patches: () => asPatches(RUNTIME_HANDLED) });
  const result = await h.orchestrator.runBuild({ owner: "o", projectId: "p", request: "booking" });
  const blocking = h.events.findings.flatMap((event) => event.blocking);
  assert.equal(blocking.length, 0,
    `session establishment is not generated source's responsibility: ${JSON.stringify(blocking)}`);
  assert.ok(h.timeline.includes("compile:core"));
  assert.ok(h.timeline.includes("browser"));
  assert.equal(result.state, "green");
});

test("a protected-path rewrite is refused", async () => {
  const h = harness({
    patches: () => [{ replaceFile: "src/lib/backend/index.js", content: "export const db = { entity: () => ({}) };" }],
    maxCoreAttempts: 1,
  });
  const result = await h.orchestrator.runBuild({ owner: "o", projectId: "p", request: "booking" });
  assert.equal(result.state, "blocked");
  assert.equal(h.timeline.includes("browser"), false);
});

test("repeated rejected operations escalate the exact retained file to whole-file regeneration", async () => {
  const h = harness({
    maxCoreAttempts: 3,
    patches: () => [{
      file: "src/App.jsx", newFile: null, replaceFile: null, content: null, deleteFile: null,
      ops: [{ op: "replace_symbol", symbol: "MissingLiveSymbol", content: "function MissingLiveSymbol() {}" }],
    }],
  });
  const result = await h.orchestrator.runBuild({ owner: "o", projectId: "p", request: "booking" });

  assert.equal(result.state, "blocked");
  assert.equal(h.patchInputs.length, 3);
  assert.deepEqual(h.patchInputs[0].regenerateFiles, []);
  assert.deepEqual(h.patchInputs[1].regenerateFiles, []);
  assert.deepEqual(h.patchInputs[2].regenerateFiles, ["src/App.jsx"],
    "the third bounded attempt receives the existing escalationPlan output");
});

test("an internally split headroom continuation cannot write outside its advertised module scope", async () => {
  const h = harness({
    patches: () => {
      const patches = asPatches(UNPRESCRIBED);
      Object.defineProperty(patches, "dispatchScope", { value: {
        kind: "headroom_continuation", files: ["src/components/OnlyThis.jsx"],
        allowedFiles: ["src/components/OnlyThis.jsx"], allowedPrefixes: [],
      } });
      return patches;
    },
    maxCoreAttempts: 1,
  });
  const result = await h.orchestrator.runBuild({ owner: "o", projectId: "p", request: "booking" });
  assert.equal(result.state, "blocked");
  assert.equal(h.events.checkpoints.filter((event) => event.reason.startsWith("candidate:")).length, 0,
    "out-of-scope patches are refused before candidate persistence");
  assert.equal(h.timeline.includes("compile:core"), false);
  assert.equal(h.timeline.includes("browser"), false);
});

test("headroom module batches continue automatically and gate only after the retained tree is complete", async () => {
  let dispatches = 0;
  const h = harness({
    patches: (input) => {
      dispatches += 1;
      if (dispatches === 1) {
        const splitScreen = UNPRESCRIBED[SCREEN_PATH]
          .replace('import { makeBookingSystem, makeWizardMachine } from "../../lib/capabilities/index.js";',
            'import { bookings, wizard } from "../../data/store.js";')
          .replace('const bookings = makeBookingSystem({ entity: "booking" });\nconst wizard = makeWizardMachine({ id: "book", steps: ["date", "review", "confirm"] });\n', "");
        const patches = asPatches({ [SCREEN_PATH]: splitScreen });
        Object.defineProperty(patches, "dispatchScope", { value: {
          kind: "headroom_continuation", files: [SCREEN_PATH],
          allowedFiles: [SCREEN_PATH], allowedPrefixes: [], batchWidth: 1,
          logicalStep: "correction", batchIndex: 0,
          remainingFiles: ["src/data/store.js"],
          moduleContracts: { version: 1, specifications: [] },
        } });
        return patches;
      }
      assert.equal(input.step, "correction", "continuations keep the original logical routing and funding step");
      assert.deepEqual(input.headroomScope.allowedFiles, ["src/data/store.js"]);
      assert.equal(input.headroomScope.batchIndex, 1);
      assert.equal(input.headroomScope.expectedPatchTokens, 1_600,
        "later missing modules retain the same realistic output envelope");
      return asPatches({ "src/data/store.js": `import { makeBookingSystem, makeWizardMachine } from "../lib/capabilities/index.js";
export const bookings = makeBookingSystem({ entity: "booking" });
export const wizard = makeWizardMachine({ id: "book", steps: ["date", "review", "confirm"] });` });
    },
  });
  const result = await h.orchestrator.runBuild({ owner: "o", projectId: "p", request: "booking" });
  assert.equal(result.state, "green", JSON.stringify(result));
  assert.equal(dispatches, 2, "the second batch is dispatched inside the same build with no user turn");
  assert.equal(h.timeline.filter((entry) => entry === "compile:core").length, 1,
    "partial headroom batches are checkpointed but not prematurely compiled");
  assert.equal(h.timeline.filter((entry) => entry === "browser").length, 2,
    "differential verification is followed by the mandatory uncached full-journey pass");
  assert.ok(h.events.checkpoints.length >= 2, "each useful batch is durably retained");
});

test("a rejected missing file in a partial headroom batch retries alone before compile", async () => {
  const storePath = "src/data/store.js";
  let dispatches = 0;
  const h = harness({
    patches: (input) => {
      dispatches += 1;
      if (dispatches === 1) {
        const splitScreen = UNPRESCRIBED[SCREEN_PATH]
          .replace('import { makeBookingSystem, makeWizardMachine } from "../../lib/capabilities/index.js";',
            'import { bookings, wizard } from "../../data/store.js";')
          .replace('const bookings = makeBookingSystem({ entity: "booking" });\nconst wizard = makeWizardMachine({ id: "book", steps: ["date", "review", "confirm"] });\n', "");
        const patches = [
          { replaceFile: SCREEN_PATH, content: splitScreen },
          { file: storePath, ops: [{ op: "append", symbol: null,
            content: "export const unfinished = true;" }] },
        ];
        Object.defineProperty(patches, "dispatchScope", { value: {
          kind: "headroom_continuation", files: [SCREEN_PATH, storePath],
          allowedFiles: [SCREEN_PATH, storePath], allowedPrefixes: [], batchWidth: 2,
          logicalStep: "core", batchIndex: 0, remainingFiles: [],
          moduleContracts: { version: 1, specifications: [] },
        } });
        return patches;
      }
      assert.deepEqual(input.headroomScope.allowedFiles, [storePath],
        "the clean mounted screen is retained and excluded from the retry");
      assert.deepEqual(input.headroomScope.remainingFiles, []);
      assert.match(input.headroomScope.instruction, /create each with newFile/);
      assert.match(input.rejections[0].reason, /does not exist/);
      return [{ newFile: storePath,
        content: `import { makeBookingSystem, makeWizardMachine } from "../lib/capabilities/index.js";
export const bookings = makeBookingSystem({ entity: "booking" });
export const wizard = makeWizardMachine({ id: "book", steps: ["date", "review", "confirm"] });` }];
    },
  });
  const result = await h.orchestrator.runBuild({ owner: "o", projectId: "p", request: "booking" });
  assert.equal(result.state, "green", JSON.stringify(result));
  assert.equal(dispatches, 2);
  assert.equal(h.timeline.filter((entry) => entry === "compile:core").length, 1,
    "compile waits until the rejected missing module has been created");
});

test("a rejected shared controller retry preserves queued work and its interaction-sized output budget", () => {
  const controller = "src/components/catalogue/SoftwareCatalogueController.jsx";
  const queued = "src/screens/scaffold/SoftwareCatalogueScreen.jsx";
  const moduleContracts = { version: 1, specifications: [{
    path: controller, sharedControllerFor: "software-catalogue",
    semanticInteractions: Array.from({ length: 14 }, (_, index) => ({
      interactionId: `catalogue-control-${index + 1}`,
    })),
    moduleSizeBoundary: 5_500,
  }] };
  const retry = rejectedHeadroomContinuation({
    kind: "headroom_continuation", allowedFiles: [controller, queued], files: [controller, queued],
    remainingFiles: ["src/extensions/catalogue/formatDetails.js"], batchWidth: 2, batchIndex: 0,
    allowedPrefixes: [],
  }, moduleContracts, { [queued]: "export default function SoftwareCatalogueScreen(){return <main/>}" }, [{
    file: controller, code: "patch_not_applicable", reason: "the planned source file is not present",
  }]);
  assert.deepEqual(retry.allowedFiles, [controller]);
  assert.deepEqual(retry.remainingFiles, ["src/extensions/catalogue/formatDetails.js"]);
  assert.equal(retry.expectedPatchTokens, 4_700);
  assert.match(retry.instruction, /create each with newFile/);
});

test("a tree that does not compile is a real generation attempt, not a correction", async () => {
  const events = { findings: [] };
  const dispatches = [];
  const orchestrator = createOrchestrator({
    contractFn: async () => CONTRACT,
    patchesFn: async (input) => { dispatches.push(input.step); return asPatches(UNPRESCRIBED); },
    assetService: {
      async resolveIntents() { return { resolved: [], providerCalls: 0 }; },
      async assetManifestFor() { return []; },
    },
    snapshotStore: createSnapshotStore(), buildStore: memoryBuildStore(),
    baseTree: () => fromScaffold(REACT_VITE), baseline: REACT_VITE,
    compile: async (_tree, context) => context?.step === "scaffold_foundation"
      ? { ok: true } : { ok: false, stderr: "Unexpected token" },
    journeysFn: async () => ({ journeys: [] }),
    maxCoreAttempts: 2,
    events: { candidateFindings: async (event) => { events.findings.push(event); } },
  });
  const result = await orchestrator.runBuild({ owner: "o", projectId: "p", request: "booking" });
  assert.equal(result.state, "blocked");
  // Compilation failure consumes ATTEMPTS, and an identical failure twice stops the build
  // rather than spending the rest of the budget on it. Neither round is a correction.
  assert.deepEqual(dispatches, ["core", "core"]);
  assert.match(result.error, /stop rule|generation attempts/);
});

// ── budget separation ─────────────────────────────────────────────────────────────────────────

test("a pre-compile correction never consumes the browser-informed repair allowance", async () => {
  const reservations = memoryModelReservations();
  const reserve = (step, sequence) => reservations.reserve({
    owner: "o", projectId: "p", buildId: "b", callKey: `${step}-${sequence}`, step,
    provider: "codex", model: "gpt-5.5", billingLane: "connected_allowance",
    reservedCredits: 0.5, ceilingCredits: 100, maxRepairs: 1, maxCorrections: 2,
  });

  await reserve("core", 1);
  const firstCorrection = await reserve("correction", 1);
  assert.equal(firstCorrection.correctionDispatchCount, 1);
  assert.equal(firstCorrection.repairDispatchCount, 0, "a correction is not a repair");

  const secondCorrection = await reserve("correction", 2);
  assert.equal(secondCorrection.correctionDispatchCount, 2);

  // The correction allowance is its own hard limit...
  await assert.rejects(() => reserve("correction", 3), (error) => error.code === "correction_limit_reached");

  // ...and the single browser repair is still fully available afterwards.
  const repair = await reserve("repair", 1);
  assert.equal(repair.repairDispatchCount, 1);
  await assert.rejects(() => reserve("repair", 2), (error) => error.code === "repair_limit_reached");
});

test("partitioned findings keep their full structure on both sides", () => {
  const { blocking, advisory, ok } = partitionFindings([
    { code: "forbidden_persistence", file: "a.jsx", line: 3, api: "localStorage" },
    { code: "required_method_uninvoked", module: "b.js", method: "cancel" },
  ]);
  assert.equal(ok, false);
  assert.equal(blocking[0].api, "localStorage");
  assert.equal(blocking[0].line, 3);
  assert.equal(advisory[0].method, "cancel");
  assert.ok(advisory[0].rationale.length, "an advisory explains why the browser supersedes it");
});

// ── the real compiler ─────────────────────────────────────────────────────────────────────────

test("the unprescribed application and the platform React binding both really compile", async () => {
  await ensureDeps(() => {});
  const spec = deriveBuildSpec(CONTRACT);
  let tree = composeCapabilityFoundation(fromScaffold(REACT_VITE), spec.capabilityGraph).tree;
  tree = composeScaffoldFoundation(tree, spec.scaffoldGraph).tree;
  tree = {
    ...tree,
    "src/components/Fields.jsx": `import { useCapabilityState, useSemanticField, useSemanticSelection, useStatusRegion } from "../lib/capabilities";
import { makeWizardMachine } from "../lib/capabilities/index.js";
const wizard = makeWizardMachine({ id: "field-proof", steps: ["date", "slot"] });
export function Fields() {
  const state = useCapabilityState(wizard, (s) => s.values);
  const date = useSemanticField({ name: "date", value: state.date, onChange: (v) => wizard.select("date", v) });
  const slot = useSemanticSelection({ name: "slot", value: state.slot, onSelect: (v) => wizard.select("slot", v) });
  const status = useStatusRegion({ label: "Booking status" });
  return <section>
    <label {...date.labelProps} />
    <input {...date.inputProps} />
    <div {...slot.groupProps}>{["10:00", "11:00"].map((option) => <button key={option} {...slot.optionProps(option)}>{option}</button>)}</div>
    <p {...status.statusProps}>{state.date}</p>
  </section>;
}`,
    [SCREEN_PATH]: UNPRESCRIBED[SCREEN_PATH]
      .replace('import { useSyncExternalStore } from "react";',
        'import { useSyncExternalStore } from "react";\nimport { Fields } from "../../components/Fields.jsx";')
      .replace("</main>;", "<Fields /></main>;"),
  };
  const build = await buildTree(tree, "builder-v2-execution-first", () => {});
  assert.equal(build.ok, true, build.stderr);
});
