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
import { expectationKeywords } from "./journeyVerifier.mjs";

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
      "The backend SDK is the ONLY store. Do not use localStorage, sessionStorage, IndexedDB, a",
      "module-level array or a React context as the place records live. A production run built the",
      "entire reservation layer on localStorage: it survived a reload on that one browser, looked",
      "completely working, and lost every booking the moment anyone opened it anywhere else.",
      "State may cache what the backend returned; the backend is what a reload reads from.",
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
export function planStages(contract, { skipEmpty = true, includePolish = true } = {}) {
  const stages = [];
  for (const id of STAGES) {
    // The visual pass the pipeline already runs — design audit, then one focused polish turn — does
    // this stage's job and, in the first staged production run, caught something the polish stage
    // had missed (an invented image host). Running both is a model call spent twice on the same
    // work, so the caller drops this one when a design profile is in play.
    if (id === "polish" && !includePolish) continue;

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

  // A skipped stage must not take its journeys with it. In the 24.26-credit booking build the
  // contract assigned use-responsive-navigation to POLISH, polish was dropped (a design profile
  // already covers the visual pass) — and the mobile-navigation expectations were handed to no
  // stage at all. The verifier then failed a journey nothing had ever been asked to build.
  // Orphaned journeys land on the last stage that builds screens.
  const planned = new Set(stages.map((s) => s.id));
  const orphans = (contract?.journeys || []).filter((j) => !planned.has(j.stage || "primary_journey"));
  if (orphans.length) {
    const home = stages.find((s) => s.id === "supporting")
      || stages.find((s) => s.id === "primary_journey")
      || stages.find((s) => s.id === "foundation");
    if (home) home.journeys = [...home.journeys, ...orphans];
  }

  return stages;
}

/**
 * Does every journey the verifier will drive belong to a stage that will actually run?
 *
 * Deterministic, checked BEFORE generation. A journey the plan does not own is a verification
 * failure already paid for — the model can only build the expectations it is given.
 */
export function acceptanceCoverage(contract, stages) {
  const owned = new Map();
  for (const stage of stages) {
    for (const journey of stage.journeys || []) owned.set(journey.id, stage.id);
  }
  const missing = (contract?.journeys || []).filter((j) => !owned.has(j.id));
  return {
    ok: missing.length === 0,
    covered: (contract?.journeys || [])
      .filter((j) => owned.has(j.id))
      .map((j) => ({ journey: j.id, stage: owned.get(j.id), steps: (j.steps || []).length })),
    missing: missing.map((j) => ({ journey: j.id, declaredStage: j.stage || "primary_journey" })),
  };
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

  // The expectations are rendered as what the VERIFIER will literally test, not as prose. The
  // 24.26-credit booking build implemented every step "impressionistically" and then failed
  // verification on wording: the page never said "selected", never said "confirmation" — because
  // nothing had told the builder the check is visible text. Same source of truth on both sides.
  if (stage.journeys?.length) {
    lines.push("JOURNEYS THIS STAGE MUST MAKE PASS — a real browser will drive every step and then");
    lines.push("look for the named words as VISIBLE TEXT on the page. Internal state that renders");
    lines.push("nothing does not count. After each action, the outcome must be on screen:");
    lines.push("");
  }
  for (const journey of stage.journeys || []) {
    lines.push(`JOURNEY — ${journey.title}${journey.priority === "primary" ? " (PRIMARY — the preview is gated on this)" : ""}:`);
    for (const [i, step] of (journey.steps || []).entries()) {
      lines.push(`  ${i + 1}. ${step.action}${step.target ? ` (${step.target})` : ""} → ${step.expect}`);
      const wanted = expectationKeywords(step.expect);
      if (wanted.length) lines.push(`     verifier looks for on-page text: ${wanted.join(", ")}`);
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

// ── the byte-stable shared prefix (cache stabilisation) ───────────────────────────────────────
//
// Every stage call after the foundation shares one system prompt assembled in a fixed order:
// edit instructions → design brief → runtime/SDK contract → implementation contract → these
// invariants. Nothing dynamic — no timestamps, ids, or stage-specific text — may appear in it,
// because the provider's prompt cache works on byte-identical prefixes: in the 24.26-credit
// booking build every stage OPENED with cached=0, paying full price for the same preamble four
// times. Stage-specific content (manifest, objective, evidence) belongs in the user message,
// AFTER the stable prefix ends.

export const STAGE_RUNTIME_CONTRACT = [
  "RUNTIME AND SDK:",
  "The app runs on the fixed Vite + React scaffold. Persistence is the backend SDK only:",
  '  import { auth, db } from "./lib/backend" — db.entity("<type>").create/list/update/delete,',
  "  auth.signUp / signIn / currentUser / signOut.",
  "Entities are owner-scoped: reads and writes need a signed-in session; for apps without",
  "sign-in, establish an anonymous visitor session and keep its credentials as the ONLY thing",
  "cached in the browser.",
  "localStorage, sessionStorage and IndexedDB are NOT persistence and fail the honesty scan.",
].join("\n");

export const STAGE_GLOBAL_INVARIANTS = [
  "GLOBAL INVARIANTS — checked deterministically after every stage, not negotiable:",
  "- every import resolves and the project compiles (npm run build).",
  "- src/lib/backend/ is infrastructure and is never edited.",
  "- no control is present that does nothing; deferred work is omitted or visibly disabled.",
  "- an outcome a journey names must be VISIBLE on the page after its action — rendered text or",
  "  state, not internal variables.",
  "- every declared route renders a real component.",
].join("\n");
