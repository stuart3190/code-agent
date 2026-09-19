// The workflow, workspace and editor installation plan (WP9).
//
// Each of these three was generated from prose before: a wizard's steps were whatever the model
// remembered writing on the previous screen, a project workspace's "active record" was a variable,
// and an editor's undo was a stack of whole documents. The audit's answer is the same in all three
// cases — DECLARE the shape, then let a module own the mechanics — so the shape is derived here,
// once, from the contract the compiler already typed.
//
// Everything below is keyed on structure the contract states outright: declared journey steps,
// declared entities, declared operations. Nothing is inferred from a domain noun, and a plan is
// empty rather than guessed when the contract does not say.

import { selectedFamilies } from "../scaffoldGraph.mjs";

export const BEHAVIOUR_PLAN_VERSION = 1;

const COLLECTION_KINDS = new Set(["list", "search", "query"]);
const CREATE_KINDS = new Set(["create", "insert", "add"]);
const UPDATE_KINDS = new Set(["update", "edit"]);
const READ_KINDS = new Set(["read", "get", "find", "lookup", "view", "fetch"]);
// A workflow that persists must say so. "Save and continue later", "resume", "pick up where you
// left off" are the contract's own words for durable progress; anything else is transient, because
// writing a visitor's half-finished data to a durable store they never asked about is not a
// default anyone should get by accident.
const DURABLE_PROGRESS = /\b(?:save (?:and )?(?:continue|finish) later|resume|pick up where|come back later|saved progress|continue later)\b/i;
// The vocabulary that makes a journey a STEPPED flow rather than a sequence of things a visitor
// happens to do. It is the same test the scaffold graph applies when it selects the workflow
// family, applied per journey: selecting the family for one wizard must not turn every other
// journey in the contract into a wizard too.
const STEPPED_JOURNEY = /\b(?:continue|next|review|confirm|step|checkout|onboard)\b/i;
const REVIEW_STEP = /\breview\b/i;

const lower = (value) => String(value || "").trim().toLowerCase();
const kindOf = (operation) => String(operation?.kind || operation?.type || operation?.action || operation?.id || "")
  .toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)[0] || "";
const listOf = (value) => (Array.isArray(value) ? value : []);
const textOf = (journey) => [journey?.id, journey?.title, journey?.description,
  ...listOf(journey?.steps).map((step) => `${step?.id} ${step?.title || ""} ${step?.expect || ""}`)].filter(Boolean).join(" ");

/**
 * The workflow definitions a contract declares: one per multi-step journey the workflow family
 * owns. Steps are the journey's OWN steps, and the fields of a step are the declared fields its
 * operations write — so the workflow validates the contract's requirements, not a guess.
 */
export function deriveWorkflowPlan(contract, { entitySchema = null, families = new Set() } = {}) {
  if (!families.has("workflow")) return { workflows: [] };
  const operations = new Map(listOf(contract?.operations).map((operation) => [operation?.id, operation]));
  const fieldsOf = (step) => {
    const declared = listOf(step?.operates)
      .map((operand) => operations.get(operand))
      .filter(Boolean)
      .flatMap((operation) => listOf(operation.responsibilities).flatMap((row) => listOf(row?.writes)))
      .map((field) => String(field).split(".").pop());
    // A step that operates something the contract does not declare as an operation is collecting
    // an input by that name; that is the form field the workflow step owns.
    const collected = listOf(step?.operates).filter((operand) => !operations.has(operand)).map(String);
    return [...new Set([...declared, ...collected])];
  };
  const usesWizard = listOf(contract?.operations).some((operation) => listOf(operation?.responsibilities)
    .some((row) => lower(row?.capability || row?.capabilityId) === "wizard"));
  const workflows = listOf(contract?.journeys)
    // Every declared step is a step. Dropping "review" or "confirm" from the graph would leave a
    // flow whose last screen the module does not know exists; review is a FLAG on the graph and
    // confirmation is the graph's terminal transition, both of which the module already owns.
    .filter((journey) => listOf(journey?.steps).length >= 2
      && (usesWizard || (listOf(journey.steps).length >= 3 && STEPPED_JOURNEY.test(textOf(journey)))))
    .map((journey) => {
      const steps = listOf(journey.steps).map((step) => ({ id: String(step?.id), fields: fieldsOf(step) }));
      return {
        id: String(journey.id),
        title: String(journey.title || journey.id),
        steps,
        review: listOf(journey.steps).some((step) => REVIEW_STEP.test(`${step?.id} ${step?.title || ""} ${step?.expect || ""}`)),
        persistence: DURABLE_PROGRESS.test(textOf(journey)) ? "durable" : "none",
        // The entity a durable workflow writes its progress to is declared, never invented: a
        // contract that wants resumable progress and declares nowhere to keep it gets "none" and
        // a stated reason, rather than a fabricated wizardState table.
        ...(DURABLE_PROGRESS.test(textOf(journey)) && !(entitySchema?.entities || []).includes("workflowState")
          ? { persistence: "none", persistenceRefused: "no workflowState entity is declared for resumable progress" } : {}),
      };
    })
    .filter((workflow) => workflow.steps.length >= 2);
  return { workflows };
}

/**
 * The workspace roots a contract declares: a durable entity that is created, opened and updated
 * in place. A record that is only listed and read is a catalogue, not a workspace, and claiming
 * it would compose lifecycle machinery for something nobody edits.
 */
export function deriveWorkspacePlan(contract, { entitySchema = null, families = new Set() } = {}) {
  if (!families.has("project_workspace")) return { workspaces: [] };
  const durable = entitySchema?.entities || [];
  const byEntity = new Map();
  for (const operation of listOf(contract?.operations)) {
    const entity = lower(operation?.entity);
    if (!entity) continue;
    const row = byEntity.get(entity) || { create: false, read: false, update: false, list: false };
    const kind = kindOf(operation);
    if (CREATE_KINDS.has(kind)) row.create = true;
    if (READ_KINDS.has(kind)) row.read = true;
    if (UPDATE_KINDS.has(kind)) row.update = true;
    if (COLLECTION_KINDS.has(kind)) row.list = true;
    byEntity.set(entity, row);
  }
  const workspaces = durable
    .filter((entity) => {
      const row = byEntity.get(lower(entity));
      return Boolean(row?.update && (row.read || row.list));
    })
    .map((entity) => ({
      entity,
      fields: Object.keys(entitySchema?.schema?.entities?.[entity]?.fields || {}),
      creates: byEntity.get(lower(entity))?.create === true,
    }));
  return { workspaces };
}

/**
 * The editor surface a contract declares. The command set is the standard object vocabulary —
 * add, insert, update, remove — because those are the four the retained corpus reimplemented in
 * every editor; a domain command remains the application's, declared alongside its own inverse.
 */
export function deriveEditorPlan(contract, { families = new Set(), workspacePlan = null } = {}) {
  if (!families.has("canvas_editor")) return { editors: [] };
  const root = workspacePlan?.workspaces?.[0]?.entity || null;
  const collection = listOf(contract?.entities)
    .map((entity) => entity?.name)
    .find((name) => name && root && lower(name) !== lower(root)) || "objects";
  return {
    editors: [{
      id: "editor",
      collection: root ? String(collection) : "objects",
      // A durable snapshot is composed only where the contract declares somewhere to put it. An
      // editor whose history is transient says so, rather than pretending to persist.
      durable: Boolean(root),
      ...(root ? { workspace: root } : {}),
    }],
  };
}

/** All three, derived once from one contract. */
export function deriveBehaviourPlan(contract, { entitySchema = null, capabilityGraph = null } = {}) {
  const families = new Set(capabilityGraph ? selectedFamilies(contract, capabilityGraph) : []);
  const workflowPlan = deriveWorkflowPlan(contract, { entitySchema, families });
  const workspacePlan = deriveWorkspacePlan(contract, { entitySchema, families });
  const editorPlan = deriveEditorPlan(contract, { families, workspacePlan });
  return {
    version: BEHAVIOUR_PLAN_VERSION,
    families: [...families],
    workflows: workflowPlan.workflows,
    workspaces: workspacePlan.workspaces,
    editors: editorPlan.editors,
    verification: behaviourVerificationPlan({ ...workflowPlan, ...workspacePlan, ...editorPlan }),
  };
}

/** Deterministic probes the verifier can drive without a browser. */
export function behaviourVerificationPlan({ workflows = [], workspaces = [], editors = [] } = {}) {
  const probes = [];
  if (workflows.length) {
    probes.push({ id: "workflow.refuse", expect: "an incomplete step refuses to advance and names the missing fields" });
    probes.push({ id: "workflow.terminal", expect: "a confirmed workflow refuses a second confirmation" });
    if (workflows.some((workflow) => workflow.persistence === "durable")) {
      probes.push({ id: "workflow.restore", expect: "saved progress reopens on the step it was left on" });
    }
  }
  if (workspaces.length) {
    probes.push({ id: "workspace.sameId", expect: "saving twice updates one record, and reopening returns that record" });
    probes.push({ id: "workspace.dirty", expect: "an edited draft reads as unsaved until it is saved" });
  }
  if (editors.length) {
    probes.push({ id: "editor.undo", expect: "undo restores the previous state, objects and order included" });
    probes.push({ id: "editor.transaction", expect: "a grouped change is undone by one undo" });
  }
  return probes;
}
