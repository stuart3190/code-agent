// Canonical action-intent normalisation — one regression per demonstrated inflection failure,
// and one per prose phrase that must NOT become an interaction.
//
// Every defect below cost a real journey, and each was caused by the same thing: a raw
// word-boundary test standing in for "what kind of interaction is this?".
//
//   /\bbook\b/    ≠ "booking"       → "start the booking flow" derived no flow entry at all
//   /\bcancel\b/  ≠ "cancellation"  → "confirm cancellation" derived a bare create-shaped mutation
//   /\bconfirm\b/ ≠ "confirmation"  → a commit step named by its noun derived nothing to drive
//   /\brecover\b/ ≠ "recovery"      → a recovery step was judged as ordinary prose
//   /\badvance\b/ ≠ "advancing"     → a transition step fell through to keyword clicking
//
// The opposite failure is tested just as hard: "the cancellation policy is displayed" and "a valid
// confirmed booking reference" are prose ABOUT a record, and a looser matcher turns them into
// contracted interactions no control can satisfy.
//
// SCOPE: intents are interaction semantics only. Durable ownership is decided from declared
// lifecycle operations (see builder-v2-lifecycle-ownership.test.mjs); nothing here may decide it.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ACTION_INTENT, actionIntents, commencesSomething, hasActionIntent, phraseIntentMatches,
  progressesSomething,
} from "../../shell/server/lib/builderV2/actionIntent.mjs";
import { buildInteractionContract } from "../../shell/server/lib/builderV2/interactionContract.mjs";

const intents = (action, target = "") => [...actionIntents({ action, target })].sort();
const has = (action, target, intent) => hasActionIntent({ action, target }, intent);

// ── inflection: the same intent however the contract inflects it ────────────────────────────────

const INFLECTIONS = [
  // [intent, phrases that must all carry it]
  [ACTION_INTENT.CANCEL, ["cancel the booking", "cancels the booking", "cancelled the booking",
    "cancelling the booking", "confirm cancellation", "confirm the cancellation",
    "cancellation of the order"]],
  [ACTION_INTENT.CONFIRM, ["confirm the booking", "confirms the booking", "confirmed the booking",
    "confirmation of the order", "submit the details", "submitted the details", "submission",
    "save the changes", "update the lead", "updating the lead", "archive the lead",
    "archived the lead", "book the slot", "booked the slot", "reserve the table", "reserved the table"]],
  [ACTION_INTENT.RECOVER, ["reload the page", "refresh the page", "recover the booking",
    "recovers the booking", "recovery of the booking", "restore the draft", "restoration of the draft",
    "sign in again", "sign-in again"]],
  [ACTION_INTENT.LOOKUP, ["look up the booking", "lookup the booking", "looks up the booking",
    "lookup form", "find the order", "finding the order", "search for the order", "searches for the order",
    "retrieve the record"]],
  [ACTION_INTENT.ADVANCE, ["advance to the contact step", "advances to the contact step",
    "advancing to the contact step", "advanced to the contact step", "proceed to payment",
    "proceeding to payment", "continue to the review step", "move on to payment"]],
  [ACTION_INTENT.START, ["start the booking flow", "starting the booking flow", "begin checkout",
    "begins checkout", "open onboarding", "launch the wizard", "initiate a return",
    "create an order", "creating an order"]],
  [ACTION_INTENT.SELECTION, ["select a date", "selects a date", "selected a date", "selecting a date",
    "choose a slot", "chooses a slot", "pick a tier", "picked a tier"]],
  [ACTION_INTENT.INPUT, ["enter the email", "enters the email", "entered the email", "fill the form",
    "filled the form", "provide the details", "provided the details", "complete the form",
    "completed the form", "edit the notes", "edited the notes"]],
  [ACTION_INTENT.REVIEW, ["review the booking", "reviews the booking", "reviewing the booking",
    "review step"]],
];

for (const [intent, phrases] of INFLECTIONS) {
  for (const phrase of phrases) {
    test(`inflection — "${phrase}" carries the ${intent} intent`, () => {
      assert.equal(has(phrase, "", intent), true,
        `derived: ${intents(phrase).join(", ") || "nothing"}`);
    });
  }
}

test("a commit verb's OBJECT refines the commit — confirming a cancellation cancels", () => {
  // The defect: "confirm cancellation" derived a bare mutation indistinguishable from a creation,
  // because "cancellation" is not "cancel". Both facts are true of the step and both are derived.
  assert.deepEqual(intents("confirm cancellation", "confirm cancellation control"),
    [ACTION_INTENT.CANCEL, ACTION_INTENT.CONFIRM].sort());
  const matches = phraseIntentMatches("confirm cancellation");
  assert.equal(matches[0].position, "verb");
  assert.equal(matches[1].position, "commit_object");
});

// ── prose: a related word is not an interaction ────────────────────────────────────────────────

const PROSE = [
  // [action, target, the intent it must NOT carry, why]
  ["the cancellation policy is displayed", "policy section", ACTION_INTENT.CANCEL,
    "a policy naming cancellation cancels nothing"],
  ["a valid confirmed booking reference is shown", "confirmation panel", ACTION_INTENT.CONFIRM,
    "\"confirmed\" describes the record's state, it does not commit one"],
  ["open a confirmed booking", "/manage", ACTION_INTENT.CONFIRM,
    "opening an already-confirmed record commits nothing"],
  ["enter a valid confirmed order reference and matching email", "lookup form", ACTION_INTENT.CONFIRM,
    "the reference belongs to a record that already exists"],
  ["review the booking", "review step", ACTION_INTENT.CONFIRM,
    "a review observes; the noun \"booking\" is the record, not the act"],
  ["advance to the contact details step", "booking wizard", ACTION_INTENT.CONFIRM,
    "a target that names a booking surface is not a commit"],
  ["the created order is displayed", "order summary", ACTION_INTENT.CONFIRM,
    "narrating a created record is not creating one"],
  ["the confirmation screen shows the reference", "confirmation screen", ACTION_INTENT.CONFIRM,
    "the confirmation SCREEN is a surface, not an action"],
  ["the booking reference remains visible", "booking details", ACTION_INTENT.CONFIRM,
    "a record noun in a subject phrase is never a verb"],
  ["the recovery email address is shown", "profile panel", ACTION_INTENT.RECOVER,
    "a field named recovery recovers nothing"],
  ["the selection is highlighted", "slot cards", ACTION_INTENT.SELECTION,
    "describing a selected state does not choose anything"],
];

for (const [action, target, intent, why] of PROSE) {
  test(`prose — "${action}" is not a ${intent} step (${why})`, () => {
    assert.equal(has(action, target, intent), false, `derived: ${intents(action, target).join(", ")}`);
  });
}

// ── choosing an ACTION is not choosing a value ─────────────────────────────────────────────────

const INFINITIVE_ACTIONS = [
  ["choose to cancel the booking", ACTION_INTENT.CANCEL],
  ["choose to archive the lead", ACTION_INTENT.CONFIRM],
  ["select to delete the record", ACTION_INTENT.CONFIRM],
  ["choose to update the lead", ACTION_INTENT.CONFIRM],
];

for (const [phrase, intent] of INFINITIVE_ACTIONS) {
  test(`"${phrase}" chooses an action, not a value`, () => {
    // The verb after "to" is the step's real intent. Read as a selection, the derivation invents a
    // FIELD out of the verb ("archive", "delete") and the driver hunts for an option group named
    // after it — which no correct application has. A CRM archive journey was undriveable on
    // exactly this, while booking survived only because "cancel" sat in a hardcoded stop-word list.
    assert.equal(has(phrase, "", ACTION_INTENT.SELECTION), false,
      `derived: ${intents(phrase).join(", ")}`);
    assert.equal(has(phrase, "", intent), true, `derived: ${intents(phrase).join(", ")}`);
  });
}

test("a genuine chooser is still a selection", () => {
  for (const phrase of ["choose a party size within the remaining seats", "select a delivery speed",
    "choose an item count", "pick a lead source", "select a date with availability"]) {
    assert.equal(has(phrase, "", ACTION_INTENT.SELECTION), true, `derived: ${intents(phrase).join(", ")}`);
  }
  // "to" that is not an infinitive marker for an action leaves the selection alone.
  assert.equal(has("choose a slot to suit the party", "", ACTION_INTENT.SELECTION), true);
});

test("a composite make-selection clause carries selection intent", () => {
  assert.equal(has("open the booking experience and make a date, slot, and party size selection",
    "/book", ACTION_INTENT.SELECTION), true);
});

test("a routed composite selection retains every structured chooser operand", () => {
  const contract = {
    summary: "booking", projectType: "web app", version: 1, auth: { required: false },
    routes: [{ path: "/book", name: "Book" }],
    entities: [{ name: "booking", fields: [
      { name: "dateId", type: "string" }, { name: "slotId", type: "string" },
      { name: "partySize", type: "number" },
    ] }],
    operations: [], journeys: [{ id: "contact-validation", title: "contact validation", priority: "primary",
      steps: [{ action: "open the booking experience and make a date, slot, and party size selection",
        target: "/book", operates: ["booking.dateId", "booking.slotId", "booking.partySize"],
        expect: "contact fields become visible" }],
    }], acceptance: [], states: [], deferred: [], imageIntents: [], integrations: [],
  };
  const flows = buildInteractionContract(contract).flows.filter((flow) => flow.kind === "selection");
  assert.deepEqual(flows.map((flow) => flow.valueWritten), ["dateId", "slotId", "partySize"]);
});

// ── the validity intent belongs to the field the action NAMES ──────────────────────────────────

test("an invalid-value step makes ONLY the field it names invalid", () => {
  // "enter an invalid contact email" derives contactEmail AND contactName — naming the contact
  // pulls the whole group in. Stamping the invalid intent on both asks the application to reject
  // an ordinary name, which no correct app can do and which the driver reports as
  // validation_intent_unsupported. One contracted intent, one contracted field.
  const contract = {
    summary: "generic", projectType: "web app", version: 1, auth: { required: false },
    routes: [{ path: "/", name: "Home" }],
    entities: [{ name: "person", fields: [{ name: "contactName", type: "string" },
      { name: "contactEmail", type: "string" }, { name: "notes", type: "string" }] }],
    operations: [],
    journeys: [{ id: "journey", title: "journey", priority: "primary", steps: [
      { action: "enter an invalid contact email", target: "contact fields",
        expect: "a validation message is shown and the continue control remains disabled" },
      { action: "enter a valid contact email and required details", target: "contact fields",
        expect: "the validation message clears" },
    ] }],
    acceptance: [], states: [], deferred: [], imageIntents: [], integrations: [],
  };
  const plan = buildInteractionContract(contract);
  const validity = Object.fromEntries(plan.flows.filter((flow) => flow.kind === "input" && flow.stepIndex === 0)
    .map((flow) => [flow.control.logicalField, flow.control.validity]));
  assert.ok(Object.keys(validity).length > 1, `the step derives several fields: ${JSON.stringify(validity)}`);
  assert.equal(validity.contactEmail, "invalid");
  assert.equal(validity.contactName, "unspecified");
});

test("an invalid-value step that names no field keeps the intent on every field it derives", () => {
  // The single-field case every earlier contract had: nothing to disambiguate, so nothing changes.
  const contract = {
    summary: "generic", projectType: "web app", version: 1, auth: { required: false },
    routes: [{ path: "/", name: "Home" }],
    entities: [{ name: "guest", fields: [{ name: "guestEmail", type: "string" }] }],
    operations: [],
    journeys: [{ id: "journey", title: "journey", priority: "primary", steps: [
      { action: "enter an invalid email address", target: "email field",
        expect: "a validation message is shown and the continue control remains disabled" },
    ] }],
    acceptance: [], states: [], deferred: [], imageIntents: [], integrations: [],
  };
  const plan = buildInteractionContract(contract);
  const inputs = plan.flows.filter((flow) => flow.kind === "input");
  assert.ok(inputs.length >= 1);
  for (const flow of inputs) assert.equal(flow.control.validity, "invalid", flow.control.logicalField);
});

// ── ADVERSARIAL PROSE — the five words that have each caused a defect, used as nouns ───────────

test("a whole journey of descriptive prose derives no interaction at all", () => {
  // Every sentence below contains a word that once created a phantom interaction. None of them
  // asks anyone to do anything: they describe a record, a policy or a screen. A contract written
  // like this must derive an empty interaction plan rather than a journey of imaginary controls.
  const contract = {
    summary: "generic", projectType: "web app", version: 1, auth: { required: false },
    routes: [{ path: "/", name: "Home" }],
    entities: [{ name: "record", fields: [{ name: "reference", type: "string" }] }],
    operations: [],
    journeys: [{ id: "prose", title: "prose", priority: "primary", steps: [
      { action: "the booking policy is summarised on the page", target: "policy panel",
        expect: "the booking policy text is visible" },
      { action: "the cancellation window is described in the terms", target: "terms section",
        expect: "the cancellation window is visible" },
      { action: "the confirmation email wording is shown to the operator", target: "confirmation preview",
        expect: "the confirmation wording is visible" },
      { action: "the recovery procedure is documented for support staff", target: "recovery notes",
        expect: "the recovery procedure is visible" },
      { action: "an advancing queue position is displayed to the visitor", target: "queue panel",
        expect: "the queue position is visible" },
    ] }],
    acceptance: [], states: [], deferred: [], imageIntents: [], integrations: [],
  };
  const plan = buildInteractionContract(contract);
  assert.deepEqual(plan.flows.map((flow) => `${flow.stepIndex}:${flow.kind}`), [],
    `prose derived interactions: ${JSON.stringify(plan.flows.map((f) => f.id))}`);
});

test("the same five words, used as verbs, do derive their intents", () => {
  // The control side of the claim: the normaliser is not simply deaf to these words.
  assert.equal(has("book the slot", "", ACTION_INTENT.CONFIRM), true);
  assert.equal(has("cancel the reservation", "", ACTION_INTENT.CANCEL), true);
  assert.equal(has("confirm the order", "", ACTION_INTENT.CONFIRM), true);
  assert.equal(has("recover the draft", "", ACTION_INTENT.RECOVER), true);
  assert.equal(has("advance to the payment step", "", ACTION_INTENT.ADVANCE), true);
});

test("commencement and progression need a verb in verb position", () => {
  assert.equal(commencesSomething({ action: "start the booking flow", target: "start booking control" }), true);
  assert.equal(commencesSomething({ action: "begin checkout", target: "start checkout control" }), true);
  assert.equal(commencesSomething({ action: "the created order is displayed", target: "order summary" }), false);
  assert.equal(progressesSomething({ action: "advancing to the payment step", target: "wizard" }), true);
  assert.equal(progressesSomething({ action: "the continued session is restored", target: "" }), false);
});

// ── the same facts, through the real derivation ────────────────────────────────────────────────

const contractFor = (steps) => ({
  summary: "generic", projectType: "web app", version: 1, auth: { required: false },
  routes: [{ path: "/", name: "Home" }],
  entities: [{ name: "record", fields: [{ name: "reference", type: "string" }, { name: "title", type: "string" },
    { name: "status", type: "string" }] }],
  operations: [{ id: "read-record", entity: "record", kind: "read", journey: "journey",
    responsibilities: [{ type: "persistence", capability: "crud", capabilityMethod: "get",
      reads: ["reference"], writes: [] }] }],
  journeys: [{ id: "journey", title: "journey", priority: "primary", steps }],
  acceptance: [], states: [], deferred: [], imageIntents: [], integrations: [],
});
const kindsOf = (steps) => {
  const plan = buildInteractionContract(contractFor(steps));
  return plan.flows.map((flow) => `${flow.stepIndex}:${flow.kind}`);
};

test("derivation — an inflected flow entry derives flow_start, not a mutation", () => {
  const kinds = kindsOf([
    { action: "start the booking flow", target: "start booking control", expect: "the first step is shown" },
    { action: "select a date", target: "date picker", expect: "the chosen date is highlighted" },
  ]);
  assert.ok(kinds.includes("0:flow_start"), kinds.join(", "));
  assert.equal(kinds.includes("0:mutation"), false, `no commit for a flow entry: ${kinds.join(", ")}`);
});

test("a later explicit primitive makes an earlier menu opener a flow entry", () => {
  const kinds = kindsOf([
    { action: "open the catalogue tools", target: "tools menu", expect: "catalogue tools are visible" },
    { action: "change the software status", target: "status selector", operates: ["status"],
      primitive: "selection", expect: "the chosen status is visible" },
  ]);
  assert.ok(kinds.includes("0:flow_start"), kinds.join(", "));
  assert.equal(kinds.includes("0:navigation"), false, kinds.join(", "));
});

test("derivation — an inflected transition derives flow_advance", () => {
  const kinds = kindsOf([
    { action: "advancing to the details step", target: "booking wizard", expect: "the details field is visible" },
    { action: "enter the title", target: "details form", expect: "the entered title is visible" },
  ]);
  assert.ok(kinds.includes("0:flow_advance"), kinds.join(", "));
});

test("derivation — a cancellation commit derives BOTH its commit and its cancellation", () => {
  const kinds = kindsOf([
    { action: "open an existing record", target: "/", expect: "the record and a cancel control are visible" },
    { action: "choose to cancel the record", target: "cancel control", expect: "a cancellation prompt is displayed" },
    { action: "confirm cancellation", target: "confirm cancellation control",
      expect: "the record status becomes Cancelled" },
  ]);
  assert.ok(kinds.includes("1:cancellation"), kinds.join(", "));
  assert.ok(kinds.includes("2:cancellation"), kinds.join(", "));
  assert.ok(kinds.includes("2:mutation"), kinds.join(", "));
});

test("derivation — prose about a record derives no interaction at all", () => {
  const kinds = kindsOf([
    { action: "open the confirmation page", target: "/", expect: "the confirmation screen is shown" },
    { action: "the cancellation policy is displayed", target: "policy section",
      expect: "the cancellation policy text is visible" },
  ]);
  assert.equal(kinds.includes("1:cancellation"), false, kinds.join(", "));
  assert.equal(kinds.includes("1:mutation"), false, kinds.join(", "));
  assert.equal(kinds.includes("1:lookup"), false, kinds.join(", "));
});

test("opening a lookup AREA is navigation; looking a record up is a lookup", () => {
  const opening = kindsOf([
    { action: "open the record lookup area", target: "/", expect: "a reference lookup form is visible" },
    { action: "look up an existing record by reference", target: "lookup form",
      expect: "the record details are displayed" },
  ]);
  assert.ok(opening.includes("0:navigation"), opening.join(", "));
  assert.equal(opening.includes("0:lookup"), false,
    `the record cannot be on screen before it has been asked for: ${opening.join(", ")}`);
  assert.ok(opening.includes("1:lookup"), opening.join(", "));
});

test("a first sign-in authenticates without inventing durable-record recovery", () => {
  assert.equal(has("sign in and open a workspace", "workspace", ACTION_INTENT.RECOVER), false);
  assert.equal(has("sign in again", "account form", ACTION_INTENT.RECOVER), true);
  assert.equal(has("sign back in", "account form", ACTION_INTENT.RECOVER), true);
});

// ── attributive participles in a TARGET describe a record, they do not commit one ───────────────
//
// Medium qualification on 5bcf0b2 (2026-09-07): "open the created project detail" targeting
// "created project row" derived a MUTATION, because "created" at the head of the target phrase was
// read as a finite commit verb. The verifier then demanded a commit control by machine identity on
// a row the app rightly rendered as a link, and six repair rounds spent 21 credits on it.

test("a past participle heading a target names the record, not a commit", () => {
  assert.deepEqual(intents("open the created project detail", "created project row"), ["navigate", "start"]);
  assert.equal(has("open the created project detail", "created project row", ACTION_INTENT.CONFIRM), false);
  assert.equal(has("view the submitted order", "submitted order card", ACTION_INTENT.CONFIRM), false);
  assert.equal(has("open the selected member", "selected member row", ACTION_INTENT.SELECTION), false);
});

test("a finite commit verb in a target still commits, with or without a preceder", () => {
  assert.ok(has("confirm the booking", "confirm booking control", ACTION_INTENT.CONFIRM));
  assert.ok(has("submit the form", "review and submit control", ACTION_INTENT.CONFIRM));
  assert.ok(has("save the changes", "save changes button", ACTION_INTENT.CONFIRM));
});

test("derivation — opening the created record's row is navigation into it, not a second commit", () => {
  const kinds = kindsOf([
    { action: "open the projects route", target: "/projects", expect: "the projects list is shown" },
    { action: "create a project", target: "new project form", operates: ["title", "create-project"],
      expect: "the new project appears in the project list" },
    { action: "open the created project detail", target: "created project row", reads: ["title"],
      expect: "the project detail page shows the project title" },
  ]);
  assert.equal(kinds.includes("2:mutation"), false, `no commit for opening a row: ${kinds.join(", ")}`);
  assert.ok(kinds.includes("2:navigation") || kinds.includes("2:action") || kinds.includes("2:lookup"),
    `the step still drives something: ${kinds.join(", ")}`);
});
