// PR4 — every build carries a machine-readable contract of what "built" means.
//
// diag_runs.plan was NULL on both failed production runs, and the plan the planner did produce was
// prose. Nothing downstream could ask "did the booking persist?" because nothing had written down
// that it must. A contract is the same intent expressed as outcomes a browser could check.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateContract, isVague, primaryJourney, journeysForStage,
  contractBrief, contractSummary, STAGES, CONTRACT_VERSION,
} from "../../shell/shared/implementationContract.mjs";

// The booking contract the brief enumerates, in full — this is the shape PR5-PR7 consume.
const BOOKING = {
  version: CONTRACT_VERSION,
  summary: "A pick-your-own farm site where visitors reserve a timed picking slot.",
  projectType: "booking",
  journeys: [
    {
      id: "book-a-slot", title: "A visitor books an available slot",
      priority: "primary", stage: "primary_journey",
      steps: [
        { action: "open the booking page", target: "/book", expect: "the list of services and their available slots is visible" },
        { action: "select a service and an available slot", target: "slot picker", expect: "the chosen slot is highlighted and continue becomes enabled" },
        { action: "enter name, email and phone and submit", target: "details form", expect: "a confirmation showing a booking reference is displayed" },
        { action: "reload and look the booking up by reference", target: "manage booking", expect: "the booking is still shown after the reload" },
      ],
      acceptance: ["a booking survives a full page reload"],
    },
    {
      id: "refuse-taken-slot", title: "A taken slot is refused",
      priority: "secondary", stage: "supporting",
      steps: [
        { action: "select a slot already at capacity", target: "slot picker", expect: "the slot is shown as unavailable and cannot be selected" },
        { action: "submit a duplicate booking for the same slot", target: "details form", expect: "an error appears and no second booking is stored" },
      ],
    },
    {
      id: "owner-manages", title: "The owner sees and cancels bookings",
      priority: "secondary", stage: "supporting",
      steps: [
        { action: "sign in as the farm owner", target: "/admin", expect: "the list of bookings is displayed" },
        { action: "cancel a booking", target: "bookings table", expect: "the booking disappears from the list and stays gone after a reload" },
      ],
    },
  ],
  routes: [
    { path: "/", name: "Home", purpose: "seasonal status and CTA", auth: false },
    { path: "/book", name: "Book", purpose: "the reservation journey", auth: false },
  ],
  entities: [{
    name: "booking",
    fields: [
      { name: "slotId", type: "string", required: true },
      { name: "email", type: "string", required: true },
      { name: "reference", type: "string", required: true },
    ],
    owned: true,
    relationships: ["a booking references one slot"],
  }],
  auth: { required: true, model: "email + password via the backend SDK", rules: ["a visitor cannot read another customer's booking"] },
  operations: [
    { id: "load-availability", entity: "booking", kind: "list", description: "read existing bookings to compute remaining capacity", journey: "book-a-slot" },
    { id: "create-booking", entity: "booking", kind: "create", description: "persist the booking via db.entity('booking').create", journey: "book-a-slot" },
  ],
  integrations: [{ name: "none", purpose: "", required: false }],
  states: [{
    surface: "booking page", loading: "skeleton while slots load", empty: "no slots left this week",
    validation: "email must look like an email", error: "saving failed, try again",
    success: "confirmation with reference",
  }],
  acceptance: [
    { id: "a1", statement: "a submitted booking is readable after a page reload", journey: "book-a-slot", kind: "persistence" },
    { id: "a2", statement: "submitting a duplicate slot shows an error and stores no second booking", journey: "refuse-taken-slot", kind: "validation" },
    { id: "a3", statement: "the owner list displays a booking created by a visitor", journey: "owner-manages", kind: "ownership" },
    { id: "a4", statement: "the booking form on a 375px viewport remains usable with no horizontal scroll", journey: "book-a-slot", kind: "responsive" },
  ],
  deferred: [{ item: "real card payment", reason: "payment is taken on arrival" }],
};

test("the booking contract covers every outcome the brief enumerates", () => {
  const verdict = validateContract(BOOKING);
  assert.deepEqual(verdict.problems, []);
  assert.equal(verdict.ok, true);

  // Each requirement named in the brief, found in the contract rather than assumed.
  const text = JSON.stringify(BOOKING).toLowerCase();
  for (const [requirement, needle] of [
    ["load services and availability", "available slots"],
    ["select a service and slot", "chosen slot is highlighted"],
    ["enter customer details", "name, email and phone"],
    ["validate submission", "email must look like an email"],
    ["persist the booking", "db.entity('booking').create"],
    ["refuse unavailable or duplicate slots", "no second booking"],
    ["show confirmation", "booking reference"],
    ["owner can view and manage bookings", "list of bookings is displayed"],
    ["data survives refresh", "survives a full page reload"],
    ["mobile workflow remains usable", "375px"],
  ]) {
    assert.ok(text.includes(needle.toLowerCase()), `${requirement}: expected the contract to name "${needle}"`);
  }
});

test("broad statements are rejected as unverifiable", () => {
  // The exact phrasing the brief forbids.
  assert.equal(isVague("add booking functionality"), true);
  assert.equal(isVague("implement authentication"), true);
  assert.equal(isVague("support payments"), true);
  assert.equal(isVague("CRUD"), true);
  assert.equal(isVague("user management"), true);
  assert.equal(isVague("make it work"), true);

  // Observable outcomes are accepted.
  assert.equal(isVague("submitting a duplicate slot shows an error and stores no second booking"), false);
  assert.equal(isVague("the booking is still shown after the reload"), false);
  assert.equal(isVague("the continue button is disabled until a slot is selected"), false);
});

test("a contract of broad statements fails validation rather than being trusted", () => {
  const vague = {
    summary: "A booking app",
    journeys: [{
      id: "j1", title: "Booking", priority: "primary",
      steps: [
        { action: "book", expect: "add booking functionality" },
        { action: "manage", expect: "user management" },
      ],
    }],
    acceptance: [
      { id: "a1", statement: "booking works" },
      { id: "a2", statement: "implement authentication" },
      { id: "a3", statement: "CRUD" },
    ],
    entities: [], operations: [], routes: [], states: [], deferred: [],
  };
  const verdict = validateContract(vague);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.problems.some((p) => /observable expectation/.test(p)));
  assert.ok(verdict.problems.some((p) => /not an observable outcome/.test(p)));
});

test("validation catches the structural failures that would break later stages", () => {
  const base = () => JSON.parse(JSON.stringify(BOOKING));

  const noPrimary = base();
  noPrimary.journeys.forEach((j) => { j.priority = "secondary"; });
  assert.ok(validateContract(noPrimary).problems.some((p) => /no journey is marked primary/.test(p)),
    "without a primary journey nothing defines what must work before shipping");

  const oneStep = base();
  oneStep.journeys[0].steps = [oneStep.journeys[0].steps[0]];
  assert.ok(validateContract(oneStep).problems.some((p) => /fewer than two steps/.test(p)));

  const ownedNoAuth = base();
  ownedNoAuth.auth = { required: false, rules: [] };
  assert.ok(validateContract(ownedNoAuth).problems.some((p) => /marked owned but the contract does not require authentication/.test(p)),
    "ownership that nothing authenticates cannot be enforced or checked");

  const thin = base();
  thin.acceptance = thin.acceptance.slice(0, 2);
  assert.ok(validateContract(thin).problems.some((p) => /fewer than three acceptance tests/.test(p)));

  const badStage = base();
  badStage.journeys[0].stage = "whenever";
  assert.ok(validateContract(badStage).problems.some((p) => /unknown stage/.test(p)));

  const dupes = base();
  dupes.journeys[1].id = dupes.journeys[0].id;
  assert.ok(validateContract(dupes).problems.some((p) => /duplicate journey id/.test(p)));
});

test("an empty contract fails rather than passing vacuously", () => {
  const verdict = validateContract({});
  assert.equal(verdict.ok, false);
  assert.ok(verdict.problems.some((p) => /no user journeys/.test(p)));
  assert.equal(validateContract(null).ok, false);
});

test("the primary journey is what gates the preview, and stages partition the work", () => {
  assert.equal(primaryJourney(BOOKING).id, "book-a-slot");
  assert.equal(journeysForStage(BOOKING, "primary_journey").length, 1);
  assert.equal(journeysForStage(BOOKING, "supporting").length, 2);
  assert.deepEqual(journeysForStage(BOOKING, "polish"), []);
  // Every stage a journey names must be one PR5 actually generates.
  for (const journey of BOOKING.journeys) assert.ok(STAGES.includes(journey.stage));
});

test("the brief handed to the builder states the checks, not the intentions", () => {
  const brief = contractBrief(BOOKING);

  assert.match(brief, /PRIMARY JOURNEY \(the preview cannot ship until this passes\)/);
  assert.match(brief, /the booking is still shown after the reload/);
  assert.match(brief, /booking \(owned by the signed-in user\)/);
  assert.match(brief, /slotId:string\*/, "required fields are marked, so the builder knows what to validate");
  assert.match(brief, /persist the booking via db\.entity/);
  assert.match(brief, /REQUIRED UI STATES/);
  assert.match(brief, /loading, empty, validation, error, success/);

  // Deferred work is named so the honesty scan (PR7) does not report it as an omission — and so
  // the builder does not fake it.
  assert.match(brief, /EXPLICITLY DEFERRED/);
  assert.match(brief, /real card payment \(payment is taken on arrival\)/);
  assert.match(brief, /do not fake them either/);

  // The sentence that makes appearance insufficient.
  assert.match(brief, /A button that only shows a toast, or data held in component state that a refresh loses/);
  assert.match(brief, /is a FAILURE of this contract even if the page looks finished/);
});

test("no contract produces no brief rather than a misleading one", () => {
  assert.equal(contractBrief(null), "");
  assert.equal(contractSummary(null), "no contract");
  assert.match(contractSummary(BOOKING), /3 journeys · 1 entities · 2 operations · 4 acceptance tests · 1 deferred/);
});

test("genuinely observable statements are not rejected for using unlisted verbs", () => {
  // Every one of these was rejected by the first version of isVague, in production, on a real
  // contract — which was then discarded whole, dropping the build back to uncontracted one-shot
  // generation. An allowlist of verbs is the wrong shape for this check.
  for (const statement of [
    "an iCalendar file for the confirmed date and time is offered",
    "Header navigation reaches Home, Book Now, Plan Your Visit, Our Farm",
    "The guest step visibly states the adult and child entry or deposit amount",
    "The booking flow states that no online payment is taken",
    "Each service card carries its price per punnet and a picking duration",
  ]) {
    assert.equal(isVague(statement), false, `wrongly rejected: "${statement}"`);
  }

  // And the slogans are still caught, which is the whole point of keeping the check at all.
  for (const slogan of ["booking works", "user management", "payment flow", "CRUD",
    "add booking functionality", "implement authentication", "make it work"]) {
    assert.equal(isVague(slogan), true, `wrongly accepted: "${slogan}"`);
  }
});

test("the per-job recorder forwards the contract to the run", async () => {
  // Found in production: the contract was generated, used to stage the build, and then never
  // stored, because `setContract` existed on the diagnostics SESSION but not on the per-job
  // recorder that buildJobs is actually handed. It failed silently as
  // "job.diag?.setContract is not a function" and PR6 would have had nothing to verify against.
  const { nullDiagSession } = await import("../../shell/server/lib/appBuild/buildDiagnostics.mjs");
  const nulled = nullDiagSession();
  assert.equal(typeof nulled.setContract, "function", "the no-op session must implement it too");
  assert.doesNotThrow(() => nulled.setContract({ journeys: [] }));
});
