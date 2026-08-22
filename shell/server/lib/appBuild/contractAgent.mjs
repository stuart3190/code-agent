// Turn a request into an implementation contract.
//
// The planner used to emit prose — "Key features: booking, availability, confirmation" — which is
// unverifiable by construction. This asks for the same understanding in a shape that can be
// checked, then REFUSES to accept it if it comes back vague, because a contract full of "add
// booking functionality" is worse than no contract: every later stage would trust it.
//
// One retry on a failed validation, with the specific problems fed back. If it still fails, the
// build proceeds without a contract rather than blocking — a missing contract costs verification,
// a blocked build costs the customer everything.

import { runAgent } from "../../../../src/engine/runAgent.mjs";
import {
  CONTRACT_VERSION, STAGES, validateContract, contractSummary, functionalOutputEffect,
} from "../../../shared/implementationContract.mjs";
import {
  buildProfileBrief, resolveBuildProfile, validateBuildProfileContract,
} from "../../../shared/buildProfile.mjs";

// Exported so a test can hold the brief and the code that enforces it to the same statement:
// the operand type confusion of 2026-08-12 was a disagreement between them.
export const SYSTEM_PROMPT = `You convert an application request into a machine-readable IMPLEMENTATION
CONTRACT. You do not write code and you do not call tools. You reply with ONE JSON object and
nothing else — no prose, no markdown fence.

The contract is what the finished application will be TESTED against by an automated browser. Every
statement must therefore be an OBSERVABLE OUTCOME: something a test could click, type, read or
assert. "Add booking functionality" is not a contract. "Selecting an unavailable slot shows 'That
slot is taken' and does not create a booking" is.

The app is built in a fixed scaffold: Vite + React 18 + Tailwind, with a backend SDK
\`import { auth, db, storage } from "./lib/backend"\` providing auth (signUp/signIn/signOut/
currentUser/resetPassword/confirmReset), generic entity CRUD via db.entity("<type>"), and file
storage. Plan only within that: no extra packages, no raw HTTP, no other providers.

Shape:

{
  "summary": "one sentence describing the working application",
  "projectType": "landing | form | booking | dashboard | tool | saas | other",
  "journeys": [
    {
      "id": "book-a-slot",
      "title": "A visitor books an available slot",
      "priority": "primary",             // EXACTLY ONE journey is "primary" — the one that must
      "stage": "primary_journey",        // work before the preview may be shown. Others: "secondary".
      "steps": [
        { "action": "open the booking page", "target": "/book", "expect": "the list of services is visible" },
        { "action": "select a service and an available slot", "target": "service picker", "operates": ["serviceId", "slotId"], "expect": "the chosen slot is highlighted and the continue control becomes enabled" },
        { "action": "choose a party size within the slot's remaining capacity", "target": "party size control", "operates": ["partySize"], "reads": ["slotId", "slotCapacity"], "expect": "the chosen party size is displayed" },
        { "action": "enter name, email and phone and submit", "target": "details form", "operates": ["guestName", "guestEmail", "guestPhone"], "expect": "a confirmation with a booking reference is shown" },
        { "action": "reload the page and look the booking up by reference", "target": "manage booking", "reads": ["reference"], "expect": "the booking is still there after the reload" }
      ],
      "acceptance": ["a booking made in the browser survives a full page reload"]
    }
  ],
  "routes": [{ "path": "/", "name": "Home", "purpose": "...", "auth": false }],
  "entities": [{
    "name": "booking",
    "fields": [
      { "name": "slotId", "type": "string", "required": true },
      { "name": "guestName", "type": "string", "required": true },
      { "name": "guestEmail", "type": "string", "required": true },
      { "name": "reference", "type": "string", "required": true },
      { "name": "status", "type": "string", "required": true }
    ],
    "owned": true,                        // true when rows belong to the signed-in user
    "relationships": ["a booking references one slot"]
  }],
  "auth": { "required": true, "model": "email + password via the backend SDK", "rules": ["a signed-out visitor cannot see another customer's booking"] },
  "operations": [{
    "id": "create-booking", "entity": "booking", "kind": "create",
    "description": "persist a booking via db.entity('booking').create", "journey": "book-a-slot",
    "responsibilities": [{
      "type": "persistence", "capability": "crud", "capabilityMethod": "create",
      "reads": ["slotId", "guestName", "guestEmail"], "writes": ["reference", "status"]
    }]
  }],
  "integrations": [{ "name": "none", "purpose": "", "required": false }],
  "states": [{ "surface": "booking page", "loading": "skeleton while slots load", "empty": "no slots left this week", "validation": "email must look like an email", "error": "saving failed, try again", "success": "confirmation with reference" }],
  "acceptance": [{ "id": "a1", "statement": "a submitted booking is readable after a page reload", "journey": "book-a-slot", "kind": "persistence" }],
  "deferred": [{ "item": "real card payment", "reason": "payment is taken on arrival" }]
}

Rules:
- EVERY journey has at least two steps, and every step has an "expect" naming something visible.
- A step that manipulates controls lists them in "operates" — the fields it actually changes, by
  their declared entity field names. State the step merely DEPENDS on goes in "reads". A step that
  chooses a party size within a slot's capacity OPERATES partySize and READS slotId; naming the
  slot in "operates" would tell the verifier to re-open a control the previous step already used.
  "operates" may also name the declared OPERATION id the step performs. Fields become value
  controls; an operation id binds the action control and never becomes a textbox. A step may list
  both. "reads" names dependencies the step consumes without performing or changing them.
- Add "primitive": "selection" or "textbox" only when the verb leaves it ambiguous.
- EXACTLY ONE journey has priority "primary".
- At least three acceptance entries, each an observable outcome.
- Stages must be one of: ${STAGES.join(", ")}.
- If the request implies stored data, declare the entities and the operations that write them.
- Every operation declares \`responsibilities\`. Persistence and functional transformation are
  separate responsibilities even when they happen behind one button. CRUD may create/read/update/
  delete values supplied by its caller; it never calculates, generates, optimises, allocates or
  otherwise produces domain values. A transformation responsibility uses
  \`{ "type": "functional", "behavior": "...", "reads": [declared input fields],
  "writes": [declared output fields] }\`. Add a separate persistence responsibility when those
  outputs are saved. Only name \`capability\` and \`capabilityMethod\` when that exact registered method
  implements the functional behavior; otherwise leave them absent so Builder V2 creates a bounded
  custom_behavior extension.
- Functional operations that return an observable result without mutating entity state use a
  structured read-like or terminal kind: read/get/list/search/export/download/print. Their
  \`writes\` may be empty because Builder V2 gives the returned result transient state ownership;
  they must still declare the fields they \`read\`. Create/update/delete transformations still
  require explicit entity-field \`writes\`.
- Anything you are NOT building goes in "deferred" with a reason. Deferring is honest; a control
  that pretends to work is not.
- Public marketing content (business name, service list, opening hours) is in-code constants, NOT
  backend entities. Only user-created records are entities.`;

function extractJson(text) {
  const raw = String(text || "").trim();
  // Models fence JSON despite instructions; take the outermost object either way.
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : raw;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

// Fill in what the shape needs but a model may omit, so downstream code never guards every field.
export function normaliseContract(contract, { prompt, buildProfile = null, legacy = false }) {
  const c = { ...contract };
  c.version = CONTRACT_VERSION;
  c.summary = String(c.summary || "").trim() || String(prompt || "").slice(0, 160);
  c.projectType = c.projectType || "other";
  for (const key of ["journeys", "routes", "entities", "operations", "integrations", "states", "acceptance", "deferred"]) {
    if (!Array.isArray(c[key])) c[key] = [];
  }
  c.auth = c.auth && typeof c.auth === "object" ? c.auth : { required: false, model: null, rules: [] };
  if (!Array.isArray(c.auth.rules)) c.auth.rules = [];

  c.journeys = c.journeys.map((journey, index) => ({
    ...journey,
    id: journey.id || `journey-${index + 1}`,
    stage: STAGES.includes(journey.stage) ? journey.stage : "primary_journey",
    // A model that omits operates/reads leaves them ABSENT rather than empty: absent means "this
    // contract predates the structured schema, fall back to reading the prose", while an empty
    // list would mean "this step operates nothing", and the two must not be confused.
    steps: (Array.isArray(journey.steps) ? journey.steps : []).map((step) => {
      const list = (value) => (Array.isArray(value) ? value.map(String).filter(Boolean) : null);
      const operates = list(step?.operates);
      const reads = list(step?.reads);
      return {
        ...step,
        ...(operates?.length ? { operates } : {}),
        ...(reads?.length ? { reads } : {}),
      };
    }),
    acceptance: Array.isArray(journey.acceptance) ? journey.acceptance : [],
  }));
  // Exactly one primary, decided here rather than trusted: a contract with none would fail
  // validation, and a contract with three would make "the primary journey" ambiguous downstream.
  const primaries = c.journeys.filter((j) => j.priority === "primary");
  if (!primaries.length && c.journeys.length) c.journeys[0].priority = "primary";
  else if (primaries.length > 1) primaries.slice(1).forEach((j) => { j.priority = "secondary"; });

  c.entities = c.entities.map((entity) => ({
    ...entity,
    fields: Array.isArray(entity.fields) ? entity.fields : [],
    relationships: Array.isArray(entity.relationships) ? entity.relationships : [],
    owned: entity.owned !== false,
  }));
  c.operations = c.operations.map((operation) => {
    const normalizedOperation = { ...operation };
    if (!Array.isArray(operation?.responsibilities)) return normalizedOperation;
    normalizedOperation.responsibilities = operation.responsibilities.map((responsibility) => {
      const normalizedResponsibility = {
        ...responsibility,
        reads: Array.isArray(responsibility?.reads) ? responsibility.reads.map(String).filter(Boolean) : [],
        writes: Array.isArray(responsibility?.writes) ? responsibility.writes.map(String).filter(Boolean) : [],
      };
      const outputEffect = functionalOutputEffect(normalizedOperation, normalizedResponsibility);
      return outputEffect ? { ...normalizedResponsibility, outputEffect } : normalizedResponsibility;
    });
    return normalizedOperation;
  });
  c.buildProfile = resolveBuildProfile({ prompt, input: buildProfile, legacy });
  return c;
}

/**
 * Produce and validate the contract.
 *
 * Returns `{ contract, attempts, problems, warnings, usage }`; `contract` is null when the model
 * could not produce a usable one twice, and the caller carries on without it.
 */
export async function generateContract({
  provider, prompt, buildProfile = null, knowledge = "", log = () => {}, onUsage = null,
}) {
  const productProfile = resolveBuildProfile({ prompt, input: buildProfile, legacy: !buildProfile });
  const profileGuidance = buildProfileBrief(productProfile);
  let lastProblems = [];
  let usageTotal = null;
  // The best contract seen, even if it did not fully validate. Discarding a contract because one
  // acceptance line reads weakly throws away the journeys, the entities and the deferred list —
  // and in production that silently dropped the whole build back to unstaged, uncontracted
  // generation. A contract with a soft edge is worth far more than none.
  let best = null;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const ask = attempt === 1
      ? `${knowledge ? `${knowledge}\n\n` : ""}${profileGuidance}\n\nREQUEST:\n${prompt}`
      : `${knowledge ? `${knowledge}\n\n` : ""}${profileGuidance}\n\nREQUEST:\n${prompt}\n\nYour previous contract was rejected:\n${lastProblems.map((p) => `- ${p}`).join("\n")}\n\nReturn a corrected contract. Every step and acceptance entry must name something a browser test could observe.`;

    const { telemetry, finalText } = await runAgent({
      provider, systemPrompt: SYSTEM_PROMPT, tools: [], toolImpls: {},
      tree: {}, prompt: ask, log, onUsage,
    });
    usageTotal = telemetry;

    const parsed = extractJson(finalText);
    if (!parsed) {
      lastProblems = ["the reply was not a JSON object"];
      log(`contract: attempt ${attempt} did not return JSON`);
      continue;
    }
    const contract = normaliseContract(parsed, { prompt, buildProfile: productProfile });
    const baseVerdict = validateContract(contract);
    const profileVerdict = validateBuildProfileContract(contract, productProfile);
    const verdict = {
      ok: baseVerdict.ok && profileVerdict.ok,
      problems: [...baseVerdict.problems, ...profileVerdict.problems],
      warnings: baseVerdict.warnings,
    };
    if (verdict.ok) {
      log(`contract: ${contractSummary(contract)}${verdict.warnings.length ? ` (${verdict.warnings.length} warning(s))` : ""}`);
      return { contract, attempts: attempt, problems: [], warnings: verdict.warnings, usage: usageTotal };
    }
    lastProblems = verdict.problems;
    // Keep the one with fewer problems; a second attempt is not automatically better.
    if (!best || verdict.problems.length < best.problems.length) best = { contract, problems: verdict.problems };
    log(`contract: attempt ${attempt} rejected — ${verdict.problems.slice(0, 3).join("; ")}`);
  }

  // Neither attempt fully validated. Fall back to the better of the two rather than to nothing:
  // its journeys, entities and deferred list are still what the build should be judged against,
  // and the specific weaknesses travel with it so nothing downstream mistakes it for clean.
  if (best?.contract) {
    // A contract with no journeys cannot drive staging or verification — that one really is
    // unusable, and pretending otherwise would produce a stage plan built on nothing.
    const usable = (best.contract.journeys || []).some((j) => (j.steps || []).length >= 2);
    if (usable) {
      log(`contract: accepted with ${best.problems.length} unresolved problem(s) — ${best.problems.slice(0, 2).join("; ")}`);
      return { contract: best.contract, attempts: 2, problems: best.problems, warnings: [], usage: usageTotal, degraded: true };
    }
  }

  log(`contract: unavailable after 2 attempts — ${lastProblems.slice(0, 2).join("; ")}`);
  return { contract: null, attempts: 2, problems: lastProblems, warnings: [], usage: usageTotal };
}
