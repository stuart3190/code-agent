import test from "node:test";
import assert from "node:assert/strict";

import { bindCapabilities, deriveModulePlan, tierContract } from "../../shell/server/lib/builderV2/contractTiering.mjs";
import { buildInteractionContract } from "../../shell/server/lib/builderV2/interactionContract.mjs";
import {
  buildModuleGenerationContracts, moduleCorrectionScope, moduleGenerationContractsBrief,
  moduleGenerationContractsRepairBrief,
  validateModuleConformance, validateModulePatchScope,
} from "../../shell/server/lib/builderV2/moduleContracts.mjs";
import { renderPatchPrompt } from "../../shell/server/lib/builderV2/modelLanes.mjs";
import { createOrchestrator } from "../../shell/server/lib/builderV2/orchestrator.mjs";
import { SEVERITY } from "../../shell/server/lib/builderV2/validationSeverity.mjs";
import { fromScaffold } from "../../src/engine/fileTree.mjs";
import { REACT_VITE } from "../../src/scaffolds/reactVite.mjs";
import { buildTree, ensureDeps } from "../../harness/workspace.mjs";

const BOOKING = {
  summary: "A multi-step booking workflow with review, durable recovery and cancellation",
  entities: [{ name: "booking", fields: [
    { name: "date", type: "string", required: true },
    { name: "slot", type: "string", required: true },
    { name: "partySize", type: "number", required: true },
    { name: "name", type: "string", required: true },
    { name: "email", type: "string", required: true },
    { name: "phone", type: "string", required: true },
  ] }],
  operations: [{ id: "create-booking", entity: "booking", action: "create" }],
  routes: [{ path: "/", name: "Booking" }], auth: { required: false },
  journeys: [{ id: "book", title: "Complete and manage a multi-step booking", priority: "primary", steps: [
    { action: "select a date", target: "date", expect: "selected date becomes active" },
    { action: "select a slot", target: "slot", expect: "selected slot becomes active" },
    { action: "select party size", target: "party size", expect: "party size is visible" },
    { action: "enter name, email and phone", target: "contact", expect: "contact values are accepted" },
    { action: "review exact date slot party name email phone", target: "review", expect: "review displays exact values" },
    { action: "confirm booking", target: "confirm booking", expect: "durable booking reference" },
    { action: "reload and lookup booking", target: "booking status", expect: "booking is restored" },
    { action: "cancel booking", target: "cancel booking", expect: "cancelled status survives reload" },
  ] }],
};

const PLAN = deriveModulePlan(BOOKING, BOOKING.journeys);
const BINDINGS = bindCapabilities(BOOKING);
const INTERACTIONS = buildInteractionContract(BOOKING, { modulePlan: PLAN, bindings: BINDINGS });
const CONTRACTS = buildModuleGenerationContracts({
  contract: BOOKING, modulePlan: PLAN, interactionContract: INTERACTIONS, bindings: BINDINGS,
});

const CORRECT = {
  "src/data/booking.js": `import { makeBookingSystem } from "../lib/capabilities/booking";
const booking = makeBookingSystem({ entity: "booking" });
export const createBooking = (draft) => booking.createBooking(draft);
export const getBooking = (id) => booking.getBooking(id);
export const cancelBooking = (id) => booking.cancelBooking(id);`,
  "src/data/wizard.js": `import { makeWizardMachine } from "../lib/capabilities/wizard";
const wizard = makeWizardMachine({ id: "book", steps: ["date","slot","party","contact","review","confirm"] });
wizard.getState(); wizard.subscribe(() => {}); wizard.restore(); wizard.select("date", "2026-08-12");
wizard.next(); wizard.confirm(); wizard.cancel(); export { wizard };`,
  "src/components/book/BookFlow.jsx": `export function BookingFlow({ draft, setDraft, confirm, cancel }) { return <main>
<button aria-label="date" aria-pressed={Boolean(draft.date)} onClick={() => setDraft({...draft,date:"2026-08-12"})}>Date</button>
<button aria-label="slot" aria-pressed={Boolean(draft.slot)} onClick={() => setDraft({...draft,slot:"10:00"})}>Slot</button>
<button aria-label="party size" aria-pressed={draft.partySize === 2} onClick={() => setDraft({...draft,partySize:2})}>Party</button>
<label>Name<input name="name" aria-label="name" value={draft.name} onChange={(e)=>setDraft({...draft,name:e.target.value})}/></label>
<label>Email<input type="email" name="email" aria-label="email" value={draft.email} onChange={(e)=>setDraft({...draft,email:e.target.value})}/></label>
<label>Phone<input type="tel" name="phone" aria-label="phone" value={draft.phone} onChange={(e)=>setDraft({...draft,phone:e.target.value})}/></label>
<button aria-label="confirm booking" onClick={confirm}>Confirm booking</button><button aria-label="cancel booking" onClick={cancel}>Cancel booking</button>
</main> }`,
  "src/components/book/BookReview.jsx": `export function BookingReview({draft}) { return <p>{draft.date} {draft.slot} {draft.partySize} {draft.name} {draft.email} {draft.phone}</p> }`,
  "src/components/book/BookConfirmation.jsx": `export function BookingConfirmation({booking}) { return <p>Booking reference {booking.reference}</p> }`,
  "src/components/book/BookStatus.jsx": `export function BookingStatus({booking,onLookup}) { return <section><button aria-label="booking status" onClick={onLookup}>Look up booking</button><p>{booking.reference} {booking.status}</p></section> }`,
};

const verdict = (tree) => validateModuleConformance(tree, {
  contract: BOOKING, modulePlan: PLAN, moduleContracts: CONTRACTS, interactionContract: INTERACTIONS, bindings: BINDINGS,
});

test("per-module generation specifications carry capability, identity, ownership, flow and size facts", () => {
  const flow = CONTRACTS.specifications.find((row) => row.path.endsWith("BookFlow.jsx"));
  const booking = CONTRACTS.specifications.find((row) => row.path.endsWith("booking.js"));
  assert.ok(flow.semanticInteractions.some((row) => row.logicalField === "date"));
  assert.ok(flow.semanticInteractions.some((row) => row.logicalField === "email"));
  assert.ok(flow.downstream.produces.some((path) => path.endsWith("date")));
  assert.equal(booking.requiredCapabilities[0].factory, "makeBookingSystem");
  assert.ok(booking.requiredCapabilities[0].methods.every((method) => method.bound && method.invoked));
  assert.ok(booking.forbiddenCapabilityBypasses.some((row) => row.entity === "booking"));
  assert.equal(flow.moduleSizeBoundary, 5_500);
  const prompt = renderPatchPrompt({ step: "core", contract: { ...BOOKING, interactionContract: INTERACTIONS },
    tiers: tierContract(BOOKING), tree: {}, modulePlan: PLAN, moduleContracts: CONTRACTS });
  assert.match(prompt, /PER-MODULE GENERATION CONTRACTS/);
  assert.match(prompt, /"semanticInteractions"/);
  assert.match(prompt, /"forbiddenCapabilityBypasses"/);
});

test("browser-informed repair gets a compact contract summary while full enforcement remains", () => {
  const full = moduleGenerationContractsBrief(CONTRACTS);
  const compact = moduleGenerationContractsRepairBrief(CONTRACTS);
  assert.match(compact, /full contracts remain machine-enforced/);
  assert.match(compact, /makeWizardMachine/);
  assert.match(compact, /partySize/);
  assert.match(compact, /capabilityOwnership/);
  assert.ok(Buffer.byteLength(compact) < Buffer.byteLength(full) * 0.6,
    "repair summary must remove the repeated full-contract payload");

  const prompt = renderPatchPrompt({ step: "repair",
    contract: { ...BOOKING, interactionContract: INTERACTIONS }, tiers: tierContract(BOOKING),
    tree: CORRECT, modulePlan: PLAN, moduleContracts: CONTRACTS,
    problems: ["guest email control did not retain its value"] });
  assert.match(prompt, /PER-MODULE REPAIR CONTRACT SUMMARY/);
  assert.doesNotMatch(prompt, /"forbiddenCapabilityBypasses"/,
    "capability ownership is deduplicated instead of repeated in every module");
});

test("a focused repair summary excludes unrelated journeys and state carried by a shared module", () => {
  const compact = moduleGenerationContractsRepairBrief({ version: 1, specifications: [{
    path: "src/components/SharedFlow.jsx", role: "shared flow",
    ownedJourneys: ["failed-journey", "unrelated-journey"], requiredImports: [],
    requiredCapabilities: [], forbiddenCapabilityBypasses: [],
    semanticInteractions: [
      { interactionId: "failed-journey:1:input:name", journeyId: "failed-journey",
        logicalField: "name", accessibleNames: ["name"], roles: ["textbox"], inputTypes: ["text"],
        writes: ["failed-journey.draft.name"], stateOwner: "src/components/SharedFlow.jsx" },
      { interactionId: "unrelated-journey:1:input:name", journeyId: "unrelated-journey",
        logicalField: "name", accessibleNames: ["name"], roles: ["textbox"], inputTypes: ["text"],
        writes: ["unrelated-journey.draft.name"], stateOwner: "src/components/SharedFlow.jsx" },
    ],
    state: { owns: "ephemeral UI", mayConsume: ["failed-journey.draft.name", "unrelated-journey.draft.name"],
      mustProduce: ["failed-journey.draft.name", "unrelated-journey.draft.name"], survivesReload: false },
    persistence: { owner: null }, requiredExports: [], moduleSizeBoundary: 5_500,
  }] }, { focusPaths: ["src/components/SharedFlow.jsx"],
    focusControls: ["failed-journey:1:input:name", "name"] });
  assert.match(compact, /failed-journey/);
  assert.doesNotMatch(compact, /unrelated-journey/);
  assert.match(compact, /failed-journey\.draft\.name/);
  assert.doesNotMatch(compact, /unrelated-journey\.draft\.name/);
});

test("browser repair prompt includes every failed journey but only their failed interaction steps", () => {
  const secondary = {
    id: "validate-contact", title: "Validate contact", priority: "secondary", steps: [
      { action: "open booking", target: "/book", expect: "contact form visible" },
      { action: "enter an invalid email", target: "email", expect: "validation message visible" },
    ],
  };
  const contract = { ...BOOKING, journeys: [...BOOKING.journeys, secondary] };
  const plan = deriveModulePlan(contract, contract.journeys);
  const bindings = bindCapabilities(contract);
  const interactions = buildInteractionContract(contract, { modulePlan: plan, bindings });
  const moduleContracts = buildModuleGenerationContracts({
    contract, modulePlan: plan, interactionContract: interactions, bindings,
  });
  const prompt = renderPatchPrompt({ step: "repair",
    contract: { ...contract, interactionContract: interactions }, tiers: tierContract(contract),
    tree: CORRECT, modulePlan: plan, moduleContracts,
    problems: ["journey validate-contact: enter an invalid email: email control could not be driven"],
  });
  assert.match(prompt, /JOURNEY .*Validate contact/);
  assert.match(prompt, /enter an invalid email/);
  const interactionSection = prompt.slice(prompt.indexOf("INTERACTION CONTRACT"),
    prompt.indexOf("PROJECT KNOWLEDGE"));
  assert.doesNotMatch(interactionSection, /open booking/,
    "passing interaction steps must not be repeated in the repair contract");
  assert.ok(Buffer.byteLength(prompt) < 45_000, "targeted repair prompt must stay bounded");
});

test("retained candidate A: a capability method held as a reference is ADVISORY, not a rejection", () => {
  // `const cancel = wizard.cancel;` hands the method to a consumer. That is legitimate usage —
  // the same shape React's own store contract requires — so it must never fail a candidate.
  const tree = { ...CORRECT, "src/data/wizard.js": CORRECT["src/data/wizard.js"].replace("wizard.cancel();", "const cancel = wizard.cancel; void cancel;") };
  const result = verdict(tree);
  assert.equal(result.ok, true, result.problems.join("\n"));
  assert.equal(result.blocking.length, 0);

  // Bound and then genuinely dropped on the floor is still reported — as advice.
  const unused = { ...CORRECT, "src/data/wizard.js": CORRECT["src/data/wizard.js"].replace("wizard.cancel();", "") };
  const unusedResult = verdict(unused);
  assert.equal(unusedResult.ok, true, "shape findings never block a runnable candidate");
  assert.ok(unusedResult.advisory.some((row) => ["required_method_unbound", "required_method_uninvoked"].includes(row.code)));
  assert.ok(unusedResult.advisory.every((row) => row.severity === SEVERITY.ADVISORY));
});

test("retained candidate B: static interaction/review heuristics are ADVISORY; the browser decides", () => {
  const tree = { ...CORRECT,
    "src/components/book/BookFlow.jsx": CORRECT["src/components/book/BookFlow.jsx"]
      .replace('aria-label="date"', 'title="choose"').replace('aria-label="slot"', 'title="choose"')
      .replace('aria-label="party size"', 'title="choose"').replace(">Date</button>", ">Choose</button>")
      .replace(">Slot</button>", ">Choose</button>").replace(">Party</button>", ">Choose</button>"),
    "src/components/book/BookReview.jsx": CORRECT["src/components/book/BookReview.jsx"].replace("{draft.date} ", ""),
  };
  const result = verdict(tree);
  // The findings are still produced and still visible...
  assert.ok(result.advisory.some((row) => row.code === "interaction_control_undriveable"));
  assert.ok(result.advisory.some((row) => row.code === "review_data_flow_missing"));
  // ...and the candidate still runs, because only a real browser can prove driveability.
  assert.equal(result.ok, true, result.problems.join("\n"));
  assert.equal(result.correction.wholeCoreRequired, false);
});

test("retained candidate C: raw owned-entity persistence emits capability_owner_bypassed with span", () => {
  const tree = { ...CORRECT,
    "src/data/booking.js": `${CORRECT["src/data/booking.js"]}\nexport const bypass = (db, row) => db.entity("booking").create(row);`,
  };
  const result = verdict(tree);
  const issue = result.findings.find((row) => row.code === "capability_owner_bypassed");
  assert.equal(issue.module, "src/data/booking.js");
  assert.equal(issue.expectedOwner, "makeBookingSystem");
  assert.equal(issue.operation, "createBooking");
  assert.equal(issue.actualApi, 'db.entity("booking").create(...)');
  assert.ok(issue.line > 0);
  assert.ok(issue.span.end > issue.span.start);
  assert.deepEqual(result.correction.modules, ["src/data/booking.js"]);

  const extraHelper = verdict({ ...CORRECT,
    "src/data/bookingShortcut.js": `export const save = (db, row) => db.entity("booking").create(row);`,
  });
  assert.ok(extraHelper.findings.some((row) => row.code === "capability_owner_bypassed"
    && row.module === "src/data/bookingShortcut.js"));
  assert.deepEqual(extraHelper.correction.modules, ["src/data/bookingShortcut.js"]);
});

test("corrected retained booking modules pass every deterministic module contract", () => {
  const result = verdict(CORRECT);
  assert.equal(result.ok, true, result.problems.join("\n"));
  assert.ok(result.modules.every((row) => row.missingFacts.length === 0 && row.forbiddenFacts.length === 0));
});

test("corrected retained booking candidate passes a real Vite compilation", async () => {
  await ensureDeps(() => {});
  const tree = { ...fromScaffold(REACT_VITE), ...CORRECT,
    "src/App.jsx": `import { useState } from "react";
import { BookingFlow } from "./components/book/BookFlow";
import { BookingReview } from "./components/book/BookReview";
import { BookingConfirmation } from "./components/book/BookConfirmation";
import { BookingStatus } from "./components/book/BookStatus";
import * as bookingSystem from "./data/booking";
import { wizard } from "./data/wizard";
export default function App(){ const [draft,setDraft]=useState({date:"",slot:"",partySize:1,name:"",email:"",phone:""});
const booking={reference:"BK-1",status:"confirmed"}; void bookingSystem; void wizard;
return <><BookingFlow draft={draft} setDraft={setDraft} confirm={()=>{}} cancel={()=>{}}/><BookingReview draft={draft}/><BookingConfirmation booking={booking}/><BookingStatus booking={booking} onLookup={()=>{}}/></> }`,
  };
  const build = await buildTree(tree, "package14s-module-contract-generation", () => {});
  assert.equal(build.ok, true, build.stderr);
});

function genericCase({ entity, capability, factory, methods, dataPath, uiPath, field, role }) {
  const binding = { name: capability, version: "1.0.0", configuration: { entity }, requiredMethods: methods };
  const modulePlan = [
    { path: dataPath, role: `${role} operation adapter`, factory, stateOwnership: { owns: `${entity} records`, survivesReload: true, approvedPersistence: factory } },
    { path: uiPath, role: `${role} form`, stateOwnership: { owns: "ephemeral form state", survivesReload: false, durableStateOwner: factory } },
    { path: `src/components/${role}Review.jsx`, role: `${role} review summary`, stateOwnership: { owns: "presentation only", survivesReload: false, durableStateOwner: factory } },
  ];
  const interactionContract = { version: 1, flows: [
    { id: `${role}:input:${field}`, journeyId: role, kind: "input", responsibleModules: [uiPath], stateOwner: uiPath,
      valueWritten: field, reads: [], writes: [`${role}.draft.${field}`], control: {
        logicalField: field, roles: ["textbox"], inputTypes: ["text"], accessibleName: field,
        accessibleNames: [field], editable: true, stateOwner: uiPath, statePath: `${role}.draft.${field}`,
      } },
    { id: `${role}:review`, journeyId: role, kind: "review", responsibleModules: [`src/components/${role}Review.jsx`],
      stateOwner: `src/components/${role}Review.jsx`, valueWritten: null, reads: [`${role}.draft.${field}`], writes: [] },
  ] };
  const contract = { entities: [{ name: entity }], journeys: [{ id: role, steps: [] }] };
  const moduleContracts = buildModuleGenerationContracts({ contract, modulePlan, interactionContract, bindings: [binding] });
  const methodCalls = methods.map((method) => `store.${method}(${method === "create" || method === "update" ? "{}" : '"id"'});`).join(" ");
  const tree = {
    [dataPath]: `const store = ${factory}({ entity: ${JSON.stringify(entity)} }); ${methodCalls} export { store };`,
    [uiPath]: `export function Form({draft,setDraft}) { return <label>${field}<input name=${JSON.stringify(field)} aria-label=${JSON.stringify(field)} value={draft.${field}} onChange={(e)=>setDraft({...draft,${field}:e.target.value})}/></label> }`,
    [`src/components/${role}Review.jsx`]: `export function Review({draft}) { return <p>{draft.${field}}</p> }`,
  };
  return { contract, modulePlan, interactionContract, bindings: [binding], moduleContracts, tree };
}

test("generic contact, CRUD admin, checkout/order and account/settings contracts use the same enforcement", () => {
  const cases = [
    genericCase({ entity: "contactMessage", capability: "contact", factory: "makeContactForm", methods: ["submitContact"], dataPath: "src/data/contact.js", uiPath: "src/components/ContactForm.jsx", field: "email", role: "contact" }),
    genericCase({ entity: "task", capability: "crud", factory: "makeEntityStore", methods: ["create", "update"], dataPath: "src/data/tasks.js", uiPath: "src/components/TaskAdmin.jsx", field: "title", role: "admin" }),
    genericCase({ entity: "order", capability: "crud", factory: "makeEntityStore", methods: ["create"], dataPath: "src/data/orders.js", uiPath: "src/components/CheckoutForm.jsx", field: "address", role: "checkout" }),
    genericCase({ entity: "profile", capability: "crud", factory: "makeEntityStore", methods: ["update"], dataPath: "src/data/profile.js", uiPath: "src/components/SettingsForm.jsx", field: "displayName", role: "settings" }),
  ];
  for (const fixture of cases) {
    const result = validateModuleConformance(fixture.tree, fixture);
    assert.equal(result.ok, true, result.problems.join("\n"));
    const firstMethod = fixture.bindings[0].requiredMethods[0];
    // Genuinely never reached: not called, and not handed to anything either. (Merely holding
    // the reference — `store.create && (…)` — IS use, and is covered separately.)
    const uninvoked = { ...fixture.tree, [fixture.modulePlan[0].path]: fixture.tree[fixture.modulePlan[0].path]
      .replace(new RegExp(`store\\.${firstMethod}\\([^)]*\\);`), "") };
    // Shape differences are OBSERVED across every domain, and none of them blocks.
    assert.ok(validateModuleConformance(uninvoked, fixture).advisory
      .some((row) => ["required_method_unbound", "required_method_uninvoked"].includes(row.code)));
    assert.equal(validateModuleConformance(uninvoked, fixture).ok, true);
    const identityMissing = { ...fixture.tree, [fixture.modulePlan[1].path]: `export function Form({draft,setDraft}) { return <div><input value={draft.x} onChange={(e)=>setDraft({...draft,x:e.target.value})}/></div> }` };
    assert.ok(validateModuleConformance(identityMissing, fixture).advisory.some((row) => row.code === "interaction_control_undriveable"));
    assert.equal(validateModuleConformance(identityMissing, fixture).ok, true);
    const reviewMissing = { ...fixture.tree, [fixture.modulePlan[2].path]: "export function Review(){return <p>Review</p>}" };
    assert.ok(validateModuleConformance(reviewMissing, fixture).advisory.some((row) => row.code === "review_data_flow_missing"));

    // Honesty still blocks, in every domain: a raw write to a capability-owned entity bypasses
    // session and validation, and no amount of running the app makes that acceptable.
    const bypassTree = { ...fixture.tree, [fixture.modulePlan[0].path]: `${fixture.tree[fixture.modulePlan[0].path]}\ndb.entity(${JSON.stringify(fixture.contract.entities[0].name)}).create({});` };
    const bypass = validateModuleConformance(bypassTree, fixture);
    assert.equal(bypass.ok, false, "capability ownership must remain blocking");
    assert.ok(bypass.blocking.some((row) => row.code === "capability_owner_bypassed"));
  }
});

test("a BLOCKING finding scopes a correction to the offending module and retains the rest", () => {
  // Scoped correction is now driven by findings that genuinely block — here a raw write to a
  // capability-owned entity, which no amount of running the app makes acceptable.
  const failed = verdict({ ...CORRECT,
    "src/data/booking.js": `${CORRECT["src/data/booking.js"]}\nexport const bypass = (db, row) => db.entity("booking").create(row);` });
  assert.equal(failed.ok, false);
  const scope = moduleCorrectionScope(failed, CONTRACTS);
  assert.deepEqual(scope.allowedFiles, ["src/data/booking.js"]);
  assert.equal(validateModulePatchScope([{ replaceFile: "src/data/booking.js", content: "x" }], scope).ok, true);
  assert.equal(validateModulePatchScope([{ replaceFile: "src/App.jsx", content: "x" }], scope).ok, false);
  const prompt = renderPatchPrompt({ step: "correction", contract: { ...BOOKING, interactionContract: INTERACTIONS },
    tiers: tierContract(BOOKING), tree: { ...CORRECT }, modulePlan: PLAN, moduleContracts: CONTRACTS,
    moduleCorrectionScope: scope });
  assert.match(prompt, /MODULE-SCOPED CORE CORRECTION/);
  assert.match(prompt, /Allowed files: \[src\/data\/booking\.js\]/);
  assert.doesNotMatch(prompt, /BUILD THE WHOLE STEP/);
});

test("orchestrator corrects one offending module without replaying the whole core", async () => {
  const first = { ...CORRECT,
    "src/data/booking.js": `${CORRECT["src/data/booking.js"]}\nexport const bypass = (db, row) => db.entity("booking").create(row);` };
  const calls = [];
  const orchestrator = createOrchestrator({
    contractFn: async () => BOOKING,
    patchesFn: async (input) => {
      calls.push(input);
      if (calls.length === 1) return Object.entries(first).map(([path, content]) => ({ newFile: path, content }));
      return [{ replaceFile: "src/data/booking.js", content: CORRECT["src/data/booking.js"] }];
    },
    assetService: { async resolveIntents() { return { resolved: [] }; }, async assetManifestFor() { return []; } },
    baseTree: () => fromScaffold(REACT_VITE),
    compile: async (tree) => ({ ok: true, tree }),
    journeysFn: async () => ({ journeys: [{ id: "book", status: "pass", steps: [] }] }),
    maxCoreAttempts: 2,
  });
  const result = await orchestrator.runBuild({ owner: "owner", projectId: "project", request: "booking" });
  assert.equal(result.state, "green", JSON.stringify(result));
  assert.equal(calls.length, 2);
  assert.equal(calls[0].moduleCorrectionScope, null);
  assert.deepEqual(calls[1].moduleCorrectionScope.allowedFiles, ["src/data/booking.js"]);
  // The correction dispatches under its own step identity, so it draws on the correction
  // allowance and can never consume the one browser-informed repair slot.
  assert.equal(calls[1].step, "correction");
  assert.equal(calls[1].originalStep, "core");
  assert.equal(calls[1].tree["src/components/book/BookFlow.jsx"], first["src/components/book/BookFlow.jsx"]);
});
