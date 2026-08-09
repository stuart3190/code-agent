import { test } from "node:test";
import assert from "node:assert/strict";

import {
  FACTORY_METHODS,
  RECOGNIZED_CAPABILITY_FACTORIES,
  aggregateCapabilityFacts,
  lintCapabilityUsage,
  lintRequiredCapabilityBindings,
  lintRequiredModulePlan,
} from "../../shell/server/lib/builderV2/capabilityLint.mjs";
import { CAPABILITIES } from "../../shell/server/lib/builderV2/capabilityRegistry.mjs";

const FACTORY_CASES = Object.freeze({
  makeBookingSystem: { method: "createBooking", expression: 'makeBookingSystem({ entity: "booking" })' },
  makeContactForm: { method: "submitContact", expression: 'makeContactForm({ entity: "contactMessage" })' },
  makeEntityStore: { method: "create", expression: 'makeEntityStore("appointment")' },
  makeNewsletter: { method: "subscribe", expression: 'makeNewsletter({ entity: "newsletterSignup" })' },
  makeWizardMachine: { method: "getState", expression: 'makeWizardMachine({ id: "booking", steps: ["date", "review"] })' },
  makeWizardPersistence: { method: "load", expression: 'makeWizardPersistence({ key: "booking" })' },
});

const REQUIRED_BINDINGS = Object.freeze({
  makeBookingSystem: { name: "booking", configuration: { entity: "booking" }, requiredMethods: ["createBooking"] },
  makeContactForm: { name: "contact", configuration: { entity: "contactMessage" }, requiredMethods: ["submitContact"] },
  makeEntityStore: { name: "crud", requiredMethods: ["create"] },
  makeNewsletter: { name: "newsletter", configuration: { entity: "newsletterSignup" }, requiredMethods: ["subscribe"] },
  makeWizardMachine: { name: "wizard", configuration: { persistence: "platform" }, requiredMethods: ["getState"] },
});

const sourceFor = (factory, body) => {
  const item = FACTORY_CASES[factory];
  return `const capability = ${item.expression};\n${body(item.method)}`;
};

test("14S registry-derived factory inventory and method metadata are total", () => {
  const registryFactories = [...new Set(Object.values(CAPABILITIES)
    .flatMap((capability) => capability.interface || [])
    .filter((name) => /^make[A-Z]/.test(name)))].sort();
  assert.deepEqual(RECOGNIZED_CAPABILITY_FACTORIES, registryFactories);
  assert.deepEqual(Object.keys(FACTORY_CASES).sort(), registryFactories);
  assert.deepEqual(Object.keys(FACTORY_METHODS).sort(), registryFactories);
});

test("14S aggregation is total for every recognised required and auxiliary factory", () => {
  for (const factory of RECOGNIZED_CAPABILITY_FACTORIES) {
    const item = FACTORY_CASES[factory];
    const tree = { [`src/data/${factory}.js`]: sourceFor(factory, (method) => `capability.${method}();`) };
    const binding = REQUIRED_BINDINGS[factory];
    let facts;
    assert.doesNotThrow(() => { facts = aggregateCapabilityFacts(tree, binding ? [binding] : []); });
    const fact = facts.get(factory);
    assert.ok(fact, factory);
    assert.equal(fact.factory, factory);
    assert.equal(fact.required, Boolean(binding));
    assert.equal(fact.instances.length, 1);
    assert.equal(fact.instances[0].module, `src/data/${factory}.js`);
    assert.ok(fact.bound.has(item.method));
    assert.ok(fact.invoked.has(item.method));
    assert.equal(fact.bindings.length, 1);
    assert.equal(fact.invocations.length, 1);
  }
});

test("14S every factory supports direct, destructured, exported, aliased and cross-module provenance", () => {
  for (const factory of RECOGNIZED_CAPABILITY_FACTORIES) {
    const { method, expression } = FACTORY_CASES[factory];
    const shapes = [
      { tree: { "src/data/capability.js": `const capability = ${expression}; capability.${method}();` }, local: "capability" },
      { tree: { "src/data/capability.js": `const capability = ${expression}; const { ${method} } = capability; ${method}();` }, local: method },
      { tree: { "src/data/capability.js": `const capability = ${expression}; export const { ${method} } = capability; ${method}();` }, local: method },
      { tree: { "src/data/capability.js": `const capability = ${expression}; const { ${method}: invoke } = capability; invoke();` }, local: "invoke" },
      { tree: {
        "src/data/capability.js": `const capability = ${expression}; export const { ${method} } = capability;`,
        "src/routes/Page.jsx": `import { ${method} as invoke } from "../data/capability.js"; invoke();`,
      }, local: "invoke" },
    ];
    for (const { tree, local } of shapes) {
      const fact = aggregateCapabilityFacts(tree).get(factory);
      assert.equal(fact.instances.length, 1, `${factory}:${local}:instance`);
      assert.ok(fact.bound.has(method), `${factory}:${local}:bound`);
      assert.ok(fact.invoked.has(method), `${factory}:${local}:invoked`);
      assert.ok(fact.bindings.some((row) => row.local === local), `${factory}:${local}:binding provenance`);
    }
  }
});

test("14S bound-but-unused and matching unproven names never satisfy required invocation", () => {
  for (const [factory, binding] of Object.entries(REQUIRED_BINDINGS)) {
    const { method, expression } = FACTORY_CASES[factory];
    const rejected = [
      `const capability = ${expression}; const { ${method} } = capability;`,
      `const capability = ${expression}; function ${method}() {} ${method}();`,
      `const capability = ${expression}; const unrelated = { ${method}() {} }; const { ${method}: invoke } = unrelated; invoke();`,
      `const unrelated = { ${method}() {} }; const { ${method} } = unrelated; ${method}();`,
    ];
    for (const source of rejected) {
      const result = lintRequiredCapabilityBindings({ "src/data/capability.js": source }, [binding]);
      assert.equal(result.ok, false, `${factory}: ${source}`);
    }
  }
});

test("14S missing required factories/methods fail while duplicate recognised instances remain tracked", () => {
  const missingFactory = lintRequiredCapabilityBindings({ "src/data/x.js": "export const x = 1;" },
    [REQUIRED_BINDINGS.makeBookingSystem]);
  assert.equal(missingFactory.ok, false);
  assert.match(missingFactory.problems.join("\n"), /required capability booking is missing/);

  const missingMethod = lintRequiredCapabilityBindings({
    "src/data/x.js": 'const capability = makeBookingSystem({ entity: "booking" }); capability.getBooking("x");',
  }, [REQUIRED_BINDINGS.makeBookingSystem]);
  assert.equal(missingMethod.ok, false);
  assert.match(missingMethod.problems.join("\n"), /not bound to createBooking/);

  const duplicateTree = {
    "src/data/a.js": 'const a = makeBookingSystem({ entity: "booking" }); a.createBooking({});',
    "src/data/b.js": 'const b = makeBookingSystem({ entity: "booking" }); b.createBooking({});',
  };
  const duplicateFacts = aggregateCapabilityFacts(duplicateTree, [REQUIRED_BINDINGS.makeBookingSystem]);
  assert.equal(duplicateFacts.get("makeBookingSystem").instances.length, 2);
  assert.equal(lintRequiredCapabilityBindings(duplicateTree, [REQUIRED_BINDINGS.makeBookingSystem]).ok, true);
});

test("14S formerly crashing booking plus entity-store combination is fully tracked", () => {
  const tree = {
    "src/data/bookingSystem.js": `
      const bookingCapability = makeBookingSystem({ entity: "booking" });
      const bookingStore = makeEntityStore("bookingAudit");
      export const { createBooking } = bookingCapability;
      export const { create: createAudit } = bookingStore;
      export async function create(input) { const result = await createBooking(input); await createAudit(result); return result; }
    `,
  };
  const facts = aggregateCapabilityFacts(tree, [REQUIRED_BINDINGS.makeBookingSystem]);
  assert.equal(facts.get("makeBookingSystem").required, true);
  assert.equal(facts.get("makeBookingSystem").instances.length, 1);
  assert.ok(facts.get("makeBookingSystem").invoked.has("createBooking"));
  assert.equal(facts.get("makeEntityStore").required, false);
  assert.equal(facts.get("makeEntityStore").instances.length, 1);
  assert.ok(facts.get("makeEntityStore").invoked.has("create"));
  assert.equal(lintRequiredCapabilityBindings(tree, [REQUIRED_BINDINGS.makeBookingSystem]).ok, true);
});

test("14S full booking factory combination aggregates across generated modules", () => {
  const tree = {
    "src/data/bookingSystem.js": `
      const booking = makeBookingSystem({ entity: "booking" });
      const store = makeEntityStore("availability");
      export const { createBooking } = booking;
      export const { list } = store;
    `,
    "src/data/bookingWizard.js": `
      const wizard = makeWizardMachine({ id: "booking", steps: ["date", "review"] });
      const contact = makeContactForm({ entity: "contactMessage" });
      const durable = makeWizardPersistence({ key: "booking" });
      export const { getState } = wizard;
      export const { submitContact } = contact;
      export const { load } = durable;
    `,
    "src/components/booking/BookingFlow.jsx": `
      import { createBooking, list } from "../../data/bookingSystem.js";
      import { getState, submitContact, load } from "../../data/bookingWizard.js";
      export async function run() { list(); getState(); await load(); await submitContact({}); return createBooking({}); }
    `,
  };
  const bindings = [
    REQUIRED_BINDINGS.makeBookingSystem,
    REQUIRED_BINDINGS.makeWizardMachine,
    REQUIRED_BINDINGS.makeContactForm,
  ];
  const facts = aggregateCapabilityFacts(tree, bindings);
  for (const factory of ["makeBookingSystem", "makeWizardMachine", "makeContactForm", "makeEntityStore", "makeWizardPersistence"]) {
    assert.equal(facts.get(factory).instances.length, 1, factory);
    assert.ok(facts.get(factory).invocations.length >= 1, factory);
  }
  assert.equal(facts.get("makeEntityStore").required, false);
  assert.equal(facts.get("makeWizardPersistence").required, false);
  assert.equal(lintRequiredCapabilityBindings(tree, bindings).ok, true);
});

test("14S retained live adapter/module shape reaches the deterministic module-plan stage", () => {
  const tree = {
    "src/data/bookingSystem.js": `
      const bookingCapability = makeBookingSystem({ entity: "booking" });
      const bookingStore = makeEntityStore("bookingAvailability");
      export const { createBooking, cancelBooking, getBooking } = bookingCapability;
      export const { list: listAvailability } = bookingStore;
      export async function reserve(input) { await listAvailability(); return createBooking(input); }
      export const cancel = (reference) => cancelBooking(reference);
      export const recover = (reference) => getBooking(reference);
    `,
    "src/data/bookingWizard.js": `
      const bookingWizard = makeWizardMachine({ id: "booking", steps: ["date", "slot", "party", "details", "review"] });
      const contactCapability = makeContactForm({ entity: "contactMessage" });
      export const { getState, subscribe, restore, select, next, confirm, cancel } = bookingWizard;
      export const { submitContact } = contactCapability;
    `,
    "src/components/booking/BookingFlow.jsx": `
      import { reserve, cancel as cancelBooking, recover } from "../../data/bookingSystem.js";
      import { getState, subscribe, restore, select, next, confirm, cancel, submitContact } from "../../data/bookingWizard.js";
      export async function run(input) {
        getState(); subscribe(() => {}); await restore(); await select("date", input.date); await next();
        await submitContact(input.details); await confirm(); await reserve(input); await recover(input.reference);
        await cancel(); return cancelBooking(input.reference);
      }
    `,
    "src/components/booking/BookingReview.jsx": "export const BookingReview = () => null;",
    "src/components/booking/BookingConfirmation.jsx": "export const BookingConfirmation = () => null;",
    "src/components/booking/BookingStatus.jsx": "export const BookingStatus = () => null;",
  };
  const bindings = [
    { name: "booking", configuration: { entity: "booking" }, requiredMethods: ["createBooking", "cancelBooking", "getBooking"] },
    { name: "wizard", configuration: { persistence: "platform" }, requiredMethods: ["getState", "subscribe", "restore", "select", "next", "confirm", "cancel"] },
    { name: "contact", configuration: { entity: "contactMessage" }, requiredMethods: ["submitContact"] },
  ];
  const plan = [
    { path: "src/data/bookingSystem.js", role: "booking persistence adapter", factory: "makeBookingSystem" },
    { path: "src/data/bookingWizard.js", role: "durable wizard state adapter", factory: "makeWizardMachine" },
    { path: "src/components/booking/BookingFlow.jsx", role: "step navigation and flow composition" },
    { path: "src/components/booking/BookingReview.jsx", role: "review presentation" },
    { path: "src/components/booking/BookingConfirmation.jsx", role: "confirmation and reference presentation" },
    { path: "src/components/booking/BookingStatus.jsx", role: "restored and cancelled booking presentation" },
  ];
  assert.equal(lintCapabilityUsage(tree).ok, true);
  assert.equal(lintRequiredCapabilityBindings(tree, bindings).ok, true);
  assert.equal(lintRequiredModulePlan(tree, plan).ok, true);
});

test("14S unknown factories cannot borrow recognised provenance or satisfy a contract", () => {
  const tree = {
    "src/data/fake.js": "const fake = makeUnknownBookingSystem(); const { createBooking } = fake; createBooking({});",
  };
  const facts = aggregateCapabilityFacts(tree, [REQUIRED_BINDINGS.makeBookingSystem]);
  assert.equal(facts.size, RECOGNIZED_CAPABILITY_FACTORIES.length);
  assert.equal(facts.get("makeBookingSystem").instances.length, 0);
  const result = lintRequiredCapabilityBindings(tree, [REQUIRED_BINDINGS.makeBookingSystem]);
  assert.equal(result.ok, false);
  assert.match(result.problems.join("\n"), /required capability booking is missing/);
});
