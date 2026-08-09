import { test } from "node:test";
import assert from "node:assert/strict";

import { parse } from "@babel/parser";

import { buildTree, ensureDeps } from "../../harness/workspace.mjs";
import { fromScaffold } from "../../src/engine/fileTree.mjs";
import { REACT_VITE } from "../../src/scaffolds/reactVite.mjs";
import {
  lintCapabilityUsage,
  lintRequiredCapabilityBindings,
  lintRequiredModulePlan,
} from "../../shell/server/lib/builderV2/capabilityLint.mjs";
import { applyPatches } from "../../shell/server/lib/builderV2/patchEngine.mjs";

const BINDINGS = Object.freeze([
  { name: "booking", configuration: { entity: "booking" },
    requiredMethods: ["createBooking", "cancelBooking", "getBooking"] },
  { name: "wizard", configuration: { persistence: "platform" },
    requiredMethods: ["getState", "subscribe", "restore", "select", "next", "confirm", "cancel"] },
  { name: "contact", configuration: { entity: "contactMessage" }, requiredMethods: ["submitContact"] },
]);

const PLAN = Object.freeze([
  { path: "src/data/bookingSystem.js", role: "booking persistence adapter", factory: "makeBookingSystem" },
  { path: "src/data/bookingWizard.js", role: "durable wizard state adapter", factory: "makeWizardMachine" },
  { path: "src/components/booking/BookingFlow.jsx", role: "step navigation and flow composition" },
  { path: "src/components/booking/BookingReview.jsx", role: "review presentation" },
  { path: "src/components/booking/BookingConfirmation.jsx", role: "confirmation and reference presentation" },
  { path: "src/components/booking/BookingStatus.jsx", role: "restored and cancelled booking presentation" },
]);

const CONTRACT = Object.freeze({
  journeys: [
    { id: "reserve", title: "Reserve a table", steps: [{ action: "choose date slot party details", expect: "review" }] },
    { id: "confirm", title: "Confirm booking", steps: [{ action: "submit booking", expect: "reference" }] },
    { id: "restore", title: "Restore booking", steps: [{ action: "reload booking", expect: "persisted state" }] },
    { id: "cancel", title: "Cancel booking", steps: [{ action: "cancel reference", expect: "cancelled state" }] },
  ],
});

const bookingSystem = `
import { makeBookingSystem, makeEntityStore } from "../lib/capabilities/index.js";

const bookingCapability = makeBookingSystem({ entity: "booking" });
const availabilityStore = makeEntityStore("bookingAvailability");

export const { createBooking, cancelBooking, getBooking } = bookingCapability;
export const { list: listAvailability } = availabilityStore;

export async function reserveBooking(input) {
  await listAvailability();
  return createBooking(input);
}
export function recoverBooking(reference) { return getBooking(reference); }
export function cancelExistingBooking(reference) { return cancelBooking(reference); }
`;

// This deliberately reproduces the live candidate's direct factory-result contact binding.
const bookingWizard = `
import { makeWizardMachine, makeContactForm } from "../lib/capabilities/index.js";

const bookingWizard = makeWizardMachine({
  id: "booking",
  steps: ["date", "slot", "party", "details", "review", "confirmation"],
});

export const { getState, subscribe, restore, select, next, confirm, cancel } = bookingWizard;
export const { submitContact } =
  makeContactForm({ entity: "contactMessage" });
`;

const flowSource = ({ corrected }) => `
import React, { useEffect, useState } from "react";
import { reserveBooking, recoverBooking, cancelExistingBooking } from "../../data/bookingSystem.js";
import { getState, subscribe, restore, select, next, confirm, cancel, submitContact } from "../../data/bookingWizard.js";

export default function BookingFlow() {
  const [message, setMessage] = useState("Choose a booking date");
  useEffect(() => {
    let active = true;
    restore().then(() => { if (active) setMessage("Booking state restored"); });
    ${corrected ? "getState(); const unsubscribe = subscribe(() => {});" : ""}
    return () => { active = false; ${corrected ? "unsubscribe();" : ""} };
  }, []);

  async function completeBooking() {
    await select("date", "2026-08-12");
    await next();
    await submitContact({ name: "Taylor", email: "taylor@example.test" });
    await confirm();
    const booking = await reserveBooking({ date: "2026-08-12", slot: "18:00", party: 2 });
    await recoverBooking(booking?.reference || "fixture-reference");
    setMessage("Booking confirmed");
  }

  async function cancelBooking() {
    await cancel();
    await cancelExistingBooking("fixture-reference");
    setMessage("Booking cancelled");
  }

  return <section><h1>Book a table</h1><p>{message}</p>
    <button onClick={completeBooking}>Confirm booking</button>
    <button onClick={cancelBooking}>Cancel booking</button></section>;
}
`;

const homePage = `
import BookingFlow from "../components/booking/BookingFlow.jsx";
import BookingReview from "../components/booking/BookingReview.jsx";
import BookingConfirmation from "../components/booking/BookingConfirmation.jsx";
import BookingStatus from "../components/booking/BookingStatus.jsx";

export default function HomePage() {
  return <main><BookingFlow /><BookingReview /><BookingConfirmation /><BookingStatus /></main>;
}
`;

const appShell = `
import HomePage from "./routes/HomePage.jsx";
export default function App() { return <HomePage />; }
`;

function candidatePatches({ corrected }) {
  return [
    { replaceFile: "src/App.jsx", content: appShell },
    { replaceFile: "src/routes/HomePage.jsx", content: homePage },
    { newFile: "src/data/bookingSystem.js", content: bookingSystem },
    { newFile: "src/data/bookingWizard.js", content: bookingWizard },
    { newFile: "src/components/booking/BookingFlow.jsx", content: flowSource({ corrected }) },
    { newFile: "src/components/booking/BookingReview.jsx",
      content: "export default function BookingReview(){ return <section aria-label=\"Booking review\">Review</section>; }" },
    { newFile: "src/components/booking/BookingConfirmation.jsx",
      content: "export default function BookingConfirmation(){ return <section aria-label=\"Booking confirmation\">Confirmation</section>; }" },
    { newFile: "src/components/booking/BookingStatus.jsx",
      content: "export default function BookingStatus(){ return <section aria-label=\"Booking status\">Status</section>; }" },
  ];
}

function parseCandidateSources(patches) {
  for (const patch of patches) {
    const file = patch.newFile || patch.replaceFile;
    if (!/\.(?:js|jsx|ts|tsx)$/.test(file)) continue;
    assert.doesNotThrow(() => parse(patch.content, {
      sourceType: "module",
      plugins: file.endsWith("x") ? ["jsx"] : [],
    }), `AST parse: ${file}`);
  }
}

function applyCandidate({ corrected }) {
  const patches = candidatePatches({ corrected });
  parseCandidateSources(patches);
  const result = applyPatches(fromScaffold(REACT_VITE), patches, { contract: CONTRACT });
  assert.equal(result.modularityFailed, false, JSON.stringify(result.rejected));
  assert.deepEqual(result.rejected, []);
  assert.equal(result.applied.length, patches.length);
  return result.tree;
}

test("14S retained direct-factory candidate keeps genuine unused wizard violations and compiles", async () => {
  const tree = applyCandidate({ corrected: false });
  assert.equal(lintCapabilityUsage(tree).ok, true);
  assert.equal(lintRequiredModulePlan(tree, PLAN).ok, true);

  const lint = lintRequiredCapabilityBindings(tree, BINDINGS);
  assert.equal(lint.ok, false);
  assert.equal(lint.issues.some((issue) => issue.capability === "contact"), false,
    "direct makeContactForm destructuring is not falsely reported missing");
  assert.deepEqual(lint.issues
    .filter((issue) => issue.code === "required_method_uninvoked")
    .map((issue) => `${issue.capability}:${issue.method}`).sort(), ["wizard:getState", "wizard:subscribe"]);

  await ensureDeps(() => {});
  const compiled = await buildTree(tree, "package14s_retained_direct_factory", () => {});
  assert.equal(compiled.ok, true, compiled.stderr);
});

test("14S corrected retained candidate passes every deterministic gate and compiles", async () => {
  const tree = applyCandidate({ corrected: true });
  assert.equal(lintCapabilityUsage(tree).ok, true);
  const lint = lintRequiredCapabilityBindings(tree, BINDINGS);
  assert.equal(lint.ok, true, lint.problems.join("; "));
  assert.equal(lintRequiredModulePlan(tree, PLAN).ok, true);

  await ensureDeps(() => {});
  const compiled = await buildTree(tree, "package14s_corrected_direct_factory", () => {});
  assert.equal(compiled.ok, true, compiled.stderr);
});
