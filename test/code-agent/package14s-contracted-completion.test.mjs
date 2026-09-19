import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyComplexity, COMPLEXITY } from "../../shell/server/lib/appBuild/buildProfile.mjs";
import {
  bindCapabilities, deriveModulePlan, completionEligibility, previewEligibility, tierContract,
} from "../../shell/server/lib/builderV2/contractTiering.mjs";
import {
  lintRequiredCapabilityBindings, lintRequiredModulePlan,
} from "../../shell/server/lib/builderV2/capabilityLint.mjs";
import { renderPatchPrompt } from "../../shell/server/lib/builderV2/modelLanes.mjs";
import { createOrchestrator } from "../../shell/server/lib/builderV2/orchestrator.mjs";
import { SEVERITY, severityOf } from "../../shell/server/lib/builderV2/validationSeverity.mjs";
import { readFileSync } from "node:fs";

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
  // The factories must be imported: the static application gate rejects an undefined identifier,
  // and a module that only appeared to call a capability is exactly what it exists to catch.
  "src/data/bookingSystem.js": `function makeBookingSystem(){
  return { createBooking: () => ({}), getBooking: () => ({}), cancelBooking: () => ({}) };
}
const booking = makeBookingSystem({ entity: "booking" });
booking.createBooking({}); booking.getBooking("BK-1"); booking.cancelBooking("BK-1"); export { booking };`,
  "src/data/bookingWizard.js": `function makeWizardMachine(){
  return { getState: () => ({}), subscribe: () => () => {}, restore: () => {}, select: () => {},
    next: () => {}, confirm: () => {}, cancel: () => {} };
}
const wizard = makeWizardMachine({ id: "booking", steps: [] });
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

test("14S derives a modular plan from the CONTRACT, not from a hardcoded application domain", () => {
  const plan = deriveModulePlan(BOOKING, BOOKING.journeys);
  // Module names come from the contract's own capability bindings and journey ids. A booking
  // contract still yields booking-shaped modules — because its contract says booking, not
  // because the planner does.
  assert.deepEqual(plan.map((module) => module.path), [
    "src/data/booking.js",
    "src/data/wizard.js",
    "src/components/complete-booking/CompleteBookingFlow.jsx",
    "src/components/complete-booking/CompleteBookingReview.jsx",
    "src/components/complete-booking/CompleteBookingConfirmation.jsx",
    "src/components/complete-booking/CompleteBookingStatus.jsx",
  ]);
  assert.deepEqual(plan.map((module) => module.role), [
    "booking capability adapter",
    "wizard capability adapter",
    "step navigation and flow composition",
    "review presentation",
    "confirmation and reference presentation",
    "restored and cancelled status presentation",
  ]);
  // No booking vocabulary is baked into the planner itself.
  const source = readFileSync(new URL("../../shell/server/lib/builderV2/contractTiering.mjs", import.meta.url), "utf8");
  const planner = source.slice(source.indexOf("export function deriveModulePlan"), source.indexOf("export function journeyStepKinds"));
  assert.equal(/booking|reservation/i.test(planner), false, "deriveModulePlan must not name an application domain");

  const prompt = renderPatchPrompt({
    step: "core", contract: BOOKING, tiers: tierContract(BOOKING), tree: {}, modulePlan: plan,
  });
  assert.match(prompt, /SUGGESTED MODULE PLAN/);
  assert.match(prompt, /exact paths are guidance, not a gate/);
  assert.match(prompt, /src\/data\/booking\.js: booking capability adapter; bind makeBookingSystem/);
  assert.match(prompt, /styling, layout, typography and component composition original/);

  const oneStep = { ...BOOKING, summary: "Simple booking", journeys: [{
    id: "book", title: "Book", priority: "primary",
    steps: [{ action: "submit booking", expect: "booking confirmed" }],
  }] };
  assert.deepEqual(deriveModulePlan(oneStep, oneStep.journeys), []);
});

test("14S the same planner serves non-booking applications with their own vocabulary", () => {
  const crm = {
    summary: "A CRM for tracking leads",
    entities: [{ name: "lead", fields: [{ name: "company" }, { name: "email" }] }],
    routes: [{ path: "/", name: "Leads" }],
    journeys: [{
      id: "manage-lead", title: "Manage a lead", priority: "primary",
      steps: [
        { action: "enter the company name", expect: "company captured" },
        { action: "select a pipeline stage", expect: "stage highlighted" },
        { action: "review the lead summary", expect: "summary shows company" },
        { action: "create the lead", expect: "lead reference shown" },
        { action: "cancel the lead", expect: "status shows cancelled" },
      ],
    }],
  };
  const plan = deriveModulePlan(crm, crm.journeys);
  assert.ok(plan.length, "a multi-step CRM journey earns a module plan");
  assert.equal(plan.some((module) => /booking/i.test(module.path)), false);
  assert.ok(plan.some((module) => module.path === "src/components/manage-lead/ManageLeadFlow.jsx"));
  assert.ok(plan.some((module) => module.path === "src/data/crud.js"));
});

test("14S reports missing planned modules as ADVISORY, never as a terminal rejection", () => {
  const plan = [
    { path: "src/data/booking.js", role: "booking capability adapter", factory: "makeBookingSystem" },
    { path: "src/components/complete-booking/CompleteBookingReview.jsx", role: "review presentation" },
  ];
  // The lint still SEES a differently-named tree...
  const verdict = lintRequiredModulePlan(COMPLETE_TREE, plan);
  assert.equal(verdict.ok, false);
  assert.match(verdict.problems.join("\n"), /src\/data\/booking\.js/);

  // ...but naming a file differently is guidance, not correctness: it must never block.
  for (const problem of verdict.problems) {
    const code = problem.startsWith("required planned module is missing") ? "required_module_missing" : "module_plan_violation";
    assert.equal(severityOf(code), SEVERITY.ADVISORY, problem);
  }
  assert.equal(lintRequiredModulePlan(COMPLETE_TREE, []).ok, true);
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

test("a differently-shaped module layout still COMPILES and RUNS; the shortfall is advisory", async () => {
  // The tree implements the contract but does not use the planned file names. Previously this
  // was terminal before compilation and cost a whole core attempt. It must now reach execution:
  // the browser decides whether the application works.
  const incomplete = { ...COMPLETE_TREE };
  delete incomplete["src/components/booking/BookingReview.jsx"];
  // The mounted screen still has to exist and reach the journey's components - that is the
  // platform contract, not a shape preference. The missing Review module is the shortfall.
  incomplete["src/screens/scaffold/BookingScreen.jsx"] = `
import BookingFlow from "../../components/booking/BookingFlow.jsx";
import BookingConfirmation from "../../components/booking/BookingConfirmation.jsx";
import BookingStatus from "../../components/booking/BookingStatus.jsx";
export default function BookingScreen(){
  return <main><BookingFlow/><BookingConfirmation/><BookingStatus/></main>;
}
`;
  let compileCalls = 0;
  const compileSteps = [];
  let browserCalls = 0;
  let receivedPlan = null;
  const logs = [];
  const orchestrator = createOrchestrator({
    contractFn: async () => BOOKING,
    patchesFn: async ({ modulePlan }) => {
      receivedPlan = modulePlan;
      // The mounted screen is composed by the platform before generation, so it is replaced
      // rather than added. Everything else keeps this fixture's deliberately different shape.
      return Object.entries(incomplete).map(([path, content]) => (path.startsWith("src/screens/scaffold/")
        ? { replaceFile: path, content } : { newFile: path, content }));
    },
    assetService: {
      async resolveIntents() { return { resolved: [], providerCalls: 0 }; },
      async assetManifestFor() { return []; },
    },
    baseTree: () => ({
      // The composed scaffold is a React application, so react must be declared here or the
      // imports gate correctly reports the dependency as missing.
      "package.json": JSON.stringify({ name: "app", type: "module", scripts: { build: "vite build" },
        dependencies: { react: "^18.3.1", "react-dom": "^18.3.1" } }),
      "index.html": '<!doctype html><html><body><div id="root"></div></body></html>',
      "vite.config.js": "export default {};",
      "src/main.jsx": "export {};",
      "src/App.jsx": "export default function App(){ return <main />; }",
    }),
    compile: async (_tree, execution) => { compileCalls += 1; compileSteps.push(execution?.step || "candidate"); return { ok: true }; },
    journeysFn: async () => { browserCalls += 1; return { journeys: [] }; },
    maxCoreAttempts: 1,
    log: (line) => logs.push(line),
  });
  const result = await orchestrator.runBuild({ owner: "owner", projectId: "project", request: "multi-step booking" });
  // The plan is still briefed to the model...
  // The plan briefs composed capability modules and the mounted screen that owns the journey,
  // rather than a component per step: universal scaffolds made screen composition the shape.
  // What matters here is unchanged - a plan reaches the model naming what it must implement.
  assert.ok(receivedPlan.length > 0, "a module plan is still briefed to the model");
  assert.ok(receivedPlan.some((module) => module.path.startsWith("src/screens/scaffold/")),
    `the mounted screen that owns the journey is briefed: ${receivedPlan.map((m) => m.path).join(", ")}`);
  // ...and the candidate still reached compilation AND the browser.
  // The platform compiles its own composed scaffold before generation, so the candidate compile
  // is the one that is NOT the foundation. That is the claim here: this shape was run, not
  // rejected for looking unfamiliar.
  assert.equal(compileSteps.filter((step) => step !== "scaffold_foundation").length, 1,
    `the candidate must be compiled, not discarded for its shape: ${logs.join(" | ")}`);
  assert.equal(browserCalls, 1, "behaviour must be verified in a browser");
  // It is blocked only because the contracted journeys were never proven green — the real bar.
  assert.equal(result.state, "blocked");
  assert.equal(result.failureClassification, "contracted_journeys_red");
  assert.ok(logs.some((line) => /advisory finding\(s\) recorded/.test(line)), logs.join("\n"));
  assert.ok((result.advisoryFindings || []).some((finding) => finding.code === "required_module_missing"),
    JSON.stringify(result.advisoryFindings));
});
