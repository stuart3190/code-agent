// A CONTRACTED CONTROL THAT NOTHING CAN ADDRESS.
//
// The browser's mechanics probe addresses controls by `data-thrallo-control`. A hand-wired control
// carries none, so the probe cannot see it, and the defect surfaces as a step failure part-way
// through a paid run — run #8 died on step 2 of 8 that way. This lint asks the question after emit
// and before the app is served, offline, for nothing.
//
// The DANGEROUS half of this lint is not the detection, it is the restraint. The preferred binding
// is a spread — `<input {...field.inputProps} />` — and no Thrallo browser fixture contains a
// literal `data-thrallo-control` in its JSX. A lint that looked for the attribute as text would
// fail every correctly-built application. Most of these tests exist to hold that line.

import { test } from "node:test";
import assert from "node:assert/strict";

import { BINDING, lintControlBindings } from "../../shell/server/lib/builderV2/bindingLint.mjs";
import { controlIdFor } from "../../shell/server/lib/builderV2/verificationManifest.mjs";
import { deriveBuildSpec } from "../../shell/server/lib/builderV2/buildSpec.mjs";

const CONTRACT = {
  summary: "A booking application for a supper club", projectType: "booking", version: 1,
  auth: { required: false }, routes: [{ path: "/", name: "Booking" }],
  entities: [{ name: "booking", fields: [
    { name: "eventDate", type: "string" }, { name: "guestName", type: "string" }] }],
  operations: [],
  journeys: [{ id: "book", title: "A guest books a seat", priority: "primary", steps: [
    { action: "open the booking page", target: "/", expect: "the booking page is visible" },
    { action: "select an available date", target: "date picker", operates: ["eventDate"],
      primitive: "selection", expect: "the selected date is highlighted" },
    { action: "enter the guest name", target: "form", operates: ["guestName"],
      expect: "the guest name is shown" },
  ] }],
  acceptance: [
    { id: "a1", statement: "a submitted booking is readable after a page reload", kind: "persistence" },
    { id: "a2", statement: "the booking page renders its available dates", kind: "render" },
    { id: "a3", statement: "an invalid contact detail is rejected before submission", kind: "validation" }],
  states: [], deferred: [], imageIntents: [], integrations: [],
};

const SPEC = deriveBuildSpec(CONTRACT);
const lint = (tree) => lintControlBindings(tree, { interactionContract: SPEC.interactionContract });
const failing = (result) => result.findings.filter((row) => row.fails);

// ── the preferred path: everything bound through spreads ───────────────────────────────────────

test("an app that binds everything through the capability spreads PASSES", () => {
  const tree = { "src/components/Flow.jsx": `
    import { useSemanticField, useSemanticSelection } from "../lib/capabilities/react.js";
    export function Flow() {
      const dates = useSemanticSelection({ name: "eventDate", label: "Date" });
      const name = useSemanticField({ name: "guestName", label: "Guest name" });
      return <main>
        <div {...dates.groupProps}>
          {["a", "b"].map((value) => <button key={value} {...dates.optionProps(value)}>{value}</button>)}
        </div>
        <label {...name.labelProps} />
        <input {...name.inputProps} />
      </main>;
    }` };
  const result = lint(tree);
  assert.equal(result.ok, true, `spread-bound controls were failed: ${JSON.stringify(failing(result), null, 1)}`);
  // …and they were recognised as BOUND, not merely tolerated as unknown.
  const bound = result.elements.filter((row) => row.binding === BINDING.BINDING);
  // The group container is not itself interactive (a role="group" div is not operated), so the
  // resolved bindings are the option button and the input.
  assert.ok(bound.length >= 2, `only ${bound.length} element(s) resolved to a binding`);
});

test("a literal data-thrallo-control PASSES", () => {
  // The ids come from the platform identity function, never copied by hand: a test that hardcodes
  // a hash proves only that the hash was typed correctly.
  const tree = { "src/components/Flow.jsx": `
    export function Flow() {
      return <main>
        <div role="group" data-thrallo-control="${controlIdFor("eventDate")}" aria-label="Date">
          <button role="option" data-thrallo-control="${controlIdFor("eventDate")}" data-thrallo-option="a">A</button>
        </div>
        <input aria-label="Guest name" data-thrallo-control="${controlIdFor("guestName")}" />
      </main>;
    }` };
  const result = lint(tree);
  assert.equal(result.ok, true, JSON.stringify(failing(result)));
});

// ── the run #8 shape ───────────────────────────────────────────────────────────────────────────

test("LIVE-SHAPED REGRESSION — a hand-wired chooser matching a contracted key FAILS and is named", () => {
  const tree = {
    "src/components/DatePicker.jsx": `
      export function DatePicker({ onPick }) {
        return <div role="group" id="eventDate" aria-label="Event date">
          {["2026-02-14", "2026-02-21"].map((value) => (
            <button key={value} role="option" onClick={() => onPick(value)}>{value}</button>
          ))}
        </div>;
      }`,
    "src/components/Contact.jsx": `
      import { useSemanticField } from "../lib/capabilities/react.js";
      export function Contact() {
        const name = useSemanticField({ name: "guestName", label: "Guest name" });
        return <><label {...name.labelProps} /><input {...name.inputProps} /></>;
      }`,
  };
  const result = lint(tree);
  assert.equal(result.ok, false, "a hand-wired contracted chooser passed the lint");
  const flagged = failing(result);
  assert.equal(flagged.length, 1, JSON.stringify(flagged.map((row) => row.code)));
  const finding = flagged[0];
  assert.equal(finding.code, "contract_control_unbound");
  assert.equal(finding.control, "eventDate");
  assert.ok(finding.inferredKey, "no inferred semantic key reported");
  // file, line and element — the structured list the report promises.
  assert.equal(finding.elements[0].file, "src/components/DatePicker.jsx");
  assert.ok(Number.isInteger(finding.elements[0].line), "no line reported");
  assert.match(finding.elements[0].element, /<div role="group">|<button role="option">/);
  // The bound field beside it is NOT dragged into the failure.
  assert.equal(flagged.some((row) => row.control === "guestName"), false);
});

// ── restraint ──────────────────────────────────────────────────────────────────────────────────

test("a non-interactive element with no handler is not flagged at all", () => {
  const tree = { "src/components/Copy.jsx": `
    export function Copy() {
      return <main><section><h1>Supper club</h1><p>Tonight we serve fire-roasted things.</p>
        <div className="card"><span>Not a control</span></div></section></main>;
    }` };
  const result = lint(tree);
  assert.deepEqual(result.elements, [], `non-interactive elements were collected: ${JSON.stringify(result.elements)}`);
});

test("uncontracted chrome is REPORTED and does not fail the build", () => {
  const tree = {
    "src/components/Nav.jsx": `
      export function Nav({ onToggle }) {
        return <nav><button onClick={onToggle} aria-label="Open the menu">Menu</button></nav>;
      }`,
    "src/components/Flow.jsx": `
      import { useSemanticField, useSemanticSelection } from "../lib/capabilities/react.js";
      export function Flow() {
        const dates = useSemanticSelection({ name: "eventDate", label: "Date" });
        const name = useSemanticField({ name: "guestName", label: "Guest name" });
        return <main><div {...dates.groupProps}>
          <button {...dates.optionProps("a")}>A</button></div>
          <input {...name.inputProps} /></main>;
      }`,
  };
  const result = lint(tree);
  assert.equal(result.ok, true, `chrome failed the build: ${JSON.stringify(failing(result))}`);
  const reported = result.findings.filter((row) => row.code === "uncontracted_control_unbound");
  assert.equal(reported.length, 1, JSON.stringify(result.findings));
  assert.equal(reported[0].fails, false);
  assert.match(reported[0].file, /Nav\.jsx/);
});

test("a wrapper forwarding props is UNRESOLVED, and never fails", () => {
  // The element is bound inside the wrapper, or by whoever passes the props. This file cannot
  // know, and guessing is the false positive that made the old static finding unusable.
  const tree = { "src/components/Field.jsx": `
    export function Field(props) { return <input {...props} />; }
    export function Chooser({ groupProps, options }) {
      return <div {...groupProps} id="eventDate">{options.map((o) => <button key={o} role="option">{o}</button>)}</div>;
    }
    export function GuestName(bound) { return <input {...bound} id="guestName" aria-label="Guest name" />; }` };
  const result = lint(tree);
  const unresolved = result.elements.filter((row) => row.binding === BINDING.UNRESOLVED);
  assert.ok(unresolved.length >= 2, `spreads were not treated as unresolved: ${JSON.stringify(
    result.elements.map((row) => [row.element, row.binding]))}`);
  assert.equal(failing(result).some((row) => row.code === "contract_control_unbound"), false,
    "an unresolvable spread was condemned as unbound");
});

// ── coverage ───────────────────────────────────────────────────────────────────────────────────

test("a contracted control absent from the tree entirely FAILS as contract_control_missing", () => {
  const tree = { "src/components/Flow.jsx": `
    import { useSemanticField } from "../lib/capabilities/react.js";
    export function Flow() {
      const name = useSemanticField({ name: "guestName", label: "Guest name" });
      return <main><label {...name.labelProps} /><input {...name.inputProps} /></main>;
    }` };
  const result = lint(tree);
  assert.equal(result.ok, false);
  const missing = failing(result).filter((row) => row.code === "contract_control_missing");
  assert.equal(missing.length, 1, JSON.stringify(failing(result)));
  assert.equal(missing[0].control, "eventDate");
  assert.notEqual(missing[0].code, "contract_control_unbound", "missing and unbound must stay distinct");
});

test("the platform's own capability sources are never linted", () => {
  const tree = { "src/lib/capabilities/react.js": `
    export function useSemanticField() { return { inputProps: {} }; }
    export const Raw = () => <input id="eventDate" />;` };
  assert.deepEqual(lint(tree).elements, []);
});

// ── the honesty requirement ────────────────────────────────────────────────────────────────────

test("the result states its residual gap, and the gap is real", () => {
  const result = lint({ "src/components/Flow.jsx": "export const Flow = () => null;" });
  assert.match(result.residualGap, /textual/i);
  assert.match(result.residualGap, /not a proof/i);

  // The gap, demonstrated rather than asserted: a chooser labelled divergently from its contracted
  // key is hand-wired, and this lint does not catch it. It is reported as uncontracted chrome —
  // and `eventDate` is then reported MISSING, which is the honest description of what was found.
  const divergent = { "src/components/Flow.jsx": `
    import { useSemanticField } from "../lib/capabilities/react.js";
    export function Flow({ onPick }) {
      const name = useSemanticField({ name: "guestName", label: "Guest name" });
      return <main>
        <div role="group" aria-label="Choose your evening">
          <button role="option" onClick={() => onPick(1)}>An evening</button>
        </div>
        <input {...name.inputProps} />
      </main>;
    }` };
  const outcome = lint(divergent);
  assert.equal(failing(outcome).some((row) => row.code === "contract_control_unbound"), false,
    "the divergently-labelled chooser was matched after all — the documented gap is wrong");
});

test("a control bound DYNAMICALLY is never reported missing", () => {
  // Measured, not imagined: `opaqueIdentityApp` — a fixture that passes in a real browser — binds
  // six fields in a loop, so the factory is called with a variable and the elements carry no static
  // identity whatsoever. Before this case was handled, the lint failed that app with SEVEN
  // contract_control_missing findings. A build must never fail because a correct app used a map.
  const tree = { "src/components/Flow.jsx": `
    import { useSemanticField } from "../lib/capabilities/react.js";
    const NAMES = ["eventDate", "guestName"];
    export function Flow() {
      const fields = Object.fromEntries(NAMES.map((name) => [name, useSemanticField({ name })]));
      return <main>{NAMES.map((name) => <input key={name} {...fields[name].inputProps} />)}</main>;
    }` };
  const result = lint(tree);
  assert.equal(result.ok, true, `dynamic binding failed the build: ${JSON.stringify(failing(result))}`);
  const undetermined = result.findings.filter((row) => row.code === "contract_control_coverage_undetermined");
  assert.ok(undetermined.length >= 1, "the undetermined coverage was not reported at all");
  assert.equal(undetermined.every((row) => row.fails === false), true);
  assert.match(undetermined[0].message, /dynamically/);
});

// ── a quiet result is not a proof ──────────────────────────────────────────────────────────────

test("a tree the walker cannot fully read is marked coverage-UNDETERMINED", () => {
  // Three of the four ways a correct app binds a control — a wrapper, a store, a factory called
  // with a variable — are outside a static reader's reach. Where any is present, "nothing was
  // found unbound" describes what could be SEEN, not what the app does, and the report must say so
  // at tree level. Otherwise a green lint reads as coverage, and the only way to reach zero false
  // rejections would be to stop firing wherever indirection appears.
  const dynamic = { "src/components/Flow.jsx": `
    import { useSemanticField } from "../lib/capabilities/react.js";
    const NAMES = ["eventDate", "guestName"];
    export function Flow() {
      const fields = Object.fromEntries(NAMES.map((name) => [name, useSemanticField({ name })]));
      return <main>{NAMES.map((name) => <input key={name} {...fields[name].inputProps} />)}</main>;
    }` };
  const result = lint(dynamic);
  assert.equal(result.ok, true);
  assert.equal(result.coverageUndetermined, true, "a dynamically-bound tree was reported as determined");
  assert.match(result.undeterminedReasons.join(" "), /dynamically/);
  // …and the residual gap still ships alongside it.
  assert.match(result.residualGap, /not a proof/i);
});

test("an unfollowable wrapper also makes coverage undetermined", () => {
  const wrapped = { "src/components/Field.jsx": `
    export function Field(props) { return <input {...props} aria-label="Guest name" />; }
    export function Chooser({ groupProps }) {
      return <div {...groupProps} id="eventDate"><button role="option">A</button></div>;
    }` };
  const result = lint(wrapped);
  assert.equal(result.coverageUndetermined, true);
  assert.match(result.undeterminedReasons.join(" "), /cannot follow/i);
});

test("a fully readable tree is NOT marked undetermined", () => {
  const readable = { "src/components/Flow.jsx": `
    import { useSemanticField, useSemanticSelection } from "../lib/capabilities/react.js";
    export function Flow() {
      const dates = useSemanticSelection({ name: "eventDate", label: "Date" });
      const name = useSemanticField({ name: "guestName", label: "Guest name" });
      return <main><div {...dates.groupProps}><button {...dates.optionProps("a")}>A</button></div>
        <input {...name.inputProps} /></main>;
    }` };
  const result = lint(readable);
  assert.equal(result.ok, true);
  assert.equal(result.coverageUndetermined, false,
    `a readable tree was marked undetermined: ${JSON.stringify(result.undeterminedReasons)}`);
});
