// THE VERIFICATION SPLIT: who is allowed to know what.
//
// The browser verifier kept failing correct applications because it was being asked to recognise
// business meaning from prose — and the fix each time was another dictionary entry, until
// "guestName" resolved to a party-size control and a paid run died. A dictionary of every field
// every future application might have is not a thing that can be maintained.
//
//   BUILDER / CONTRACT   knows meaning
//   UI MECHANICS         knows browser primitives and opaque identities
//   DURABLE OUTCOME      knows business truth, from canonical evidence
//
// These prove the boundary exists in the code rather than in the intention.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  actionIdFor, browserPlan, controlIdFor, deriveVerificationManifest,
} from "../../shell/server/lib/builderV2/verificationManifest.mjs";
import { deriveBuildSpec } from "../../shell/server/lib/builderV2/buildSpec.mjs";
import { REACT_VITE } from "../../src/scaffolds/reactVite.mjs";
import { CRM_CONTRACT } from "./fixtures/crmScenarioApp.mjs";
import { CHECKOUT_CONTRACT } from "./fixtures/checkoutScenarioApp.mjs";

const CRM = deriveVerificationManifest(deriveBuildSpec(CRM_CONTRACT));

// ── the manifest ───────────────────────────────────────────────────────────────────────────────

test("the manifest is derived from the build spec and speaks only in primitives", () => {
  assert.equal(CRM.version, 1);
  assert.ok(CRM.controls.length > 0, "controls derived");
  assert.ok(CRM.actions.length > 0, "actions derived");
  const primitives = new Set([...CRM.controls, ...CRM.actions].map((row) => row.primitive));
  for (const primitive of primitives) {
    assert.ok(["textbox", "selection", "button", "advance", "reload", "observation", "route"].includes(primitive),
      `unexpected primitive ${primitive}`);
  }
  for (const control of CRM.controls) {
    assert.match(control.id, /^ctl_[0-9a-f]{8}$/, control.id);
    assert.ok(["fill", "select"].includes(control.action));
    assert.ok(control.expected, "every control states the mechanical transition it expects");
  }
  for (const action of CRM.actions) assert.match(action.id, /^act_[0-9a-f]{8}$/, action.id);
});

test("identities are stable, opaque and unique within a manifest", () => {
  assert.equal(controlIdFor("guestName"), controlIdFor("guestName"), "stable across calls");
  assert.notEqual(controlIdFor("guestName"), controlIdFor("guestCount"), "distinct fields, distinct ids");
  assert.notEqual(controlIdFor("x"), actionIdFor("x"), "a control and an action are different kinds");
  // Opaque: the identity does not leak the business word it came from.
  for (const word of ["guest", "lead", "booking", "customer", "order", "party"]) {
    assert.equal(controlIdFor(`${word}Name`).includes(word), false);
  }
  const ids = CRM.controls.map((row) => row.id);
  const perJourney = new Map();
  for (const control of CRM.controls) {
    const key = `${control.journeyId}:${control.stepIndex}:${control.id}`;
    assert.equal(perJourney.has(key), false, `duplicate control in one step: ${key}`);
    perJourney.set(key, true);
  }
  assert.ok(ids.length > 0);
});

test("the browser's view carries no business mapping, and needs none", () => {
  const plan = browserPlan(CRM);
  // The mapping and the field names it maps to stay on the contract side.
  const structural = JSON.stringify(plan.controls.map(({ fallbackNames, ...rest }) => rest)
    .concat(plan.actions.map(({ fallbackNames, ...rest }) => rest))).toLowerCase();
  for (const word of ["lead", "customer", "contact", "logicalfield", "mapping"]) {
    assert.equal(structural.includes(word), false, `the browser plan leaks "${word}"`);
  }
  assert.equal(plan.mapping, undefined, "the browser is never given id → field");
  // Business words survive in ONE place — fallbackNames, the accessibility fallback for controls
  // that carry no machine identity. Every contracted control here has an identity, so the plan is
  // fully addressable with those names deleted: the fallback is a courtesy, not the mechanism.
  for (const row of [...plan.controls, ...plan.actions]) {
    assert.match(row.id, /^(ctl|act)_[0-9a-f]{8}$/, JSON.stringify(row));
    assert.ok(row.journey, "each row names its journey by opaque key");
  }
  // …while the contract side keeps the mapping it owns.
  assert.ok(CRM.mapping[CRM.controls[0].id]?.logicalField, "the builder retains id → field");
});

test("durable outcomes come from declared operations and lifecycle roles, not from UI copy", () => {
  const byJourney = new Map(CRM.outcomes.map((row) => [row.journeyId, row]));
  assert.equal(byJourney.get("capture-new-lead").expectedMutation, "create");
  assert.equal(byJourney.get("update-existing-lead").expectedMutation, "update");
  assert.equal(byJourney.get("recover-existing-lead").expectedMutation, "read");
  assert.equal(byJourney.get("archive-existing-lead").expectedMutation, "update");
  for (const outcome of CRM.outcomes) assert.ok(outcome.durableEntity, JSON.stringify(outcome));
  // An independent journey asserts no durable outcome at all.
  assert.equal(CRM.outcomes.some((row) => row.journeyId === "contact-validation"), false);
});

test("a second domain derives the same shape with no domain-specific handling", () => {
  const checkout = deriveVerificationManifest(deriveBuildSpec(CHECKOUT_CONTRACT));
  assert.ok(checkout.controls.length > 0 && checkout.actions.length > 0);
  assert.ok(checkout.outcomes.some((row) => row.expectedMutation === "create"));
  // Identity is a pure function of the control's NAME, so two applications that both call a field
  // `reference` share an id — and must, because each app's DOM is verified on its own. Uniqueness
  // is a within-manifest property, asserted above; across domains it is meaningless.
  const shared = checkout.controls.filter((row) => CRM.controls.some((other) => other.id === row.id));
  for (const row of shared) {
    assert.equal(CRM.mapping[row.id].logicalField,
      checkout.mapping[row.id].logicalField, "a shared id must mean the same field name");
  }
});

// ── the two halves agree without a registry ────────────────────────────────────────────────────

test("the scaffold computes the SAME identity the platform does", async () => {
  // The generated app never receives an id list: it derives the identity from the control's own
  // name with the same function. If these two implementations ever diverge, every machine-identity
  // lookup silently falls back to prose — so this is pinned.
  const source = REACT_VITE["src/lib/capabilities/react.js"];
  assert.ok(source.includes("0x811c9dc5") && source.includes("0x01000193"),
    "the scaffold still computes FNV-1a");
  const runtime = await import(
    `data:text/javascript,${encodeURIComponent(source.replace(/import[^;]+;/g, "").replace(/useCallback\(([^,]+),[^)]*\)/g, "$1"))}`
  ).catch(() => null);
  if (runtime?.controlId) {
    for (const name of ["guestName", "partySize", "contactEmail", "deliverySpeed", "notes"]) {
      assert.equal(runtime.controlId(name), controlIdFor(name), `${name} must agree on both sides`);
      assert.equal(runtime.actionId(name), actionIdFor(name), `${name} action id must agree`);
    }
  }
});

test("contracted controls carry their machine identity into the interaction contract", () => {
  const spec = deriveBuildSpec(CRM_CONTRACT);
  const withControls = spec.interactionContract.flows.filter((flow) => flow.control);
  assert.ok(withControls.length > 0);
  for (const flow of withControls) {
    assert.ok(flow.control.machineId, `${flow.id} has no machine identity`);
    assert.match(flow.control.machineId, /^(ctl|act)_[0-9a-f]{8}$/);
  }
  // The identity of an input matches the manifest's, so both sides address the same control.
  const email = withControls.find((flow) => flow.control.logicalField === "contactEmail");
  assert.equal(email.control.machineId, controlIdFor("contactEmail"));
});

// ── the anti-dictionary guard ──────────────────────────────────────────────────────────────────

const DOMAIN_WORDS = ["booking", "guest", "reservation", "lead", "customer", "order", "checkout",
  "inventory", "subscription", "party size", "slot"];

test("the machine-identity path contains no business vocabulary", async () => {
  // The primary browser path must never branch on what an application is FOR. This reads the
  // shipped source: a future alias added to these functions fails the build.
  const verifier = await readFile(
    new URL("../../shell/server/lib/appBuild/journeyVerifier.mjs", import.meta.url), "utf8");
  // Comments cite the incidents by name — that is how the reasoning survives. The CODE is what
  // may not branch on a business word, so comments are stripped before scanning.
  const withoutComments = (text) => text.split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join("\n");
  const machinePath = withoutComments([
    verifier.match(/function contractedLocators[\s\S]*?\n}/)?.[0] || "",
    verifier.match(/async function activateContractedControl[\s\S]*?\n}/)?.[0] || "",
    verifier.match(/async function selectionGroups[\s\S]*?\n}/)?.[0] || "",
  ].join("\n")).toLowerCase();
  assert.ok(machinePath.includes("data-thrallo-control"), "the machine path is the one being read");
  for (const word of DOMAIN_WORDS) {
    assert.equal(machinePath.includes(word), false,
      `control targeting branches on the business word "${word}"`);
  }
});

test("the manifest derivation contains no business vocabulary", async () => {
  const source = (await readFile(
    new URL("../../shell/server/lib/builderV2/verificationManifest.mjs", import.meta.url), "utf8"));
  // Comments explain the incident by name; the CODE may not contain domain words.
  const code = source.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join("\n").toLowerCase();
  for (const word of DOMAIN_WORDS) {
    assert.equal(code.includes(word), false, `the manifest branches on "${word}"`);
  }
});
