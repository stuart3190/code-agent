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

import { createOrchestrator, memoryBuildStore } from "../../shell/server/lib/builderV2/orchestrator.mjs";
import { createSnapshotStore } from "../../shell/server/lib/builderV2/snapshotStore.mjs";
import { memoryModelReservations } from "../../shell/server/lib/builderV2/modelReservations.mjs";
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

// A working application written in a shape the platform did not prescribe: no planned file
// names, no ceremonial re-invocation, capability methods passed as references.
const UNPRESCRIBED = {
  "src/data/store.js": `import { makeBookingSystem, makeWizardMachine } from "../lib/capabilities";
export const bookings = makeBookingSystem({ entity: "booking" });
export const wizard = makeWizardMachine({ id: "book", steps: ["date", "review", "confirm"] });`,
  "src/routes/Booking.jsx": `import { useSyncExternalStore } from "react";
import { bookings, wizard } from "../data/store.js";
export default function Booking() {
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
  // The app is deliberately unprescribed, but it must still be reachable from the scaffold's
  // mounted root. A complete component left beside the placeholder is not a usable candidate.
  "src/routes/HomePage.jsx": `import Booking from "./Booking.jsx";
export default function HomePage() { return <Booking />; }`,
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
    compile: async () => { timeline.push("compile"); return { ok: true }; },
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
  Object.hasOwn(REACT_VITE, path) ? { replaceFile: path, content } : { newFile: path, content }
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
  const compiled = h.timeline.indexOf("compile");
  const browser = h.timeline.indexOf("browser");
  assert.ok(candidate >= 0, `no candidate checkpoint: ${h.timeline.join(" → ")}`);
  assert.ok(compiled > candidate, `compile must follow the checkpoint: ${h.timeline.join(" → ")}`);
  assert.ok(browser > compiled, `the browser must follow compilation: ${h.timeline.join(" → ")}`);
  assert.equal(result.state, "green", JSON.stringify(result));

  // Shape differences were recorded, not enforced.
  const recorded = h.events.findings.flatMap((event) => event.advisory);
  assert.ok(recorded.length, "advisory findings are retained as evidence");
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
  assert.ok(h.timeline.includes("compile"));
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
    "src/data/store.js": UNPRESCRIBED["src/data/store.js"],
    "src/routes/Booking.jsx": UNPRESCRIBED["src/routes/Booking.jsx"].replace(
      "const state = useSyncExternalStore(wizard.subscribe, wizard.getState);",
      "const state = useSyncExternalStore(wizard.subscribe, wizard.getState);\n  localStorage.setItem(\"booking\", JSON.stringify(state.values));",
    ),
  },
  "a raw write to a capability-owned entity": {
    "src/data/store.js": `${UNPRESCRIBED["src/data/store.js"]}
import { db } from "../lib/backend/index.js";
export const save = async (row) => db.entity("booking").create(row);`,
    "src/routes/Booking.jsx": UNPRESCRIBED["src/routes/Booking.jsx"],
  },
};

// Session establishment moved to the runtime, so this shape is CORRECT and must run.
const RUNTIME_HANDLED = {
  "src/data/store.js": `${UNPRESCRIBED["src/data/store.js"]}
import { db } from "../lib/backend/index.js";
export const saveNote = (row) => db.entity("note").create(row);`,
  "src/routes/Booking.jsx": UNPRESCRIBED["src/routes/Booking.jsx"],
  "src/routes/HomePage.jsx": UNPRESCRIBED["src/routes/HomePage.jsx"],
};

test("genuine safety blockers still stop a build before it ever runs", async () => {
  for (const [name, tree] of Object.entries(BLOCKERS)) {
    const h = harness({ patches: () => asPatches(tree), maxCoreAttempts: 1 });
    const result = await h.orchestrator.runBuild({ owner: "o", projectId: "p", request: "booking" });
    assert.equal(result.state, "blocked", `${name} must block: ${JSON.stringify(result)}`);
    assert.equal(h.timeline.includes("browser"), false, `${name} must never reach the browser`);
    const blocking = h.events.findings.flatMap((event) => event.blocking);
    assert.ok(blocking.length, `${name} must produce a blocking finding`);
    assert.ok(blocking.every((finding) => finding.severity === SEVERITY.BLOCKING));
  }
});

test("an entity mutation with no explicit session call now RUNS — the runtime owns it", async () => {
  const h = harness({ patches: () => asPatches(RUNTIME_HANDLED) });
  const result = await h.orchestrator.runBuild({ owner: "o", projectId: "p", request: "booking" });
  assert.equal(h.events.findings.flatMap((event) => event.blocking).length, 0,
    "session establishment is not generated source's responsibility");
  assert.ok(h.timeline.includes("compile"));
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
  assert.equal(h.events.checkpoints.length, 0, "out-of-scope patches are refused before candidate persistence");
  assert.equal(h.timeline.includes("compile"), false);
  assert.equal(h.timeline.includes("browser"), false);
});

test("headroom module batches continue automatically and gate only after the retained tree is complete", async () => {
  let dispatches = 0;
  const h = harness({
    patches: (input) => {
      dispatches += 1;
      if (dispatches === 1) {
        const patches = asPatches({ "src/data/store.js": UNPRESCRIBED["src/data/store.js"] });
        Object.defineProperty(patches, "dispatchScope", { value: {
          kind: "headroom_continuation", files: ["src/data/store.js"],
          allowedFiles: ["src/data/store.js"], allowedPrefixes: [], batchWidth: 2,
          logicalStep: "correction", batchIndex: 0,
          remainingFiles: ["src/routes/Booking.jsx", "src/routes/HomePage.jsx"],
          moduleContracts: { version: 1, specifications: [] },
        } });
        return patches;
      }
      assert.equal(input.step, "correction", "continuations keep the original logical routing and funding step");
      assert.deepEqual(input.headroomScope.allowedFiles, ["src/routes/Booking.jsx", "src/routes/HomePage.jsx"]);
      assert.equal(input.headroomScope.batchIndex, 1);
      return asPatches({
        "src/routes/Booking.jsx": UNPRESCRIBED["src/routes/Booking.jsx"],
        "src/routes/HomePage.jsx": UNPRESCRIBED["src/routes/HomePage.jsx"],
      });
    },
  });
  const result = await h.orchestrator.runBuild({ owner: "o", projectId: "p", request: "booking" });
  assert.equal(result.state, "green", JSON.stringify(result));
  assert.equal(dispatches, 2, "the second batch is dispatched inside the same build with no user turn");
  assert.equal(h.timeline.filter((entry) => entry === "compile").length, 1,
    "partial headroom batches are checkpointed but not prematurely compiled");
  assert.equal(h.timeline.filter((entry) => entry === "browser").length, 1);
  assert.ok(h.events.checkpoints.length >= 2, "each useful batch is durably retained");
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
    compile: async () => ({ ok: false, stderr: "Unexpected token" }),
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
  const tree = {
    ...fromScaffold(REACT_VITE),
    ...UNPRESCRIBED,
    "src/components/Fields.jsx": `import { useCapabilityState, useSemanticField, useSemanticSelection, useStatusRegion } from "../lib/capabilities";
import { wizard } from "../data/store.js";
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
    "src/App.jsx": `import Booking from "./routes/Booking.jsx";
import { Fields } from "./components/Fields.jsx";
export default function App() { return <><Booking /><Fields /></>; }`,
  };
  const build = await buildTree(tree, "builder-v2-execution-first", () => {});
  assert.equal(build.ok, true, build.stderr);
});
