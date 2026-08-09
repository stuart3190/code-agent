import { test } from "node:test";
import assert from "node:assert/strict";

import { lintRequiredCapabilityBindings } from "../../shell/server/lib/builderV2/capabilityLint.mjs";

const bookingBinding = [{
  name: "booking",
  configuration: { entity: "booking" },
  requiredMethods: ["createBooking"],
}];

const lintBooking = (source) => lintRequiredCapabilityBindings({ "src/data/booking.js": source }, bookingBinding);

test("14S capability grammar accepts direct and provenance-backed destructured calls", () => {
  const cases = [
    `const bookingCapability = makeBookingSystem({ entity: "booking" });
     bookingCapability.createBooking({});`,
    `const bookingCapability = makeBookingSystem({ entity: "booking" });
     const { createBooking } = bookingCapability; createBooking({});`,
    `const bookingCapability = makeBookingSystem({ entity: "booking" });
     export const { createBooking } = bookingCapability; createBooking({});`,
    `const bookingCapability = makeBookingSystem({ entity: "booking" });
     const { createBooking: create } = bookingCapability; create({});`,
    `const { createBooking } = makeBookingSystem({ entity: "booking" }); createBooking({});`,
    `export const { createBooking } = makeBookingSystem({ entity: "booking" }); createBooking({});`,
    `const { createBooking: create } = makeBookingSystem({ entity: "booking" }); create({});`,
    `makeBookingSystem({ entity: "booking" }).createBooking({});`,
  ];
  for (const source of cases) {
    const result = lintBooking(source);
    assert.equal(result.ok, true, result.problems.join("; "));
  }
});

test("14S capability grammar rejects names and aliases without capability provenance", () => {
  const cases = [
    `const bookingCapability = makeBookingSystem({ entity: "booking" });
     function createBooking() {} createBooking({});`,
    `const bookingCapability = makeBookingSystem({ entity: "booking" });
     const unrelated = { createBooking() {} }; const { createBooking } = unrelated; createBooking({});`,
    `const bookingCapability = makeBookingSystem({ entity: "booking" });
     bookingCapability.getBooking("BK-1");`,
    `const bookingCapability = makeBookingSystem;
     const { createBooking } = bookingCapability; createBooking({});`,
    `const bookingCapability = makeBookingSystem({ entity: "booking" });
     const { createBooking } = bookingCapability;`,
    `const bookingCapability = makeBookingSystem({ entity: "booking" });
     const unrelated = { createBooking() {} }; const { createBooking: create } = unrelated; create({});`,
  ];
  for (const source of cases) {
    const result = lintBooking(source);
    assert.equal(result.ok, false, source);
  }
  // Bound but neither called nor handed to a consumer. (Passing it as a reference — e.g.
  // useSyncExternalStore(store.subscribe, store.getState) — now counts as use; see
  // builder-v2-capability-semantics.test.mjs.)
  assert.match(lintBooking(cases[4]).problems.join("\n"), /binds createBooking.*neither invokes nor passes/);
});

test("14S exact live-candidate destructuring survives export/import while retaining provenance", () => {
  const tree = {
    "src/data/bookingSystem.js": `
      const bookingCapability = makeBookingSystem({ entity: "booking" });
      export const { createBooking, cancelBooking, getBooking } = bookingCapability;
      export async function persist(input) { return createBooking(input); }
      export async function remove(reference) { return cancelBooking(reference); }
      export async function recover(reference) { return getBooking(reference); }
    `,
    "src/data/bookingWizard.js": `
      const bookingWizard = makeWizardMachine({ id: "booking", steps: ["date", "slot", "review", "confirm"] });
      export const { getState, subscribe, restore, select, next, confirm, cancel } = bookingWizard;
    `,
    "src/data/contact.js": `
      const contactForm = makeContactForm({ entity: "contactMessage" });
      export const { submitContact } = contactForm;
    `,
    "src/components/booking/BookingFlow.jsx": `
      import { getState, subscribe, restore, select, next, confirm, cancel } from "../../data/bookingWizard.js";
      import { submitContact as submitGuest } from "../../data/contact.js";
      export function runFlow() {
        getState(); subscribe(() => {}); restore(); select("date", "2026-08-20"); next(); confirm(); cancel();
        submitGuest({ name: "Ada" });
      }
    `,
  };
  const bindings = [
    { name: "booking", configuration: { entity: "booking" },
      requiredMethods: ["createBooking", "cancelBooking", "getBooking"] },
    { name: "wizard", configuration: { persistence: "platform" },
      requiredMethods: ["getState", "subscribe", "restore", "select", "next", "confirm", "cancel"] },
    { name: "contact", configuration: { entity: "contactMessage" }, requiredMethods: ["submitContact"] },
  ];
  const result = lintRequiredCapabilityBindings(tree, bindings);
  assert.equal(result.ok, true, result.problems.join("; "));
});

test("14S imported aliases from unrelated modules cannot borrow capability provenance", () => {
  const tree = {
    "src/data/booking.js": `const bookingCapability = makeBookingSystem({ entity: "booking" });`,
    "src/data/fake.js": `export function createBooking() {}`,
    "src/routes/HomePage.jsx": `import { createBooking as create } from "../data/fake.js"; create({});`,
  };
  const result = lintRequiredCapabilityBindings(tree, bookingBinding);
  assert.equal(result.ok, false);
  assert.match(result.problems.join("\n"), /not bound to createBooking/);
});
