// D1 capability-usage lint (WP-9, from live run 3): a call to a method a capability does
// not export is caught statically at patch-apply time, with the real interface taught back.

import { test } from "node:test";
import assert from "node:assert/strict";
import { lintCapabilityUsage, FACTORY_METHODS } from "../../shell/server/lib/builderV2/capabilityLint.mjs";
import { capabilityBrief } from "../../shell/server/lib/builderV2/capabilityRegistry.mjs";
import { makeContactForm, makeNewsletter } from "../../src/scaffolds/reactVite/lib/capabilities/forms.js";
import { makeBookingSystem } from "../../src/scaffolds/reactVite/lib/capabilities/booking.js";
import { makeEntityStore } from "../../src/scaffolds/reactVite/lib/capabilities/crud.js";

test("D1 lint — the pinned method table cannot drift from the REAL scaffold factories", () => {
  const methodsOf = (instance) => Object.keys(instance).filter((k) => typeof instance[k] === "function").sort();
  assert.deepEqual([...FACTORY_METHODS.makeContactForm].sort(), methodsOf(makeContactForm()));
  assert.deepEqual([...FACTORY_METHODS.makeNewsletter].sort(), methodsOf(makeNewsletter()));
  assert.deepEqual([...FACTORY_METHODS.makeBookingSystem].sort(), methodsOf(makeBookingSystem()));
  assert.deepEqual([...FACTORY_METHODS.makeEntityStore].sort(), methodsOf(makeEntityStore("x")));
});

test("D1 lint — catches live run 3's exact defect and teaches the real interface", () => {
  // Verbatim shape from the blocked build: useMemo-wrapped binding, .submit call.
  const tree = {
    "src/routes/HomePage.jsx": `
import { useMemo } from "react";
import { makeContactForm } from "../lib/capabilities";
export default function HomePage() {
  const contactForm = useMemo(() => makeContactForm({ entity: "contactMessage" }), []);
  async function handleSubmit() { await contactForm.submit({ name: "x" }); }
  return null;
}
`,
  };
  const result = lintCapabilityUsage(tree);
  assert.equal(result.ok, false);
  assert.match(result.problems[0], /contactForm\.submit\(\.\.\.\) does not exist/);
  assert.match(result.problems[0], /\[submitContact\]/, "the rejection carries the REAL interface");
});

test("D1 lint — correct usage, enum property access and platform files all pass", () => {
  const ok = lintCapabilityUsage({
    "src/routes/BookPage.jsx": `
import { makeBookingSystem } from "../lib/capabilities";
const bookings = makeBookingSystem({});
async function go() {
  const r = await bookings.createBooking({});
  if (r.result === bookings.CREATE_RESULT) return; // property, not a call — but calls to enums would flag
  await bookings.cancelBooking("ref");
}
`,
    // Platform library files are never linted — they ARE the implementation.
    "src/lib/capabilities/forms.js": "const x = makeContactForm(); x.anything();",
  });
  assert.equal(ok.ok, true, JSON.stringify(ok.problems));

  const bad = lintCapabilityUsage({
    "src/routes/News.jsx": 'import { makeNewsletter } from "../lib/capabilities";\nconst n = makeNewsletter();\nn.signup("a@b.c");',
  });
  assert.equal(bad.ok, false);
  assert.match(bad.problems[0], /\[subscribe\]/);
});

test("D1 lint — run 4's bespoke data layer is rejected: owned entities go through their capability", () => {
  // Verbatim shape from the blocked run: a data module writing contactMessage raw, sessionless.
  const bad = lintCapabilityUsage({
    "src/data/contactMessages.js": `
import { db } from "../lib/backend/index.js";
const store = db.entity("contactMessage");
export async function createContactMessage(fields) {
  return store.create({ ...fields, createdAt: new Date().toISOString() });
}
`,
  });
  assert.equal(bad.ok, false);
  assert.ok(bad.problems.some((p) => /capability-owned entity/.test(p) && /submitContact/.test(p)),
    JSON.stringify(bad.problems));
  assert.ok(bad.problems.some((p) => /NO session/.test(p) && /401/.test(p)), "the generic sessionless rule fires too");

  // A custom entity mutated WITH session management is legitimate.
  const okCustom = lintCapabilityUsage({
    "src/data/projects.js": `
import { db } from "../lib/backend/index.js";
import { ensureVisitorSession } from "../lib/capabilities";
export async function saveProject(fields) {
  await ensureVisitorSession();
  return db.entity("project").create(fields);
}
`,
  });
  assert.equal(okCustom.ok, true, JSON.stringify(okCustom.problems));

  // Reads without mutation don't need the session rule.
  const okRead = lintCapabilityUsage({
    "src/data/lookup.js": 'import { db } from "../lib/backend/index.js";\nexport const listFaqs = () => db.entity("faq").list();',
  });
  assert.equal(okRead.ok, true, JSON.stringify(okRead.problems));
});

test("D1 lint — the capability brief now carries the instance methods the model must call", () => {
  const brief = capabilityBrief();
  assert.match(brief, /submitContact\(fields\)/);
  assert.match(brief, /NOT \.submit/);
  assert.match(brief, /subscribe\(email\)/);
  assert.match(brief, /createBooking, getBooking, listBookings, cancelBooking, remaining/);
});

test("monolith cap — an oversized generated file is rejected with the split taught", () => {
  const big = `export default function HomePage() {\n  return (<main>${"<p>section content here</p>".repeat(500)}</main>);\n}`;
  const bad = lintCapabilityUsage({ "src/routes/HomePage.jsx": big });
  assert.equal(bad.ok, false);
  assert.match(bad.problems[0], /tokens \(cap 3000\)/);
  assert.match(bad.problems[0], /split sections into/);

  // Platform lib files and reasonable files are untouched.
  const ok = lintCapabilityUsage({
    "src/routes/HomePage.jsx": "export default function HomePage() {\n  return null;\n}",
    "src/lib/capabilities/forms.js": big,
  });
  assert.equal(ok.ok, true, JSON.stringify(ok.problems));
});
