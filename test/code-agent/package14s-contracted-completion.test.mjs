import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyComplexity, COMPLEXITY } from "../../shell/server/lib/appBuild/buildProfile.mjs";
import {
  bindCapabilities, bookingModulePlan, completionEligibility, previewEligibility, tierContract,
} from "../../shell/server/lib/builderV2/contractTiering.mjs";
import {
  lintRequiredCapabilityBindings, lintRequiredModulePlan,
} from "../../shell/server/lib/builderV2/capabilityLint.mjs";
import { renderPatchPrompt } from "../../shell/server/lib/builderV2/modelLanes.mjs";
import { createOrchestrator } from "../../shell/server/lib/builderV2/orchestrator.mjs";

const BOOKING = {
  summary: "A distinctive multi-step table booking experience",
  entities: [{ name: "booking" }],
  operations: [{ id: "create-booking", entity: "booking", action: "create" }],
  routes: [{ path: "/", name: "Booking" }],
  auth: { required: false },
  journeys: [{
    id: "complete-booking", title: "Complete a multi-step booking", priority: "primary",
    steps: [
      { action: "select a date", expect: "available dates" },
      { action: "select a slot and party size", expect: "details form" },
      { action: "enter guest details", expect: "booking review summary" },
      { action: "review and confirm", expect: "confirmation with booking reference" },
      { action: "refresh the page", expect: "confirmed booking is restored" },
      { action: "cancel the booking", expect: "visible cancelled status" },
    ],
  }],
};

const COMPLETE_TREE = {
  "src/data/bookingSystem.js": `const booking = makeBookingSystem({ entity: "booking" });
booking.createBooking({}); booking.getBooking("BK-1"); booking.cancelBooking("BK-1"); export { booking };`,
  "src/data/bookingWizard.js": `const wizard = makeWizardMachine({ id: "booking", steps: [] });
wizard.getState(); wizard.subscribe(() => {}); wizard.restore(); wizard.select("date", "x");
wizard.next(); wizard.confirm(); wizard.cancel(); export { wizard };`,
  "src/components/booking/BookingFlow.jsx": "export function BookingFlow(){ return <section />; }",
  "src/components/booking/BookingReview.jsx": "export function BookingReview(){ return <section />; }",
  "src/components/booking/BookingConfirmation.jsx": "export function BookingConfirmation(){ return <section />; }",
  "src/components/booking/BookingStatus.jsx": "export function BookingStatus(){ return <section />; }",
};

test("14S completion requires every contracted journey, not only the essential tier", () => {
  const contract = {
    ...BOOKING,
    journeys: [
      BOOKING.journeys[0],
      { id: "contact-persistence", title: "Persist contact enquiry", priority: "secondary",
        steps: [{ action: "submit contact", expect: "saved confirmation" }] },
    ],
  };
  const tiers = tierContract(contract);
  assert.deepEqual(tiers.essential.journeys, ["complete-booking"]);
  const red = completionEligibility({ contract, gates: { ok: true }, journeyResults: { journeys: [
    { id: "complete-booking", status: "pass" },
    { id: "contact-persistence", status: "fail" },
  ] } });
  assert.equal(red.eligible, false);
  assert.match(red.failures.join("; "), /contact-persistence/);
  assert.equal(completionEligibility({ contract, gates: { ok: true }, journeyResults: { journeys: [
    { id: "complete-booking", status: "pass" },
    { id: "contact-persistence", status: "pass" },
  ] } }).eligible, true);
});

test("14S undriveable contracted controls remain distinct diagnostics but cannot become green", () => {
  const tiers = tierContract(BOOKING);
  const outcome = { journeys: [{ id: "complete-booking", status: "undriveable" }] };
  assert.equal(previewEligibility({ tiers, gates: { ok: true }, journeyResults: outcome }).eligible, false);
  assert.equal(completionEligibility({ contract: BOOKING, gates: { ok: true }, journeyResults: outcome }).eligible, false);
});

test("14S classifies explicit and contracted multi-step booking as medium while one-step booking stays simple", () => {
  assert.equal(classifyComplexity({ prompt: "a booking site for a strawberry farm" }).level, COMPLEXITY.simple);
  const explicit = classifyComplexity({ prompt: "a multi-step booking wizard with date, slot, review and confirmation" });
  assert.equal(explicit.level, COMPLEXITY.medium);
  assert.match(explicit.reasons.join(" "), /multi-step booking/);
  assert.equal(classifyComplexity({ prompt: "make the site", contract: BOOKING }).level, COMPLEXITY.medium);
});

test("14S derives the modular booking plan before generation without prescribing visual design", () => {
  const plan = bookingModulePlan(BOOKING, BOOKING.journeys);
  assert.deepEqual(plan.map((module) => module.path), [
    "src/data/bookingSystem.js",
    "src/data/bookingWizard.js",
    "src/components/booking/BookingFlow.jsx",
    "src/components/booking/BookingReview.jsx",
    "src/components/booking/BookingConfirmation.jsx",
    "src/components/booking/BookingStatus.jsx",
  ]);
  const prompt = renderPatchPrompt({
    step: "core", contract: BOOKING, tiers: tierContract(BOOKING), tree: {}, modulePlan: plan,
  });
  assert.match(prompt, /REQUIRED MODULE PLAN/);
  assert.match(prompt, /src\/data\/bookingSystem\.js: booking persistence adapter; bind makeBookingSystem/);
  assert.match(prompt, /styling, layout, typography and component composition original/);

  const oneStep = { ...BOOKING, summary: "Simple booking", journeys: [{
    id: "book", title: "Book", priority: "primary",
    steps: [{ action: "submit booking", expect: "booking confirmed" }],
  }] };
  assert.deepEqual(bookingModulePlan(oneStep, oneStep.journeys), []);
});

test("14S rejects missing planned modules and misplaced headless factory bindings deterministically", () => {
  const plan = bookingModulePlan(BOOKING, BOOKING.journeys);
  const missing = lintRequiredModulePlan({
    ...COMPLETE_TREE,
    "src/data/bookingWizard.js": undefined,
  }, plan);
  assert.equal(missing.ok, false);
  assert.match(missing.problems.join("\n"), /bookingWizard\.js/);

  const absent = { ...COMPLETE_TREE };
  delete absent["src/components/booking/BookingReview.jsx"];
  assert.equal(lintRequiredModulePlan(absent, plan).ok, false);
  assert.match(lintRequiredModulePlan(absent, plan).problems.join("\n"), /BookingReview\.jsx/);
  assert.equal(lintRequiredModulePlan(COMPLETE_TREE, plan).ok, true);
});

test("14S machine-enforces both booking and wizard capability contracts", () => {
  const bindings = bindCapabilities(BOOKING);
  assert.deepEqual(bindings.filter((binding) => binding.requiredMethods?.length).map((binding) => binding.name),
    ["booking", "wizard"]);
  const complete = lintRequiredCapabilityBindings(COMPLETE_TREE, bindings);
  assert.equal(complete.ok, true, complete.problems.join("; "));
  const withoutWizard = { ...COMPLETE_TREE };
  delete withoutWizard["src/data/bookingWizard.js"];
  const rejected = lintRequiredCapabilityBindings(withoutWizard, bindings);
  assert.equal(rejected.ok, false);
  assert.match(rejected.problems.join("\n"), /makeWizardMachine/);
});

test("14S orchestrator rejects a missing planned booking module before compile or browser verification", async () => {
  const incomplete = { ...COMPLETE_TREE };
  delete incomplete["src/components/booking/BookingReview.jsx"];
  let compileCalls = 0;
  let browserCalls = 0;
  let receivedPlan = null;
  const logs = [];
  const orchestrator = createOrchestrator({
    contractFn: async () => BOOKING,
    patchesFn: async ({ modulePlan }) => {
      receivedPlan = modulePlan;
      return Object.entries(incomplete).map(([path, content]) => ({ newFile: path, content }));
    },
    assetService: {
      async resolveIntents() { return { resolved: [], providerCalls: 0 }; },
      async assetManifestFor() { return []; },
    },
    baseTree: () => ({ "src/App.jsx": "export default function App(){ return <main />; }" }),
    compile: async () => { compileCalls += 1; return { ok: true }; },
    journeysFn: async () => { browserCalls += 1; return { journeys: [] }; },
    maxCoreAttempts: 1,
    log: (line) => logs.push(line),
  });
  const result = await orchestrator.runBuild({ owner: "owner", projectId: "project", request: "multi-step booking" });
  assert.equal(result.state, "blocked");
  assert.ok(receivedPlan.some((module) => module.path.endsWith("BookingReview.jsx")));
  assert.equal(compileCalls, 0);
  assert.equal(browserCalls, 0);
  assert.ok(logs.some((line) => /required planned module defect/.test(line)), logs.join("\n"));
});
