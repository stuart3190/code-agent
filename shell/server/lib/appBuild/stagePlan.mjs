// What each generation stage is responsible for.
//
// PR5 of docs/PIPELINE-REDESIGN.md. The whole project used to be written in one turn, and the first
// validation of any kind was `npm run build` after all 27 files existed. A fault in the foundation
// was therefore discovered only once everything had been built on top of it.
//
// Five stages, each ending in a compile and a green checkpoint. The value is not the split itself —
// it is that a stage cannot begin on a broken predecessor, and that a failure late in the run has
// somewhere known-good to fall back to.
//
// Work is allocated from the CONTRACT (PR4), so the stages describe this application rather than a
// generic sequence: the primary journey's stage gets the primary journey, entities go to data, and
// so on.

import { STAGES, journeysForStage, primaryJourney } from "../../../shared/implementationContract.mjs";

const DEFINITIONS = {
  foundation: {
    title: "Foundation",
    // Deliberately first and deliberately small: routing, shell and the design system are what
    // every later stage builds on, so a fault here is the most expensive one to find late.
    goal: "the application shell, routing and design system",
    instruction: [
      "Build ONLY the foundation: the app shell, navigation between the declared routes, the",
      "design system (colours, typography, spacing) and shared layout components.",
      "Every declared route must render a real page component — a heading and a short placeholder",
      "paragraph is correct at this stage. Do NOT build forms, data, or the journeys yet.",
      "Do not add a control that does nothing: if a screen is not built yet, its route may render a",
      "heading, but no button may be present that has no handler.",
    ].join(" "),
  },
  data: {
    title: "Data and backend",
    goal: "the entities, the backend calls and the auth flow",
    instruction: [
      "Build ONLY the data layer: a module per entity that reads and writes through",
      "db.entity(\"<type>\") from ./lib/backend, plus the auth flow if the contract requires one.",
      "No component may hold records in useState as its source of truth — state may cache what the",
      "backend returned, but the backend is what a reload reads from.",
      "Export the functions the screens will call. Wire nothing into the UI yet beyond what is",
      "needed to prove the module loads.",
    ].join(" "),
  },
  primary_journey: {
    title: "Primary journey",
    goal: "the one journey the application exists for",
    instruction: [
      "Build the PRIMARY JOURNEY end to end, using the data layer from the previous stage.",
      "Every step of it must work against the real backend: what the journey stores must be",
      "readable after a full page reload. Include the validation, error and success states the",
      "contract names for the surfaces this journey touches.",
      "This is the stage the preview is judged on. A step that cannot be completed in a browser",
      "is a failure of this stage even if the screen looks finished.",
    ].join(" "),
  },
  supporting: {
    title: "Supporting screens",
    goal: "the remaining journeys and the states each surface needs",
    instruction: [
      "Build the remaining journeys and the supporting screens, again through the data layer.",
      "Add the loading, empty, validation, error and success states the contract names for each",
      "surface — the empty and error states especially, which are the ones usually skipped.",
      "Anything the contract defers must NOT appear as a working control. Omit it, or render it",
      "disabled with a visible reason.",
    ].join(" "),
  },
  polish: {
    title: "Visual refinement",
    goal: "the finish, without changing behaviour",
    instruction: [
      "Refine the visuals only: spacing, hierarchy, imagery, motion, responsive behaviour down to",
      "360px, focus states and contrast.",
      "Change no behaviour, remove no feature, and do not touch the data layer. If a control works",
      "today it must still work when you are done.",
    ].join(" "),
  },
};

/**
 * The stages to run for this contract, in order, each with the work assigned to it.
 *
 * Stages with nothing to do are still run when they are structural (foundation, data when there
 * are entities) and skipped when they are not — a landing page has no data stage, and spending a
 * model call to be told so is waste.
 */
export function planStages(contract, { skipEmpty = true } = {}) {
  const stages = [];
  for (const id of STAGES) {
    const definition = DEFINITIONS[id];
    const journeys = journeysForStage(contract, id);
    const entities = id === "data" ? (contract?.entities || []) : [];

    // What makes a stage worth a model call.
    const substantive = id === "foundation" || id === "polish"
      || (id === "data" && (entities.length > 0 || contract?.auth?.required))
      || journeys.length > 0;
    if (skipEmpty && !substantive) continue;

    stages.push({ id, ...definition, journeys, entities });
  }
  return stages;
}

/**
 * The prompt for one stage.
 *
 * Carries the stage's own instruction plus only the slice of the contract it is responsible for —
 * a stage that is shown the whole contract tends to build the whole contract, which is precisely
 * the one-shot behaviour being replaced.
 */
export function stagePrompt(stage, contract, { request }) {
  const lines = [
    `STAGE ${stage.title.toUpperCase()} — ${stage.goal}.`,
    "",
    stage.instruction,
    "",
    "The application being built, for context:",
    contract?.summary || request,
    "",
  ];

  if (stage.id === "foundation" && contract?.routes?.length) {
    lines.push("ROUTES THIS STAGE MUST RENDER:");
    for (const route of contract.routes) {
      lines.push(`  ${route.path} — ${route.name}${route.auth ? " (signed-in only)" : ""}: ${route.purpose || ""}`);
    }
    lines.push("");
  }

  if (stage.entities?.length) {
    lines.push("ENTITIES THIS STAGE MUST IMPLEMENT (through db.entity, never component state):");
    for (const entity of stage.entities) {
      const fields = (entity.fields || []).map((f) => `${f.name}:${f.type}${f.required ? " (required)" : ""}`).join(", ");
      lines.push(`  ${entity.name}${entity.owned ? " — rows belong to the signed-in user" : ""} { ${fields} }`);
      for (const rel of entity.relationships || []) lines.push(`    ${rel}`);
    }
    if (contract?.operations?.length) {
      lines.push("  Operations that must really run:");
      for (const op of contract.operations) lines.push(`    - ${op.id}: ${op.description}`);
    }
    if (contract?.auth?.required) {
      lines.push(`  Authentication: ${contract.auth.model || "email + password via the backend SDK"}.`);
      for (const rule of contract.auth.rules || []) lines.push(`    - ${rule}`);
    }
    lines.push("");
  }

  for (const journey of stage.journeys || []) {
    lines.push(`JOURNEY — ${journey.title}${journey.priority === "primary" ? " (PRIMARY)" : ""}:`);
    for (const [i, step] of (journey.steps || []).entries()) {
      lines.push(`  ${i + 1}. ${step.action}${step.target ? ` (${step.target})` : ""} → ${step.expect}`);
    }
    lines.push("");
  }

  // States are attached to the stage that owns the surface, best-effort by name.
  const states = (contract?.states || []).filter((state) => {
    if (stage.id === "primary_journey") {
      const primary = primaryJourney(contract);
      return primary && String(state.surface || "").toLowerCase().split(/\s+/)
        .some((word) => String(primary.title || "").toLowerCase().includes(word));
    }
    return stage.id === "supporting";
  });
  if (states.length) {
    lines.push("REQUIRED STATES FOR THE SURFACES IN THIS STAGE:");
    for (const state of states) {
      for (const key of ["loading", "empty", "validation", "error", "success"]) {
        if (state[key]) lines.push(`  ${state.surface} · ${key}: ${state[key]}`);
      }
    }
    lines.push("");
  }

  if (contract?.deferred?.length) {
    lines.push("DEFERRED — do not build these and do not fake them. No control for one may appear");
    lines.push("as though it works:");
    for (const item of contract.deferred) lines.push(`  - ${item.item}${item.reason ? ` (${item.reason})` : ""}`);
    lines.push("");
  }

  lines.push("Stay inside this stage. Later stages will add the rest; building ahead is how a");
  lines.push("foundation ends up with features resting on it that nothing has verified.");
  return lines.join("\n");
}

export { DEFINITIONS as STAGE_DEFINITIONS };
