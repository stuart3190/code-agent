import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  bindCapabilities, bindingsForJourneys, capabilityRequirementsBrief,
} from "../../shell/server/lib/builderV2/contractTiering.mjs";
import { lintRequiredCapabilityBindings } from "../../shell/server/lib/builderV2/capabilityLint.mjs";
import { planCallReservation } from "../../shell/server/lib/builderV2/modelLanes.mjs";
import { memoryModelReservations } from "../../shell/server/lib/builderV2/modelReservations.mjs";
import { createOrchestrator, memoryBuildStore } from "../../shell/server/lib/builderV2/orchestrator.mjs";
import { createSnapshotStore } from "../../shell/server/lib/builderV2/snapshotStore.mjs";
import { routeV2Step } from "../../shell/server/lib/builderV2/router.mjs";
import { startExistingAppWorkV2 } from "../../shell/server/lib/builderV2/entry.mjs";
import { makeContactForm } from "../../src/scaffolds/reactVite/lib/capabilities/forms.js";
import { makeBookingSystem, BOOKING_STATUS } from "../../src/scaffolds/reactVite/lib/capabilities/booking.js";
import { makeWizardMachine, WIZARD_STATUS } from "../../src/scaffolds/reactVite/lib/capabilities/wizard.js";
import { REACT_VITE } from "../../src/scaffolds/reactVite.mjs";
import { clone, fromScaffold } from "../../src/engine/fileTree.mjs";

function memoryBackend() {
  const rows = new Map();
  let sequence = 0;
  const db = {
    entity(type) {
      return {
        async create(data) {
          const row = { id: `row-${++sequence}`, type, data: { ...data }, created_at: new Date().toISOString() };
          rows.set(row.id, row);
          return row;
        },
        async list({ filters = {} } = {}) {
          return [...rows.values()].filter((row) => row.type === type
            && Object.entries(filters).every(([key, value]) => (key === "id" ? row.id : row.data[key]) === value));
        },
        async get(id) { return rows.get(id) || null; },
        async update(id, data) { const row = rows.get(id); row.data = { ...data }; return row; },
        async delete(id) { rows.delete(id); },
        async count() { return [...rows.values()].filter((row) => row.type === type).length; },
        subscribe() { return () => {}; },
      };
    },
  };
  return { db, ensureSession: async () => ({ id: "visitor-package14r" }), rows };
}

const bookingContract = ({ multiStep = true } = {}) => ({
  summary: "A headless booking qualification fixture",
  entities: [{ name: "booking" }], operations: [{ entity: "booking", action: "create" }],
  routes: [{ path: "/", name: "Booking" }], auth: { required: false },
  journeys: [{ id: "book", title: "Book a table", priority: "primary", steps: multiStep ? [
    { action: "choose date", expect: "selected date" },
    { action: "select slot", expect: "selected slot" },
    { action: "select party", expect: "party size" },
    { action: "enter details", expect: "valid contact details" },
    { action: "review", expect: "booking summary" },
    { action: "confirm", expect: "confirmation reference" },
  ] : [{ action: "submit booking", expect: "confirmation" }] }],
});

const compliantBookingSource = `
import { makeBookingSystem, makeWizardMachine } from "./lib/capabilities/index.js";
const booking = makeBookingSystem({ entity: "booking" });
const wizard = makeWizardMachine({ id: "booking-flow", steps: ["date", "slot", "party", "details", "review", "confirm"] });
wizard.subscribe(() => {});
wizard.restore();
wizard.getState();
wizard.select("date", "2026-08-20");
wizard.next();
wizard.confirm();
wizard.cancel();
booking.createBooking({ date: "2026-08-20", slotId: "evening", partySize: 2, name: "Ada", email: "ada@example.test" });
`;

test("14R capability binding distinguishes booking-only from true multi-step booking", () => {
  const bookingOnly = bindCapabilities(bookingContract({ multiStep: false }));
  assert.ok(bookingOnly.some((row) => row.name === "booking"));
  assert.ok(!bookingOnly.some((row) => row.name === "wizard"));

  const multi = bindCapabilities(bookingContract());
  assert.ok(multi.some((row) => row.name === "booking"));
  assert.ok(multi.some((row) => row.name === "wizard"));
  assert.deepEqual(bindingsForJourneys(bookingContract(), multi, bookingContract().journeys)
    .map((row) => row.name).sort(), ["booking", "wizard"]);
});

test("14R model omission and repair removal of required headless capabilities are rejected", () => {
  const contract = bookingContract();
  const bindings = bindCapabilities(contract);
  const missing = lintRequiredCapabilityBindings({ "src/App.jsx": "export default () => <main>Book</main>;" }, bindings);
  assert.equal(missing.ok, false);
  assert.match(missing.problems.join("\n"), /makeBookingSystem/);
  assert.match(missing.problems.join("\n"), /makeWizardMachine/);

  const complete = lintRequiredCapabilityBindings({ "src/App.jsx": compliantBookingSource }, bindings);
  assert.equal(complete.ok, true, complete.problems.join("; "));
  const persistenceBypass = lintRequiredCapabilityBindings({
    "src/App.jsx": compliantBookingSource.replace("steps: [", "persistence: null, steps: ["),
  }, bindings);
  assert.equal(persistenceBypass.ok, false);
  assert.match(persistenceBypass.problems.join("\n"), /must use platform persistence/);
  const removedByRepair = lintRequiredCapabilityBindings({
    "src/App.jsx": compliantBookingSource.replace(/const wizard[\s\S]*?wizard\.cancel\(\);/, ""),
  }, bindings);
  assert.equal(removedByRepair.ok, false, "repair cannot remove a contracted wizard");
  assert.match(capabilityRequirementsBrief(contract), /impose no layout, colour, typography or visual design/);
});

test("14R simple-build regression rejects the Package 14 wrong contact entity and persists the repaired shape", async () => {
  const contract = {
    entities: [{ name: "contactEnquiry" }], operations: [{ entity: "contactEnquiry", action: "create" }],
    routes: [{ path: "/", name: "Contact" }], auth: { required: false },
    journeys: [{ id: "submit-contact-enquiry", title: "Contact enquiry", priority: "primary",
      steps: [{ action: "submit contact form", expect: "confirmation" }] }],
  };
  const bindings = bindCapabilities(contract);
  const retainedFailure = `const contact = makeContactForm({ type: "contactEnquiry" }); contact.submitContact({ name, email, message });`;
  const before = lintRequiredCapabilityBindings({ "src/Contact.jsx": retainedFailure }, bindings);
  assert.equal(before.ok, false);
  assert.match(before.problems.join("\n"), /entity: "contactEnquiry"/);

  const after = lintRequiredCapabilityBindings({ "src/Contact.jsx": `const contact = makeContactForm({ entity: "contactEnquiry" }); contact.submitContact({ name, email, message });` }, bindings);
  assert.equal(after.ok, true, after.problems.join("; "));
  const deps = memoryBackend();
  const form = makeContactForm({ entity: "contactEnquiry", deps });
  const sent = await form.submitContact({ name: "Ada", email: "ada@example.test", message: "Repair my bike",
    source: "package14r", reference: "ENQ-14R" });
  assert.equal(sent.result, "sent");
  const row = [...deps.rows.values()][0];
  assert.equal(row.type, "contactEnquiry");
  assert.equal(row.data.source, "package14r");
  assert.equal(row.data.reference, "ENQ-14R");
  assert.ok(row.data.createdAt);
});

test("14R repair reservations reuse remaining build headroom without exceeding the build ceiling", async () => {
  const reservations = memoryModelReservations();
  const common = { owner: "owner", projectId: "project", buildId: "build", provider: "codex",
    model: "gpt-5.5", billingLane: "connected_allowance", ceilingCredits: 6, accountAvailableCredits: null };
  const initial = await reservations.reserve({ ...common, callKey: "core:1", step: "core", reservedCredits: 3 });
  await reservations.settle("owner", initial.id, { actualCredits: 2.2671, usage: { input: 10, output: 10 } });
  const budget = await reservations.budget("owner", "build", 6);
  assert.equal(budget.remainingCredits, 3.7329);
  const plan = planCallReservation({ systemPrompt: "x".repeat(20_000), messages: [{ role: "user", content: "bounded defect" }] }, "gpt-5.5", {
    requestedMaxOutputTokens: 10_000, minimumCredits: 1, callCeilingCredits: 6,
    repairAllowanceCredits: 4, budget,
  });
  assert.ok(plan.reservedCredits <= budget.remainingCredits);
  assert.equal(plan.repairAllowanceCredits, 4);
  assert.ok(plan.maxOutputTokens <= 10_000, "the provider output cap never exceeds the reserved bound");
  assert.equal(plan.fundingPolicy, "request_owner");
  const repair = await reservations.reserve({ ...common, callKey: "repair:1", step: "repair",
    reservedCredits: plan.reservedCredits });
  assert.equal((await reservations.reserve({ ...common, callKey: "repair:1", step: "repair",
    reservedCredits: plan.reservedCredits })).id, repair.id, "duplicate reservation remains idempotent");
  await reservations.release("owner", repair.id);
  assert.equal((await reservations.budget("owner", "build", 6)).remainingCredits, 3.7329,
    "cancellation releases unused repair headroom");
  await assert.rejects(reservations.reserve({ ...common, callKey: "repair:too-large", step: "repair",
    reservedCredits: 3.8 }), (error) => error.code === "budget_ceiling");
});

test("14R booking wizard persists review, confirmation and reload state without localStorage", async () => {
  const deps = memoryBackend();
  const bookings = makeBookingSystem({ entity: "booking", slots: [{ id: "evening", capacity: 6 }], deps });
  const options = {
    id: "ember-table", steps: ["date", "slot", "party", "details", "review", "confirm"], deps,
    validate: ({ stepId, values }) => stepId === "date" && !values.date ? { date: "required" }
      : stepId === "slot" && !values.slotId ? { slotId: "required" }
        : stepId === "party" && !values.partySize ? { partySize: "required" }
          : stepId === "details" && (!values.name || !values.email) ? { details: "required" } : {},
    onConfirm: async (values) => {
      const outcome = await bookings.createBooking(values);
      if (outcome.result !== "ok") throw new Error(outcome.result);
      return { reference: outcome.booking.reference, status: outcome.booking.status };
    },
  };
  const wizard = makeWizardMachine(options);
  await wizard.select("date", "2026-08-20"); await wizard.next();
  await wizard.select("slotId", "evening"); await wizard.next();
  await wizard.select("partySize", 2); await wizard.next();
  await wizard.select("name", "Ada"); await wizard.select("email", "ada@example.test"); await wizard.next();
  assert.equal(wizard.getState().stepId, "review");
  assert.deepEqual(wizard.getState().values, {
    date: "2026-08-20", slotId: "evening", partySize: 2, name: "Ada", email: "ada@example.test",
  });
  await wizard.next();
  const confirmed = await wizard.confirm();
  assert.equal(confirmed.state.status, WIZARD_STATUS.CONFIRMED);
  assert.match(confirmed.confirmation.reference, /^BK-/);

  const reloaded = makeWizardMachine(options);
  await reloaded.restore();
  assert.equal(reloaded.getState().status, WIZARD_STATUS.CONFIRMED);
  assert.equal(reloaded.getState().confirmation.reference, confirmed.confirmation.reference);
  assert.equal(reloaded.getState().values.slotId, "evening");
  const cancelled = await bookings.cancelBooking(confirmed.confirmation.reference, "ada@example.test");
  assert.equal(cancelled.booking.status, BOOKING_STATUS.CANCELLED);
  assert.ok(cancelled.booking.cancelledAt);
  const abandoned = makeWizardMachine({ id: "cancelled-flow", steps: ["date", "review"], deps });
  await abandoned.select("date", "2026-08-21");
  await abandoned.cancel();
  const restoredCancelled = makeWizardMachine({ id: "cancelled-flow", steps: ["date", "review"], deps });
  await restoredCancelled.restore();
  assert.equal(restoredCancelled.getState().status, WIZARD_STATUS.CANCELLED);
  assert.equal(restoredCancelled.getState().values.date, "2026-08-21");
  const source = await readFile(new URL("../../src/scaffolds/reactVite/lib/capabilities/wizard.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /localStorage|sessionStorage/);
});

test("14R failed verification resumes the exact non-promotable candidate without replaying contract/core", async () => {
  const contract = {
    summary: "checkpoint fixture", entities: [], operations: [], routes: [{ path: "/", name: "Home" }], auth: {},
    journeys: [{ id: "headline", title: "Headline", priority: "primary",
      steps: [{ action: "open home", expect: "Checkpoint fixture" }] }],
  };
  let contractCalls = 0;
  let coreCalls = 0;
  let repairCalls = 0;
  let browserCalls = 0;
  const snapshotStore = createSnapshotStore();
  const orchestrator = createOrchestrator({
    contractFn: async () => { contractCalls += 1; return contract; },
    patchesFn: async ({ step }) => {
      if (step === "core") {
        coreCalls += 1;
        return [{ newFile: "src/routes/Checkpoint.jsx", content: "export default function Checkpoint(){ return <h1>Checkpoint fixture</h1>; }" }];
      }
      repairCalls += 1;
      return [{ file: "src/routes/Checkpoint.jsx", ops: [{ op: "replace_symbol", symbol: "Checkpoint",
        content: "export default function Checkpoint(){ return <main><h1>Checkpoint fixture</h1><p>Repaired</p></main>; }" }] }];
    },
    assetService: {
      async resolveIntents(_owner, _projectId, intents) {
        return { resolved: intents.map((intent) => ({ slot: intent.slot, via: "placeholder",
          asset: { css: "linear-gradient(#111,#333)", alt: intent.alt || "Decorative placeholder" } })), providerCalls: 0 };
      },
      async assetManifestFor() { return []; },
    },
    snapshotStore, buildStore: memoryBuildStore(), maxJourneyRepairs: 0,
    journeysFn: async ({ journeys }) => {
      browserCalls += 1;
      return { journeys: journeys.map((journey) => ({ ...journey, status: browserCalls === 1 ? "fail" : "pass" })) };
    },
    baseTree: () => clone(fromScaffold(REACT_VITE)), baseline: REACT_VITE,
  });
  const failed = await orchestrator.runBuild({ owner: "owner", projectId: "project", request: "build fixture" });
  assert.equal(failed.state, "blocked", JSON.stringify(failed));
  assert.ok(failed.workingSnapshotId);
  assert.equal(await snapshotStore.pointer("owner", "project", "green"), null);
  const source = await orchestrator.resumeWorkingContext("owner", "project", failed.buildId);
  assert.equal(source.snapshotId, failed.workingSnapshotId);
  assert.match(source.tree["src/routes/Checkpoint.jsx"], /Checkpoint fixture/);

  const repaired = await orchestrator.runRepairFromCheckpoint({ owner: "owner", projectId: "project",
    sourceBuildId: failed.buildId, request: "repair failed verification", contract,
    initialProblems: ["headline did not become visible"] });
  assert.equal(repaired.state, "green", JSON.stringify(repaired));
  assert.equal(contractCalls, 1, "persisted contract is reused");
  assert.equal(coreCalls, 1, "core generation is never replayed");
  assert.equal(repairCalls, 1);
  assert.equal((await snapshotStore.pointer("owner", "project", "green")), repaired.snapshotId);
  assert.match((await snapshotStore.getSnapshot(source.snapshotId)).reason, /^candidate:core:/);
});

test("14R repair dispatch selects the durable checkpoint when a new project has no green snapshot", async () => {
  const dispatched = [];
  const query = (data) => {
    const chain = {
      select: () => chain, eq: () => chain, in: () => chain, order: () => chain,
      limit: () => chain, like: () => chain,
      then(resolve, reject) { return Promise.resolve({ data, error: null }).then(resolve, reject); },
    };
    return chain;
  };
  const client = {
    from(table) {
      if (table === "bv2_builds") return query([{ id: "failed-build", state: "blocked", error: "journey failed" }]);
      if (table === "bv2_snapshots") return query([{ id: "working-snapshot", build_id: "failed-build", reason: "working:core" }]);
      throw new Error(`unexpected table ${table}`);
    },
  };
  const job = { id: "public-job", diagSessionId: "diag", subscribers: new Set() };
  const accepted = await startExistingAppWorkV2({
    owner: "owner", conversation: { id: "conversation" }, emit: async () => {},
    conversations: { appendTurn: async () => {} },
  }, {
    project: { id: "project", name: "Failed new project", bv2_green_snapshot_id: null },
    request: "repair the failed verification", kind: "repair",
  }, { deps: {
    workerEnabled: () => true, client,
    resolveBuildContext: async () => ({ byok: true, providerLabel: "codex",
      policy: { primaryProvider: "codex", billingLane: "connected_allowance" } }),
    startDiagSessionSafe: async () => ({ id: "diag", flush: async () => {},
      recorderForJob: () => ({ sessionId: "diag" }) }),
    createJob: async (input) => { dispatched.push(input); return { job, existing: false }; },
  } });
  assert.equal(accepted.handled, true);
  assert.equal(dispatched[0].mode, "resume_repair");
  assert.deepEqual(dispatched[0].v2Input, { sourceBuildId: "failed-build", problems: ["journey failed"] });
});

test("14R cancellation removes only that build's unpromoted working checkpoints", async () => {
  const snapshots = createSnapshotStore();
  const cancelled = await snapshots.createSnapshot("owner", "project", { "src/a.js": "a" }, {
    buildId: "cancelled-build", reason: "working:core",
  });
  const resumable = await snapshots.createSnapshot("owner", "project", { "src/a.js": "b" }, {
    buildId: "failed-build", reason: "working:core",
  });
  const removed = await snapshots.discardWorking("owner", "project", "cancelled-build");
  assert.deepEqual(removed.removed, [cancelled.id]);
  await assert.rejects(snapshots.materialize("owner", cancelled.id), /not found/);
  assert.deepEqual(await snapshots.materialize("owner", resumable.id), { "src/a.js": "b" });
});

test("14R an exact repaired tree reuses its byte-proven content-addressed snapshot", async () => {
  const snapshots = createSnapshotStore();
  const tree = { "src/App.jsx": "export default function App(){ return <main>green</main>; }" };
  const green = await snapshots.createSnapshot("owner", "project", tree, {
    buildId: "core-build", reason: "working:core",
  });
  await snapshots.promote("owner", "project", "green", green.id);
  const repaired = await snapshots.createSnapshot("owner", "project", tree, {
    buildId: "repair-build", parent: green.id, reason: "working:resumed-repair",
  });
  assert.equal(repaired.id, green.id);
  assert.equal(repaired.reused, true);
  assert.deepEqual(await snapshots.materialize("owner", repaired.id), tree);
  assert.equal(await snapshots.pointer("owner", "project", "green"), green.id);
});

test("14R asset-only regeneration creates a distinct immutable snapshot identity", async () => {
  const snapshots = createSnapshotStore();
  const tree = { "src/App.jsx": "export default function App(){ return <main />; }" };
  const first = await snapshots.createSnapshot("owner", "project", tree, {
    assetManifest: [{ slot: "hero", providerAssetId: "101" }],
  });
  const second = await snapshots.createSnapshot("owner", "project", tree, {
    assetManifest: [{ slot: "hero", providerAssetId: "103" }],
  });
  assert.notEqual(second.id, first.id);
  assert.deepEqual(first.asset_manifest, [{ slot: "hero", providerAssetId: "101" }]);
  assert.deepEqual(second.asset_manifest, [{ slot: "hero", providerAssetId: "103" }]);
});

test("14R automatic router selects an executable candidate and persists a rationale without manual selection", () => {
  const candidates = [
    { provider: "openai", laneProvider: "openai", model: "gpt-5.6-sol", tier: "quality",
      billingLane: "managed", estimatedCredits: 2, executable: true,
      reasoningProfile: "medium" },
    { provider: "openai", laneProvider: "openai", model: "gpt-5.6-terra", tier: "balanced",
      billingLane: "managed", estimatedCredits: 0.6, executable: true,
      reasoningProfile: "low" },
  ];
  const history = Array.from({ length: 6 }, () => ({ provider: "openai", model: "gpt-5.6-terra",
    taskClass: "repair:simple", verified: true, cost: 0.5 }));
  const decision = routeV2Step({ step: "repair", complexity: "simple", taskClass: "repair:simple",
    candidates, history, policy: { primaryProvider: "openai", billingLane: "managed" },
    manualModel: null });
  assert.equal(decision.model, "gpt-5.6-terra");
  assert.equal(decision.billingLane, "managed");
  assert.match(decision.reason, /cheapest model/);
  assert.notEqual(decision.reason, "manual model selection");
});

test("14R a per-build AUTO qualification is durable and does not require changing owner preferences", async () => {
  const source = await readFile(new URL("../../shell/server/lib/buildJobs.mjs", import.meta.url), "utf8");
  const runtime = await readFile(new URL("../../shell/server/lib/builderV2/runtimeComposition.mjs", import.meta.url), "utf8");
  assert.match(source, /providerSelection, routingMode/);
  assert.match(source, /pipelineVersion, manualModel, providerSelection, routingMode/);
  assert.match(runtime, /workJob\.payload\.routingMode === "auto"/);
  assert.match(runtime, /manualModel: workJob\.payload\.manualModel/);
});

test("14R live runner hard-caps aggregate spend and cannot force a manual model", async () => {
  const runner = await readFile(new URL("../../ops/run-package14r-live-requalification.mjs", import.meta.url), "utf8");
  assert.match(runner, /const TOTAL_CEILING = 12/);
  assert.match(runner, /after\.credits > TOTAL_CEILING/);
  assert.match(runner, /manualModel: null, routingMode: "auto"/);
  assert.doesNotMatch(runner, /selectionValue|MANUAL_MODEL/);
  assert.match(runner, /booking already exists; exactly one attempt is authorized/);
  assert.match(runner, /approved zero-spend pre-dispatch failure/);
  assert.match(runner, /archive-edit-predispatch/);
  assert.match(runner, /archive-repair-predispatch/);
  assert.match(runner, /archive-repair-platform-failure/);
  assert.match(runner, /EDIT_REQUEST, ceiling: 4/);
  assert.match(runner, /sourceBuildId: seed\.sourceBuildId, problems: seed\.problems/);
  assert.match(runner, /bounded pre-dispatch correction limit/);
});

test("14R worker authority carries preview configuration without logging secret values", async () => {
  const authority = await readFile(new URL("../../ops/configure-package14-worker-authority.mjs", import.meta.url), "utf8");
  for (const name of ["PREVIEW_MODE", "PROVISIOND_URL", "PROVISIOND_TOKEN"]) {
    assert.match(authority, new RegExp(`\\"${name}\\"`));
  }
  assert.match(authority, /previewAuthorityPresent/);
  assert.doesNotMatch(authority, /console\.log\([^\n]*(?:PROVISIOND_TOKEN|source\.values)/);
});

test("14R cleanup tears down isolated previews before erasing qualification projects", async () => {
  const runner = await readFile(new URL("../../ops/run-package14r-live-requalification.mjs", import.meta.url), "utf8");
  const stop = runner.indexOf("await previews.stop(project.id)");
  const erase = runner.indexOf("await eraseProjectPermanently", stop);
  assert.ok(stop > 0 && erase > stop);
  assert.match(runner, /previewStops/);
});

test("14R dark-worker restore removes qualification authority and restores the narrow allowlist", async () => {
  const restore = await readFile(new URL("../../ops/restore-package14-worker-dark.mjs", import.meta.url), "utf8");
  for (const name of ["CODE_AGENT_STORE", "PLATFORM_ENC_KEY", "BYOK_ENC_KEY",
    "PREVIEW_MODE", "PROVISIOND_URL", "PROVISIOND_TOKEN"]) {
    assert.match(restore, new RegExp(`\\"${name}\\"`));
  }
  assert.match(restore, /THRALLO_BUILD_JOB_TYPES=proof_slow,publish_package/);
  assert.match(restore, /rename\(temporary, targetPath\)/);
  assert.doesNotMatch(restore, /console\.log\([^\n]*(?:target|readFile)/);
});
