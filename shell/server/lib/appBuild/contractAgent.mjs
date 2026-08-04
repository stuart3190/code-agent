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
  CONTRACT_VERSION, STAGES, validateContract, contractSummary,
} from "../../../shared/implementationContract.mjs";

const SYSTEM_PROMPT = `You convert an application request into a machine-readable IMPLEMENTATION
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
        { "action": "select a service and an available slot", "target": "service picker", "expect": "the chosen slot is highlighted and the continue control becomes enabled" },
        { "action": "enter name, email and phone and submit", "target": "details form", "expect": "a confirmation with a booking reference is shown" },
        { "action": "reload the page and look the booking up by reference", "target": "manage booking", "expect": "the booking is still there after the reload" }
      ],
      "acceptance": ["a booking made in the browser survives a full page reload"]
    }
  ],
  "routes": [{ "path": "/", "name": "Home", "purpose": "...", "auth": false }],
  "entities": [{
    "name": "booking",
    "fields": [{ "name": "slotId", "type": "string", "required": true }],
    "owned": true,                        // true when rows belong to the signed-in user
    "relationships": ["a booking references one slot"]
  }],
  "auth": { "required": true, "model": "email + password via the backend SDK", "rules": ["a signed-out visitor cannot see another customer's booking"] },
  "operations": [{ "id": "create-booking", "entity": "booking", "kind": "create", "description": "persist a booking via db.entity('booking').create", "journey": "book-a-slot" }],
  "integrations": [{ "name": "none", "purpose": "", "required": false }],
  "states": [{ "surface": "booking page", "loading": "skeleton while slots load", "empty": "no slots left this week", "validation": "email must look like an email", "error": "saving failed, try again", "success": "confirmation with reference" }],
  "acceptance": [{ "id": "a1", "statement": "a submitted booking is readable after a page reload", "journey": "book-a-slot", "kind": "persistence" }],
  "deferred": [{ "item": "real card payment", "reason": "payment is taken on arrival" }]
}

Rules:
- EVERY journey has at least two steps, and every step has an "expect" naming something visible.
- EXACTLY ONE journey has priority "primary".
- At least three acceptance entries, each an observable outcome.
- Stages must be one of: ${STAGES.join(", ")}.
- If the request implies stored data, declare the entities and the operations that write them.
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
function normalise(contract, { prompt }) {
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
    steps: Array.isArray(journey.steps) ? journey.steps : [],
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
  return c;
}

/**
 * Produce and validate the contract.
 *
 * Returns `{ contract, attempts, problems, warnings, usage }`; `contract` is null when the model
 * could not produce a usable one twice, and the caller carries on without it.
 */
export async function generateContract({ provider, prompt, knowledge = "", log = () => {}, onUsage = null }) {
  let lastProblems = [];
  let usageTotal = null;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const ask = attempt === 1
      ? `${knowledge ? `${knowledge}\n\n` : ""}REQUEST:\n${prompt}`
      : `${knowledge ? `${knowledge}\n\n` : ""}REQUEST:\n${prompt}\n\nYour previous contract was rejected:\n${lastProblems.map((p) => `- ${p}`).join("\n")}\n\nReturn a corrected contract. Every step and acceptance entry must name something a browser test could observe.`;

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
    const contract = normalise(parsed, { prompt });
    const verdict = validateContract(contract);
    if (verdict.ok) {
      log(`contract: ${contractSummary(contract)}${verdict.warnings.length ? ` (${verdict.warnings.length} warning(s))` : ""}`);
      return { contract, attempts: attempt, problems: [], warnings: verdict.warnings, usage: usageTotal };
    }
    lastProblems = verdict.problems;
    log(`contract: attempt ${attempt} rejected — ${verdict.problems.slice(0, 3).join("; ")}`);
  }

  // Two failures. A build without a contract loses verification, which is bad; a build that never
  // happens is worse. Proceed, and say so where an operator will see it.
  log(`contract: unavailable after 2 attempts — ${lastProblems.slice(0, 2).join("; ")}`);
  return { contract: null, attempts: 2, problems: lastProblems, warnings: [], usage: usageTotal };
}
