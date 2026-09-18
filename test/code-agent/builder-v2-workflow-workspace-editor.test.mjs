// WP9 — workflow, workspace lifecycle, editor state/history, and booking on versioned entities.
//
// Three shapes the retained corpus rebuilt in every application and got wrong in the same way
// every time (audit §7.2):
//
//   - a multi-step flow whose "step" was a number a screen incremented, so an incomplete step
//     advanced and a confirmed flow could be confirmed again;
//   - a project workspace whose save called create() whenever its active-record variable happened
//     to be null, so reopening produced a second record with the same name;
//   - an editor whose undo stored whole documents, or stored an inverse the screen imagined.
//
// The proof the audit asks for is exactly those three failures plus booking concurrency: refused
// transitions and restore, same-ID save and reopen, reversible commands with identity preserved.

import test from "node:test";
import assert from "node:assert/strict";

import {
  WORKFLOW_ERROR, WORKFLOW_STATUS, WorkflowError, compileWorkflow, createWorkflow, durableWorkflowPersistence,
} from "../../src/scaffolds/reactVite/lib/modules/workflow.js";
import {
  WORKSPACE_STATUS, createWorkspace, draftDiffers,
} from "../../src/scaffolds/reactVite/lib/modules/workspace.js";
import {
  EDITOR_ERROR, EditorError, compileCommands, createEditor, objectCommands,
} from "../../src/scaffolds/reactVite/lib/modules/editor.js";
import { compileSchema } from "../../src/scaffolds/reactVite/lib/modules/schema.js";
import { createEntityRepository } from "../../src/scaffolds/reactVite/lib/modules/entities.js";
import { makeBookingSystem } from "../../src/scaffolds/reactVite/lib/capabilities/booking.js";
import {
  deriveBehaviourPlan, deriveEditorPlan, deriveWorkflowPlan, deriveWorkspacePlan,
} from "../../shell/server/lib/builderV2/platformModules/behaviourPlan.mjs";
import { deriveBuildSpec } from "../../shell/server/lib/builderV2/buildSpec.mjs";
import {
  APP_FACADE_EDITOR_PATH, APP_FACADE_WORKFLOW_PATH, APP_FACADE_WORKSPACE_PATH,
  EDITOR_COMPOSED_PATH, WORKFLOW_COMPOSED_PATH, WORKSPACE_COMPOSED_PATH, composeCapabilityFoundation,
} from "../../shell/server/lib/builderV2/capabilityComposer.mjs";
import { moduleManifest, validateModuleRegistry } from "../../shell/server/lib/builderV2/platformModules/registry.mjs";
import { isProtectedPath } from "../../shell/server/lib/builderV2/patchEngine.mjs";
import { REACT_VITE } from "../../src/scaffolds/reactVite.mjs";

const SCHEMA = compileSchema([
  { name: "project", fields: [
    { name: "name", type: "string", required: true }, { name: "notes", type: "text" }, { name: "budget", type: "number" },
  ] },
  { name: "booking", fields: [
    { name: "date", type: "string", required: true }, { name: "slotId", type: "string", required: true },
    { name: "email", type: "email" }, { name: "name", type: "string" }, { name: "partySize", type: "number" },
    { name: "reference", type: "string" }, { name: "status", type: "string" }, { name: "createdAt", type: "string" },
  ] },
]);

/** A fake backend with the SDK row shape and real compare-and-set semantics. */
function fakeDb() {
  const rows = new Map();
  let seq = 0;
  return {
    rows,
    entity(type) {
      return {
        async create(data) { const id = `${type}-${++seq}`; const row = { id, type, data, created_at: `2026-09-18T00:00:0${seq}Z` }; rows.set(id, row); return { ...row }; },
        async get(id) { const row = rows.get(id); if (!row || row.type !== type) throw new Error("no rows returned"); return { ...row }; },
        async update(id, data) { const row = rows.get(id); row.data = data; return { ...row }; },
        async updateVersioned(id, data, expected) {
          const row = rows.get(id);
          if ((row.data.__meta?.version ?? 1) !== expected) return null;
          row.data = data; return { ...row };
        },
        async delete(id) { rows.delete(id); },
        async list({ filters = {} } = {}) {
          return [...rows.values()].filter((row) => row.type === type
            && Object.entries(filters).every(([key, value]) => row.data[key] === value));
        },
        async count(filters = {}) { return (await this.list({ filters })).length; },
        subscribe() { return () => {}; },
      };
    },
  };
}

const QUOTE = compileWorkflow({
  id: "quote",
  steps: [
    { id: "details", fields: ["name", "email"] },
    { id: "sizing", fields: ["rooms"], optional: ["notes"] },
    { id: "confirm", fields: [] },
  ],
});

test("WP9 — a workflow is a declared graph: an invalid step refuses to advance and says which fields are missing", async () => {
  const workflow = createWorkflow({ definition: QUOTE });
  assert.equal(workflow.getState().stepId, "details");
  const refused = await workflow.next();
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, WORKFLOW_ERROR.STEP_INVALID);
  assert.deepEqual(Object.keys(refused.errors).sort(), ["email", "name"]);
  assert.equal(workflow.getState().status, WORKFLOW_STATUS.INVALID, "refusing is a state, not a silent no-op");
  assert.equal(workflow.getState().stepId, "details", "and the flow did not move");

  // Correcting a field clears its error immediately: the flow answers the visitor rather than
  // arguing with them until the next submit.
  workflow.setValue("name", "Ada");
  assert.deepEqual(Object.keys(workflow.getState().errors), ["email"]);
  workflow.setValue("email", "ada@example.com");
  assert.equal((await workflow.next()).ok, true);
  assert.equal(workflow.getState().stepId, "sizing");

  // An optional field is not required; a declared one is.
  assert.deepEqual(Object.keys(workflow.errorsFor("sizing")), ["rooms"]);
  workflow.setValue("rooms", 3);
  assert.deepEqual(workflow.errorsFor("sizing"), {});
});

test("WP9 — navigation is bounded: back always works, a jump forward past unvalidated steps does not", async () => {
  const workflow = createWorkflow({ definition: QUOTE, values: { name: "Ada", email: "ada@example.com" } });
  await workflow.next();
  assert.equal(workflow.back().ok, true);
  assert.equal(workflow.getState().stepId, "details", "back never validates: a visitor may always correct something");
  assert.equal(workflow.goTo("sizing").ok, true, "a visited step is reachable");
  assert.equal(workflow.goTo("confirm").ok, false, "an unvisited step is not");
  assert.equal(workflow.goTo("nowhere").reason, WORKFLOW_ERROR.UNKNOWN_STEP);
  assert.equal(workflow.getState().stepId, "sizing", "a refused jump leaves the position alone");
});

test("WP9 — a terminal workflow is terminal: one confirmation, no further transitions, no value changes", async () => {
  const confirmations = [];
  const workflow = createWorkflow({
    definition: QUOTE, values: { name: "Ada", email: "ada@example.com", rooms: 2 },
    onConfirm: async (values) => { confirmations.push(values); return { reference: `Q-${confirmations.length}` }; },
  });
  const confirmed = await workflow.confirm();
  assert.equal(confirmed.ok, true);
  assert.equal(workflow.getState().status, WORKFLOW_STATUS.CONFIRMED);
  assert.equal(workflow.getState().confirmation.reference, "Q-1");
  assert.equal(workflow.getState().terminal, true);

  // The double-submitted booking this forecloses.
  assert.equal((await workflow.confirm()).reason, WORKFLOW_ERROR.TERMINAL);
  assert.equal((await workflow.next()).reason, WORKFLOW_ERROR.TERMINAL);
  assert.equal(workflow.setValue("name", "Someone else").reason, WORKFLOW_ERROR.TERMINAL);
  assert.equal(confirmations.length, 1, "the domain effect ran exactly once");
  assert.equal(workflow.getState().values.name, "Ada");

  // Confirmation validates EVERY step, not just the one on screen, and lands on the first bad one.
  const partial = createWorkflow({ definition: QUOTE, values: { name: "Ada", email: "ada@example.com" } });
  await partial.next();
  const refused = await partial.confirm();
  assert.equal(refused.ok, false);
  assert.deepEqual(Object.keys(refused.errors), ["rooms"]);
  assert.equal(partial.getState().stepId, "sizing");
});

test("WP9 — persistence mode is explicit: nothing is written unless the flow declares it, and restore resumes", async () => {
  const plain = createWorkflow({ definition: QUOTE });
  assert.equal(plain.persistenceMode, "none");
  assert.equal((await plain.restore()).reason, WORKFLOW_ERROR.PERSISTENCE, "a transient flow has nothing to restore");

  const store = { value: null };
  const durable = createWorkflow({
    definition: QUOTE, values: { name: "Ada", email: "ada@example.com" },
    persistence: { mode: "session", save: async (state) => { store.value = state; }, load: async () => store.value, clear: async () => { store.value = null; } },
  });
  assert.equal(durable.getState().hydrated, false, "a durable flow has not read its own storage yet");
  await durable.next();
  assert.equal(store.value.stepId, "sizing", "progress was saved on the transition");

  // A second session over the same storage resumes where the visitor left off, and SAYS it did.
  const resumed = createWorkflow({
    definition: QUOTE,
    persistence: { mode: "session", save: async () => {}, load: async () => store.value, clear: async () => { store.value = null; } },
  });
  assert.equal(resumed.getState().restored, false);
  assert.equal((await resumed.restore()).ok, true);
  assert.equal(resumed.getState().stepId, "sizing");
  assert.equal(resumed.getState().restored, true, "a resumed flow is not a fresh one");
  assert.equal(resumed.getState().values.name, "Ada");
  assert.deepEqual(resumed.getState().visited, ["details", "sizing"]);

  // Confirming clears the saved progress: half-finished data does not outlive the flow.
  resumed.setValue("rooms", 1);
  await resumed.confirm();
  assert.equal(store.value, null);

  // A persistence failure is reported, never silent, and never takes the flow down.
  const failing = createWorkflow({
    definition: QUOTE, values: { name: "A", email: "a@b.c" },
    persistence: { mode: "session", save: async () => { throw new Error("offline"); }, load: async () => null },
  });
  assert.equal((await failing.next()).ok, true, "the visitor still advances");
  assert.equal(failing.getState().error.code, WORKFLOW_ERROR.PERSISTENCE);
});

test("WP9 — a malformed workflow declaration is refused at compile time, not at the visitor's expense", () => {
  assert.throws(() => compileWorkflow({ steps: ["only"] }), (error) => error instanceof WorkflowError);
  assert.throws(() => compileWorkflow({ steps: ["a", "a"] }), (error) => /unique/.test(error.message));
  assert.throws(() => compileWorkflow({ steps: [{ id: "a", next: "ghost" }, { id: "b" }] }),
    (error) => error.code === WORKFLOW_ERROR.UNKNOWN_STEP);
  assert.throws(() => createWorkflow({ definition: QUOTE, persistence: { mode: "durable" } }),
    (error) => error.code === WORKFLOW_ERROR.PERSISTENCE, "a durable flow with no adapter is a wiring error, not a silent transient one");
});

test("WP9 — a workspace saves and reopens ONE record: the same-ID guarantee", async () => {
  const db = fakeDb();
  const repository = createEntityRepository({ db, schema: SCHEMA, entity: "project" });
  const workspace = createWorkspace({ repository, fields: ["name", "notes", "budget"] });

  assert.equal(workspace.getState().status, WORKSPACE_STATUS.EMPTY);
  assert.equal((await workspace.save()).reason, "workspace_not_open", "there is nothing to save yet");

  workspace.openNew({ name: "Atrium" });
  const created = await workspace.save();
  assert.equal(created.ok, true);
  const id = created.record.id;
  assert.equal(db.rows.size, 1);

  // Every later save updates THAT record. This is the defect: the generated version created a
  // second row here because its active-record variable had been reset by a re-render.
  workspace.setDraft({ notes: "north wall" });
  assert.equal((await workspace.save()).record.id, id);
  workspace.setDraft({ budget: 1200 });
  assert.equal((await workspace.save()).record.id, id);
  assert.equal(db.rows.size, 1, "three saves, one record");

  // Reopening returns the same identity with the stored values.
  const reopened = await workspace.reopen();
  assert.equal(reopened.ok, true);
  assert.equal(workspace.getState().recordId, id);
  assert.deepEqual(workspace.getState().draft, { name: "Atrium", notes: "north wall", budget: 1200 });

  // And so does opening it fresh in another session.
  const second = createWorkspace({ repository, fields: ["name", "notes", "budget"] });
  await second.open(id);
  assert.equal(second.getState().recordId, id);
  assert.equal(second.getState().draft.notes, "north wall");
  assert.equal(db.rows.size, 1);
});

test("WP9 — dirty is derived, discard restores, and a concurrent save is a conflict rather than an overwrite", async () => {
  const db = fakeDb();
  const repository = createEntityRepository({ db, schema: SCHEMA, entity: "project" });
  const mine = createWorkspace({ repository, fields: ["name", "notes"] });
  mine.openNew({ name: "Atrium" });
  const { record } = await mine.save();
  assert.equal(mine.getState().dirty, false, "a just-saved workspace is not dirty");

  mine.setDraft({ notes: "draft note" });
  assert.equal(mine.getState().dirty, true);
  mine.discard();
  assert.equal(mine.getState().dirty, false, "discard restores the saved values");
  assert.equal(mine.getState().draft.notes, undefined);
  assert.equal(mine.getState().recordId, record.id, "discard never closes the workspace");

  // Setting a field back to its saved value is not a change. A flag a screen sets on every
  // keystroke says "unsaved" forever; a derived one tells the truth.
  mine.setDraft({ name: "Changed" });
  assert.equal(mine.getState().dirty, true);
  mine.setDraft({ name: "Atrium" });
  assert.equal(mine.getState().dirty, false);
  assert.equal(draftDiffers({ a: 1 }, { a: 1 }), false);
  assert.equal(draftDiffers({ a: 1 }, { a: 2 }), true);

  // Another writer moves the record; my save must not silently erase their work.
  const theirs = createWorkspace({ repository, fields: ["name", "notes"] });
  await theirs.open(record.id);
  theirs.setDraft({ notes: "their note" });
  assert.equal((await theirs.save()).ok, true);

  mine.setDraft({ notes: "my note" });
  const conflict = await mine.save();
  assert.equal(conflict.ok, false);
  assert.equal(conflict.reason, "workspace_version_conflict");
  assert.equal(mine.getState().status, WORKSPACE_STATUS.CONFLICT);
  assert.equal(mine.getState().draft.notes, "my note", "the unsaved work is the one thing that cannot be recovered elsewhere");
  const stored = await repository.get(record.id);
  assert.equal(stored.values.notes, "their note", "their save stands");

  // Resolving takes their record as the new base and hands both sides to the application.
  const refreshed = await mine.refreshFromConflict();
  assert.equal(refreshed.theirs.notes, "their note");
  assert.equal(refreshed.mine.notes, "my note");
  assert.equal((await mine.save()).ok, true);
  assert.equal((await repository.get(record.id)).values.notes, "my note");
});

test("WP9 — every editor command declares its inverse; an irreversible one is refused at registration", () => {
  assert.throws(() => compileCommands({ explode: { apply: (document) => document } }),
    (error) => error instanceof EditorError && error.code === EDITOR_ERROR.NOT_REVERSIBLE);
  assert.throws(() => compileCommands({ explode: { invert: () => ({}) } }),
    (error) => error.code === EDITOR_ERROR.UNKNOWN_COMMAND);
  assert.deepEqual(Object.keys(compileCommands(objectCommands())).sort(), ["add", "insert", "remove", "update"]);

  const editor = createEditor({ document: { objects: [{ id: "a", x: 0 }] } });
  const refused = editor.execute("teleport", { id: "a" });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, EDITOR_ERROR.UNKNOWN_COMMAND);
  assert.equal(editor.getState().error.code, EDITOR_ERROR.UNKNOWN_COMMAND, "refused, not ignored");
  assert.equal(editor.getState().canUndo, false, "and nothing entered the history");
});

test("WP9 — undo restores state, identity and order; redo replays; a new command truncates the redo branch", () => {
  const editor = createEditor({ document: { objects: [{ id: "a", x: 0 }, { id: "b", x: 5 }, { id: "c", x: 9 }] } });
  editor.execute("update", { id: "a", values: { x: 10 } });
  assert.equal(editor.getState().objects[0].x, 10);
  assert.equal(editor.getState().canUndo, true);

  editor.undo();
  assert.equal(editor.getState().objects[0].x, 0, "the previous value, not a re-guessed one");
  assert.equal(editor.getState().canRedo, true);
  editor.redo();
  assert.equal(editor.getState().objects[0].x, 10);

  // Removal and its inverse: the object comes back, and comes back where it was.
  editor.execute("remove", { id: "b" });
  assert.deepEqual(editor.getState().objects.map((object) => object.id), ["a", "c"]);
  editor.undo();
  assert.deepEqual(editor.getState().objects.map((object) => object.id), ["a", "b", "c"], "identity and order restored");
  assert.equal(editor.getState().objects[1].x, 5);

  // A new command after an undo discards the redo branch: that document no longer exists.
  editor.undo();
  assert.equal(editor.getState().canRedo, true);
  editor.execute("update", { id: "c", values: { x: 1 } });
  assert.equal(editor.getState().canRedo, false);
  assert.equal(editor.redo().reason, EDITOR_ERROR.NOTHING_TO_REDO);

  const empty = createEditor({ document: { objects: [] } });
  assert.equal(empty.undo().reason, EDITOR_ERROR.NOTHING_TO_UNDO);
});

test("WP9 — a transaction is ONE undo, rolls back whole on failure, and a selection never outlives its object", () => {
  const editor = createEditor({ document: { objects: [{ id: "a", x: 0 }, { id: "b", x: 0 }, { id: "c", x: 0 }] } });
  editor.selectMany(["a", "b"]);
  const moved = editor.transaction("move selection", (api) => {
    api.execute("update", { id: "a", values: { x: 7 } });
    api.execute("update", { id: "b", values: { x: 7 } });
  });
  assert.equal(moved.ok, true);
  assert.deepEqual(editor.getState().objects.map((object) => object.x), [7, 7, 0]);
  assert.equal(editor.getState().undoDepth, 1, "dragging two objects is one thing the visitor did");

  editor.undo();
  assert.deepEqual(editor.getState().objects.map((object) => object.x), [0, 0, 0], "one undo reverts both");
  assert.deepEqual(editor.getState().selection, ["a", "b"], "and the selection survives");
  editor.redo();
  assert.deepEqual(editor.getState().objects.map((object) => object.x), [7, 7, 0]);

  // A failure inside a transaction leaves the document where it started: a half-applied group is
  // not a state anyone chose.
  const failed = editor.transaction("half", (api) => {
    api.execute("update", { id: "c", values: { x: 3 } });
    api.execute("teleport", { id: "c" });
  });
  assert.equal(failed.ok, false);
  assert.equal(editor.getState().objects[2].x, 0, "rolled back whole");
  assert.equal(editor.getState().undoDepth, 1, "and the failed group is not in the history");

  // A selected object removed by an undo is deselected, so nothing points at what is gone.
  editor.execute("add", { object: { id: "d", x: 4 } });
  editor.select("d");
  assert.deepEqual(editor.getState().selection, ["d"]);
  editor.undo();
  assert.deepEqual(editor.getState().selection, [], "a selection never names an object that is gone");
  assert.deepEqual(editor.history().undo, ["move selection"]);
});

test("WP9 — booking admits by deterministic rank under concurrency and cancels as a visible transition", async () => {
  const db = fakeDb();
  const repository = createEntityRepository({ db, schema: SCHEMA, entity: "booking" });
  const system = makeBookingSystem({
    slots: [{ id: "evening", capacity: 2 }], entity: "booking",
    deps: { db, ensureSession: async () => ({ id: "visitor" }) },
  });

  assert.equal(await system.remaining("2026-10-01", "evening"), 2);
  assert.equal(await system.remaining("2026-10-01", "unlisted"), null, "unknown capacity is null, never Infinity");

  // Three writers race for two seats. Both survivors and the refusal are decided by one
  // deterministic admission order, so no two writers can both withdraw and no third is admitted.
  const results = await Promise.all([
    system.createBooking({ date: "2026-10-01", slotId: "evening", email: "a@x.test", name: "A" }),
    system.createBooking({ date: "2026-10-01", slotId: "evening", email: "b@x.test", name: "B" }),
    system.createBooking({ date: "2026-10-01", slotId: "evening", email: "c@x.test", name: "C" }),
  ]);
  const admitted = results.filter((row) => row.result === "ok");
  const refused = results.filter((row) => row.result === "over_capacity");
  assert.equal(admitted.length, 2, "exactly capacity, never a livelock where everyone withdraws");
  assert.equal(refused.length, 1);
  assert.equal(await system.remaining("2026-10-01", "evening"), 0);
  assert.equal((await system.listBookings()).length, 2, "the refused writer withdrew its own row");

  // Cancellation is a status transition a screen can render, never a silent delete.
  const reference = admitted[0].booking.reference;
  const cancelled = await system.cancelBooking(reference, admitted[0].booking.email);
  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.booking.status, "Cancelled");
  assert.equal((await system.listBookings()).length, 2, "the record is still there, with a new status");
  assert.equal((await system.cancelBooking(reference)).reason, "already_cancelled");
  assert.equal((await system.cancelBooking("BK-NOPE")).reason, "not_found");
  assert.equal(await system.remaining("2026-10-01", "evening"), 1, "the seat is released");

  // The 1.1.0 manifest states the concurrency the module actually has.
  const manifest = moduleManifest("thrallo.booking");
  assert.equal(manifest.version, "1.1.0");
  assert.equal(manifest.provides.operations.find((row) => row.id === "cancelBooking").concurrency, "versioned");
  assert.ok(manifest.requires.modules.some((row) => row.id === "thrallo.entities"));
  void repository;
});

test("WP9 — the plan is derived from declared structure: a stepped journey, an edited root, an object surface", () => {
  const contract = {
    version: 2, summary: "lighting design studio", auth: { required: true },
    entities: [
      { name: "project", fields: [{ name: "id" }, { name: "name", type: "string", required: true }, { name: "notes", type: "text" }] },
      { name: "fixture", fields: [{ name: "id" }, { name: "projectId", type: "string", required: true }, { name: "x", type: "number" }] },
    ],
    operations: [
      { id: "create-project", kind: "create", entity: "project" },
      { id: "open-project", kind: "read", entity: "project" },
      { id: "save-project", kind: "update", entity: "project" },
      { id: "list-projects", kind: "list", entity: "project" },
      { id: "add-fixture", kind: "create", entity: "fixture" },
    ],
    journeys: [
      { id: "design", title: "Designer opens a project, edits the canvas and saves it", steps: [
        { id: "d1", operates: ["create-project"], expect: "the project exists" },
        { id: "d2", operates: ["open-project"], expect: "it opens" },
        { id: "d3", operates: ["save-project"], expect: "it is saved" },
      ] },
      { id: "quote", title: "Client completes the quote wizard: details, then review, then confirm", steps: [
        { id: "details", operates: ["clientName", "clientEmail"], expect: "details are captured" },
        { id: "review", operates: [], expect: "the review lists what was entered" },
        { id: "confirm", operates: ["create-project"], expect: "a reference is shown" },
      ] },
    ],
  };
  const spec = deriveBuildSpec(contract);
  assert.equal(spec.verdict.ok, true, spec.verdict.problems.join(" | "));
  const plan = spec.behaviourPlan;

  // Only the genuinely stepped journey is a workflow. Selecting the family for one wizard must
  // not turn "open, edit, save" into a three-step wizard as well.
  assert.deepEqual(plan.workflows.map((workflow) => workflow.id), ["quote"]);
  assert.deepEqual(plan.workflows[0].steps.map((step) => step.id), ["details", "review", "confirm"]);
  assert.deepEqual(plan.workflows[0].steps[0].fields, ["clientName", "clientEmail"], "an operand that is not an operation is a collected field");
  assert.equal(plan.workflows[0].review, true);
  assert.equal(plan.workflows[0].persistence, "none", "nothing is written durably unless the contract asks");

  // The workspace root is the entity that is opened and updated in place; a create-only entity is not.
  assert.deepEqual(plan.workspaces.map((workspace) => workspace.entity), ["project"]);
  assert.deepEqual(plan.workspaces[0].fields, ["name", "notes"]);
  assert.deepEqual(plan.editors.map((editor) => editor.collection), ["fixture"]);

  // Both structural modules are locked, with the reason they were requested.
  const locked = spec.moduleLock.modules.map((row) => `${row.id}@${row.version}`);
  assert.ok(locked.includes("thrallo.workspace@1.0.0"));
  assert.ok(locked.includes("thrallo.editor@1.0.0"));
  assert.ok(locked.includes("thrallo.workflow@1.1.0"), "the workflow module advanced to the version with the state graph");
  assert.deepEqual(spec.moduleResolution.modules.find((row) => row.id === "thrallo.workspace").reasons,
    ["a durable record is opened, edited and saved in place"]);
  assert.deepEqual(spec.verification ?? plan.verification.map((probe) => probe.id),
    ["workflow.refuse", "workflow.terminal", "workspace.sameId", "workspace.dirty", "editor.undo", "editor.transaction"]);
});

test("WP9 — negative controls: a plain CRUD contract composes none of this", () => {
  const contract = {
    version: 2, summary: "customer list", auth: { required: true },
    entities: [{ name: "customer", fields: [{ name: "id" }, { name: "name", type: "string", required: true }] }],
    operations: [
      { id: "add-customer", kind: "create", entity: "customer" },
      { id: "list-customers", kind: "list", entity: "customer" },
    ],
    journeys: [{ id: "admin", title: "Staff add a customer and see the list", steps: [
      { id: "a1", operates: ["add-customer"], expect: "the customer is stored" },
      { id: "a2", operates: ["list-customers"], expect: "the list shows them" },
    ] }],
  };
  const spec = deriveBuildSpec(contract);
  assert.deepEqual(spec.behaviourPlan.workflows, []);
  assert.deepEqual(spec.behaviourPlan.workspaces, [], "a record that is only created and listed is not a workspace");
  assert.deepEqual(spec.behaviourPlan.editors, []);
  const locked = spec.moduleLock.modules.map((row) => row.id);
  assert.equal(locked.includes("thrallo.workspace"), false);
  assert.equal(locked.includes("thrallo.editor"), false);

  const { tree } = composeCapabilityFoundation({ ...REACT_VITE }, spec.capabilityGraph, {
    moduleLock: spec.moduleLock, identityPlan: spec.identityPlan, entitySchema: spec.entitySchema,
    routePlan: spec.routePlan, settingsPlan: spec.settingsPlan, behaviourPlan: spec.behaviourPlan,
  });
  for (const path of [WORKFLOW_COMPOSED_PATH, WORKSPACE_COMPOSED_PATH, EDITOR_COMPOSED_PATH,
    APP_FACADE_WORKFLOW_PATH, APP_FACADE_WORKSPACE_PATH, APP_FACADE_EDITOR_PATH]) {
    assert.equal(path in tree, false, `${path} composed for a contract that declares none of it`);
  }
});

test("WP9 — a declaring contract composes protected modules and a public facade, with no dangling durable import", () => {
  const contract = {
    version: 2, summary: "lighting design studio", auth: { required: true },
    entities: [
      { name: "project", fields: [{ name: "id" }, { name: "name", type: "string", required: true }, { name: "notes", type: "text" }] },
      { name: "fixture", fields: [{ name: "id" }, { name: "projectId", type: "string", required: true }] },
    ],
    operations: [
      { id: "create-project", kind: "create", entity: "project" },
      { id: "open-project", kind: "read", entity: "project" },
      { id: "save-project", kind: "update", entity: "project" },
      { id: "list-projects", kind: "list", entity: "project" },
    ],
    journeys: [
      { id: "design", title: "Designer opens a project, edits the canvas and saves it", steps: [
        { id: "d1", operates: ["create-project"], expect: "the project exists" },
        { id: "d2", operates: ["open-project"], expect: "it opens" },
        { id: "d3", operates: ["save-project"], expect: "it is saved" },
      ] },
      { id: "quote", title: "Client completes the quote wizard: details, then review, then confirm", steps: [
        { id: "details", operates: ["clientName"], expect: "captured" },
        { id: "review", operates: [], expect: "listed" },
        { id: "confirm", operates: ["create-project"], expect: "a reference is shown" },
      ] },
    ],
  };
  const spec = deriveBuildSpec(contract);
  const { tree } = composeCapabilityFoundation({ ...REACT_VITE }, spec.capabilityGraph, {
    moduleLock: spec.moduleLock, identityPlan: spec.identityPlan, entitySchema: spec.entitySchema,
    routePlan: spec.routePlan, settingsPlan: spec.settingsPlan, behaviourPlan: spec.behaviourPlan,
  });

  assert.ok(tree[WORKFLOW_COMPOSED_PATH].includes('"id": "quote"'), "the declared graph is embedded, not re-derived");
  assert.ok(tree[WORKFLOW_COMPOSED_PATH].includes("compileWorkflow("));
  // No workflow declared durable progress, so the durable adapter is neither imported nor named.
  assert.equal(tree[WORKFLOW_COMPOSED_PATH].includes("durableWorkflowPersistence"), false);
  assert.ok(tree[WORKSPACE_COMPOSED_PATH].includes('"entity": "project"'));
  assert.ok(tree[WORKSPACE_COMPOSED_PATH].includes("createWorkspace("));
  assert.ok(tree[EDITOR_COMPOSED_PATH].includes("objectCommands("));
  assert.ok(tree[APP_FACADE_WORKFLOW_PATH].includes("export function useWorkflow("));
  assert.ok(tree[APP_FACADE_WORKSPACE_PATH].includes("export function useWorkspace("));
  assert.ok(tree[APP_FACADE_EDITOR_PATH].includes("export function useEditor("));
  assert.ok(tree["src/lib/app/index.js"].includes('export * from "./workspace.js";'));

  for (const path of [WORKFLOW_COMPOSED_PATH, WORKSPACE_COMPOSED_PATH, EDITOR_COMPOSED_PATH,
    APP_FACADE_WORKFLOW_PATH, APP_FACADE_WORKSPACE_PATH, APP_FACADE_EDITOR_PATH]) {
    assert.ok(tree[path].includes("Protected deterministic foundation"), `${path} states it is platform-owned`);
    assert.ok(isProtectedPath(path), `${path} stays under the write guard`);
  }
  // The runtimes ship, and stay protected from generated repair.
  for (const path of ["src/lib/modules/workflow.js", "src/lib/modules/workspace.js", "src/lib/modules/editor.js"]) {
    assert.equal(typeof REACT_VITE[path], "string", `${path} ships in the scaffold`);
    assert.ok(isProtectedPath(path));
  }
  assert.deepEqual(validateModuleRegistry(), { ok: true, problems: [] });
  assert.ok(REACT_VITE["src/lib/modules/uiReact.js"].includes("export function useWorkflowState("));
  assert.ok(REACT_VITE["src/lib/modules/uiReact.js"].includes("export function useWorkspaceState("));
  assert.ok(REACT_VITE["src/lib/modules/uiReact.js"].includes("export function useEditorState("));
});

test("WP9 — durable workflow progress is refused where the contract declares nowhere to keep it", () => {
  const families = new Set(["workflow"]);
  const journey = { id: "apply", title: "Applicant can save and continue later across three steps", steps: [
    { id: "one", operates: ["a"], expect: "step one" },
    { id: "two", operates: ["b"], expect: "step two" },
    { id: "three", operates: ["c"], expect: "step three" },
  ] };
  const contract = { journeys: [journey], operations: [], entities: [] };
  const refused = deriveWorkflowPlan(contract, { entitySchema: { entities: [] }, families });
  assert.equal(refused.workflows[0].persistence, "none");
  assert.equal(refused.workflows[0].persistenceRefused,
    "no workflowState entity is declared for resumable progress", "a fabricated wizardState table is exactly what this replaces");

  const allowed = deriveWorkflowPlan(contract, { entitySchema: { entities: ["workflowState"] }, families });
  assert.equal(allowed.workflows[0].persistence, "durable");

  // Neither plan claims anything when the family was never selected.
  assert.deepEqual(deriveWorkflowPlan(contract, { families: new Set() }).workflows, []);
  assert.deepEqual(deriveWorkspacePlan(contract, { families: new Set() }).workspaces, []);
  assert.deepEqual(deriveEditorPlan(contract, { families: new Set() }).editors, []);
  assert.deepEqual(deriveBehaviourPlan(contract, {}).families, []);
});

test("WP9 — durable workflow persistence writes one row per workflow and reads its own progress back", async () => {
  const db = fakeDb();
  const schema = compileSchema([{ name: "workflowState", fields: [
    { name: "key", type: "string", required: true }, { name: "state", type: "json" }, { name: "updatedAt", type: "string" },
  ] }]);
  const repository = { entity: () => createEntityRepository({ db, schema, entity: "workflowState" }) };
  const persistence = durableWorkflowPersistence({ repository, key: "quote" });
  const workflow = createWorkflow({ definition: QUOTE, values: { name: "Ada", email: "ada@example.com", rooms: 2 }, persistence });

  await workflow.next();
  assert.equal(db.rows.size, 1, "one row for this workflow");
  await workflow.next();
  assert.equal(db.rows.size, 1, "a second transition updates it rather than adding another");

  const resumed = createWorkflow({ definition: QUOTE, persistence: durableWorkflowPersistence({ repository, key: "quote" }) });
  assert.equal((await resumed.restore()).ok, true);
  assert.equal(resumed.getState().stepId, "confirm");
  assert.equal(resumed.getState().values.name, "Ada");

  await resumed.cancel();
  assert.equal(db.rows.size, 0, "a cancelled flow leaves no half-finished data behind");
});
