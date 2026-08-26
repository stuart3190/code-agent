// Capability SAFETY lint: the checks that survive the blocking/advisory split.
//
// Method existence is now derived from the same AST provenance facts as every other capability
// question — the parallel regex authority is gone. Ownership lives in moduleContracts (derived
// from the contract's real bindings), and module size is a maintenance preference, not a defect.

import { test } from "node:test";
import assert from "node:assert/strict";
import { lintCapabilitySafety, FACTORY_METHODS } from "../../shell/server/lib/builderV2/capabilityLint.mjs";
import { capabilityBrief } from "../../shell/server/lib/builderV2/capabilityRegistry.mjs";
import { SEVERITY, severityOf } from "../../shell/server/lib/builderV2/validationSeverity.mjs";
import { makeContactForm, makeNewsletter } from "../../src/scaffolds/reactVite/lib/capabilities/forms.js";
import { makeBookingSystem } from "../../src/scaffolds/reactVite/lib/capabilities/booking.js";
import { makeEntityStore } from "../../src/scaffolds/reactVite/lib/capabilities/crud.js";
import { makeWizardMachine, makeWizardPersistence } from "../../src/scaffolds/reactVite/lib/capabilities/wizard.js";

const codes = (result) => result.findings.map((finding) => finding.code);

test("D1 lint — the pinned method table cannot drift from the REAL scaffold factories", () => {
  const methodsOf = (instance) => Object.keys(instance).filter((k) => typeof instance[k] === "function").sort();
  assert.deepEqual([...FACTORY_METHODS.makeContactForm].sort(), methodsOf(makeContactForm()));
  assert.deepEqual([...FACTORY_METHODS.makeNewsletter].sort(), methodsOf(makeNewsletter()));
  assert.deepEqual([...FACTORY_METHODS.makeBookingSystem].sort(), methodsOf(makeBookingSystem()));
  assert.deepEqual([...FACTORY_METHODS.makeEntityStore].sort(), methodsOf(makeEntityStore("x")));
  assert.deepEqual([...FACTORY_METHODS.makeWizardMachine].sort(), methodsOf(makeWizardMachine({ steps: ["a", "b"] })));
  assert.deepEqual([...FACTORY_METHODS.makeWizardPersistence].sort(),
    methodsOf(makeWizardPersistence({ key: "lint-drift", deps: {} })));
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
  const result = lintCapabilitySafety(tree);
  assert.equal(result.ok, false);
  assert.deepEqual(codes(result), ["capability_method_unknown"]);
  assert.match(result.problems[0], /has no submit\(\.\.\.\)/);
  assert.match(result.problems[0], /\[submitContact\]/, "the rejection carries the REAL interface");
  // A guaranteed runtime TypeError: statically provable, so it stays terminal.
  assert.equal(severityOf("capability_method_unknown"), SEVERITY.BLOCKING);
});

test("D1 lint — correct usage, enum property access and platform files all pass", () => {
  const ok = lintCapabilitySafety({
    "src/routes/BookPage.jsx": `
import { makeBookingSystem } from "../lib/capabilities";
const bookings = makeBookingSystem({});
async function go() {
  const r = await bookings.createBooking({});
  if (r.result === bookings.CREATE_RESULT) return; // property, not a call
  await bookings.cancelBooking("ref");
}
`,
    // Platform library files are never linted — they ARE the implementation.
    "src/lib/capabilities/forms.js": "const x = makeContactForm(); x.anything();",
  });
  assert.equal(ok.ok, true, JSON.stringify(ok.problems));

  const bad = lintCapabilitySafety({
    "src/routes/News.jsx": 'import { makeNewsletter } from "../lib/capabilities";\nconst n = makeNewsletter();\nn.signup("a@b.c");',
  });
  assert.equal(bad.ok, false);
  assert.match(bad.problems[0], /\[subscribe\]/);
});

test("D1 lint — rejects semantic fields that treat the provided value as a DOM event", () => {
  const invalid = lintCapabilitySafety({
    "src/components/SoftwareCatalogue.jsx": `
import { useSemanticField } from "../lib/capabilities/react.js";
export default function SoftwareCatalogue() {
  const search = useSemanticField({
    name: "searchQuery",
    value: "",
    onChange: (event) => updateSearch(event.target.value),
  });
  return <input {...search.inputProps} />;
}
`,
  });
  assert.deepEqual(codes(invalid), ["semantic_field_event_handler_invalid"]);
  assert.equal(invalid.findings[0].file, "src/components/SoftwareCatalogue.jsx");
  assert.equal(invalid.findings[0].field, "searchQuery");
  assert.match(invalid.problems[0], /passes the semantic value directly/);
  assert.equal(severityOf("semantic_field_event_handler_invalid"), SEVERITY.BLOCKING);

  const namedInvalid = lintCapabilitySafety({
    "src/components/SoftwareCatalogue.jsx": `
import { useSemanticField } from "../lib/capabilities/react.js";
function applySearch(event) { updateSearch(event.currentTarget.value); }
export default function SoftwareCatalogue() {
  const search = useSemanticField({ name: "searchQuery", value: "", onChange: applySearch });
  return <input {...search.inputProps} />;
}
`,
  });
  assert.deepEqual(codes(namedInvalid), ["semantic_field_event_handler_invalid"]);

  const valid = lintCapabilitySafety({
    "src/components/SoftwareCatalogue.jsx": `
import { useSemanticField } from "../lib/capabilities/react.js";
export default function SoftwareCatalogue() {
  const search = useSemanticField({ name: "searchQuery", value: "", onChange: (value) => updateSearch(value) });
  return <input {...search.inputProps} />;
}
`,
  });
  assert.equal(valid.ok, true, JSON.stringify(valid.problems));
});

test("D1 lint — the AST authority sees grammars the old regex could not", () => {
  // Destructured, aliased and cross-module usage all resolve to the same provenance, so an
  // unknown method is caught wherever it is written — and a VALID one is never falsely flagged.
  const ok = lintCapabilitySafety({
    "src/data/contact.js": `import { makeContactForm } from "../lib/capabilities";
export const { submitContact } = makeContactForm({ entity: "contactMessage" });`,
    "src/routes/Contact.jsx": `import { submitContact } from "../data/contact.js";
export default function Contact() { return <button onClick={() => submitContact({})}>Send</button>; }`,
  });
  assert.equal(ok.ok, true, JSON.stringify(ok.problems));

  const bad = lintCapabilitySafety({
    "src/data/contact.js": `import { makeContactForm } from "../lib/capabilities";
const form = makeContactForm({ entity: "contactMessage" });
export const send = (fields) => form.sendMessage(fields);`,
  });
  assert.equal(bad.ok, false);
  assert.match(bad.problems[0], /has no sendMessage/);
});

test("session establishment is a RUNTIME invariant, so generated source is not policed for it", () => {
  // Establishing the app-scoped visitor session is createSupabaseBackend's job now. A module
  // that mutates a non-capability-owned entity without calling ensureVisitorSession() works,
  // so it must not be rejected — policing it here rejected working code.
  const withoutSession = lintCapabilitySafety({
    "src/data/projects.js": `
import { db } from "../lib/backend/index.js";
export async function saveProject(fields) { return db.entity("project").create(fields); }
`,
  });
  assert.equal(withoutSession.ok, true, JSON.stringify(withoutSession.problems));
  assert.equal(codes(withoutSession).includes("sessionless_mutation"), false);
  assert.equal(severityOf("sessionless_mutation"), SEVERITY.ADVISORY,
    "the retired code carries no blocking authority");

  // Calling it explicitly is still harmless and still accepted.
  const withSession = lintCapabilitySafety({
    "src/data/projects.js": `
import { db } from "../lib/backend/index.js";
import { ensureVisitorSession } from "../lib/capabilities";
export async function saveProject(fields) {
  await ensureVisitorSession();
  return db.entity("project").create(fields);
}
`,
  });
  assert.equal(withSession.ok, true, JSON.stringify(withSession.problems));

  const okRead = lintCapabilitySafety({
    "src/data/lookup.js": 'import { db } from "../lib/backend/index.js";\nexport const listFaqs = () => db.entity("faq").list();',
  });
  assert.equal(okRead.ok, true, JSON.stringify(okRead.problems));
});

test("D1 lint — the capability brief carries the instance methods AND the React bindings", () => {
  const brief = capabilityBrief();
  assert.match(brief, /submitContact\(fields\)/);
  assert.match(brief, /NOT \.submit/);
  assert.match(brief, /subscribe\(email\)/);
  assert.match(brief, /createBooking, getBooking, listBookings, cancelBooking, remaining/);
  // Assembly, not invention: the wiring the model used to have to reinvent every build.
  assert.match(brief, /useCapabilityState/);
  assert.match(brief, /useSyncExternalStore/);
  assert.match(brief, /useSemanticField/);
  assert.match(brief, /onChange receives the semantic value directly, NEVER a DOM event/);
  assert.match(brief, /may be CALLED or PASSED as a reference/);
});

test("module size is ADVISORY: an oversized file is reported but never fails a runnable build", () => {
  const big = `export default function HomePage() {\n  return (<main>${"<p>section content here</p>".repeat(900)}</main>);\n}`;
  const oversized = lintCapabilitySafety({ "src/routes/HomePage.jsx": big });
  assert.deepEqual(codes(oversized), ["monolith_size"]);
  assert.match(oversized.problems[0], /preferred cap 5500/);
  // Size is a maintenance and cost preference — the browser decides whether the app works.
  assert.equal(severityOf("monolith_size"), SEVERITY.ADVISORY);

  const ok = lintCapabilitySafety({
    "src/routes/HomePage.jsx": "export default function HomePage() {\n  return null;\n}",
    "src/lib/capabilities/forms.js": big,
  });
  assert.equal(ok.ok, true, JSON.stringify(ok.problems));
});

test("the exact mounted scaffold placeholder blocks before compile and names its correction module", () => {
  const result = lintCapabilitySafety({
    "src/App.jsx": `import HomePage from "./routes/HomePage";
const ROUTES = { "/": HomePage };
export default function App() { const Page = ROUTES[location.pathname] || HomePage; return <Page />; }`,
    "src/routes/HomePage.jsx": `// One route, one file.
export default function HomePage() {
  return <main>{/* build here */}</main>;
}`,
    "src/components/CompleteFeature.jsx": "export default function CompleteFeature() { return <p>Complete</p>; }",
  });
  assert.deepEqual(codes(result), ["scaffold_placeholder_unreplaced"]);
  assert.equal(result.findings[0].module, "src/routes/HomePage.jsx");
  assert.match(result.problems[0], /reachable application UI/);
  assert.equal(severityOf("scaffold_placeholder_unreplaced"), SEVERITY.BLOCKING);

  const unused = lintCapabilitySafety({
    "src/App.jsx": "export default function App() { return <main>Custom root</main>; }",
    "src/routes/HomePage.jsx": "export default function HomePage() { return <main>{/* build here */}</main>; }",
  });
  assert.equal(codes(unused).includes("scaffold_placeholder_unreplaced"), false,
    "an unused scaffold file is not proof that the mounted application is blank");
});

test("V2 capability lint accepts the two Package 14R booking-page sizes", () => {
  for (const target of [4_261, 4_364]) {
    const base = "export default function HomePage() { return <main>Booking</main>; }\n/*";
    const suffix = "*/";
    const source = `${base}${"x".repeat(target * 4 - base.length - suffix.length)}${suffix}`;
    assert.equal(Math.ceil(source.length / 4), target);
    const result = lintCapabilitySafety({ "src/routes/HomePage.jsx": source });
    assert.equal(result.ok, true, `${target}: ${JSON.stringify(result.problems)}`);
  }
});
