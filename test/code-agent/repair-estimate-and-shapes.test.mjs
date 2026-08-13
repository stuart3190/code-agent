// Deterministic persistence transforms from the final V1 qualification remain shared by V2.
// These are the two real shapes that originally exposed gaps:
//      src/App.jsx:378          useState(() => { try { return JSON.parse(localStorage.getIte…
//      src/data/reservations.js:46   window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));

import { test } from "node:test";
import assert from "node:assert/strict";
import { transformModule, transformPersistence, usesBrowserStorage } from "../../shell/server/lib/appBuild/persistenceTransform.mjs";
import { honestyScan } from "../../shell/server/lib/appBuild/honestyScan.mjs";

// The two real shapes, verbatim.

// Reconstructed around the exact logged lines. Shape A: the lazy try/catch initialiser and its
// paired cache writes, inside a component.
const APP_JSX = `import React, { useState } from "react";
import { createReservation } from "./data/reservations.js";

const CONFIRMATION_KEY = "berry-brook-confirmation";

export default function App() {
  const [confirmation, setConfirmation] = useState(() => { try { return JSON.parse(localStorage.getItem(CONFIRMATION_KEY)) || null; } catch { return null; } });

  const submit = async (form) => {
    const stored = await createReservation(form);
    setConfirmation(stored);
    localStorage.setItem(CONFIRMATION_KEY, JSON.stringify(stored));
  };

  const dismiss = () => {
    setConfirmation(null);
    localStorage.removeItem(CONFIRMATION_KEY);
  };

  return <main><h1>Book a slot</h1>{confirmation && <p>Your reference is {confirmation.reference}</p>}</main>;
}
`;

// Shape B: the whole-value save helper, its paired read, and append/filter callers.
const RESERVATIONS_JS = `const STORAGE_KEY = "berry-brook-reservations";

function loadReservations() {
  return JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "[]");
}

function saveReservations(value) {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
}

export async function listReservations() {
  return loadReservations();
}

export async function createReservation(input) {
  const all = loadReservations();
  const record = { ...input, reference: "BB-" + Math.random().toString(36).slice(2, 7).toUpperCase() };
  saveReservations([...all, record]);
  return record;
}

export async function cancelReservation(reference) {
  saveReservations(loadReservations().filter((r) => r.reference !== reference));
}
`;

test("SHAPE A — the lazy try/catch initialiser is neutralised without making the component async", () => {
  const result = transformModule(APP_JSX, { entity: "reservation", path: "src/App.jsx" });
  assert.equal(result.ok, true, `declined: ${result.declined.join("; ")}`);
  assert.equal(usesBrowserStorage(result.source), false, "no browser storage may remain");

  // The initial state becomes the fallback — first render is identical.
  assert.match(result.source, /useState\(null\)/);
  assert.ok(result.applied.includes("lazy_init_try"));
  // The paired cache writes are gone; the live setConfirmation state flow is untouched.
  assert.ok(!/setItem|removeItem/.test(result.source));
  assert.match(result.source, /setConfirmation\(stored\)/, "in-session behaviour preserved");
  assert.match(result.source, /setConfirmation\(null\)/);
  // Never an async component, never a substituted store.
  assert.ok(!/async function App/.test(result.source));
  assert.ok(!/sessionStorage|indexedDB/.test(result.source));
  assert.match(result.source, /export default function App/, "exports unchanged");
});

test("SHAPE B — the whole-value save helper maps through its callers, then disappears", () => {
  const result = transformModule(RESERVATIONS_JS, { entity: "reservation", path: "src/data/reservations.js" });
  assert.equal(result.ok, true, `declined: ${result.declined.join("; ")}`);
  assert.equal(usesBrowserStorage(result.source), false);

  // The append caller became a create of the record.
  assert.match(result.source, /await db\.entity\("reservation"\)\.create\(record\)/);
  // The filter caller became list-and-delete-matching — by the filtered property, via row id.
  assert.match(result.source, /if \(r\.reference === reference\) await db\.entity\("reservation"\)\.delete\(r\.id\)/);
  // The read became the real list.
  assert.match(result.source, /await db\.entity\("reservation"\)\.list\(\)/);
  // The helper and its key constant are gone — no orphaned storage code.
  assert.ok(!/saveReservations|STORAGE_KEY/.test(result.source));
  // Exported names and callers survive.
  for (const name of ["listReservations", "createReservation", "cancelReservation"]) {
    assert.ok(result.source.includes(`function ${name}`), `${name} must remain exported`);
  }
});

test("SHAPE B — a caller outside the provable forms still declines loudly", () => {
  const withOddCaller = RESERVATIONS_JS + `
export function replaceEverything(list) {
  saveReservations(list);
}
`;
  const result = transformModule(withOddCaller, { entity: "reservation", path: "src/data/reservations.js" });
  assert.equal(result.ok, false, "an unprovable whole-list write must not be guessed at");
  assert.ok(result.declined.length > 0);
  assert.equal(result.source, withOddCaller, "and nothing is half-applied");
});

test("REPLAY f4c1c00c — the deterministic transform clears all honesty findings", () => {
  const contract = {
    entities: [{ name: "reservation", fields: [{ name: "slotId", type: "string", required: true }] }],
    journeys: [{ id: "book", title: "A visitor books a picking slot", priority: "primary" }],
  };
  const tree = { "src/App.jsx": APP_JSX, "src/data/reservations.js": RESERVATIONS_JS };

  const before = honestyScan(tree, { contract });
  assert.equal(before.ok, false);
  assert.ok(before.findings.length >= 6, `the run recorded six findings; the replay has ${before.findings.length}`);

  const fixed = transformPersistence(tree, { findings: before.findings, contract });
  assert.equal(fixed.declined.length, 0, fixed.declined.map((d) => `${d.file}: ${d.reasons[0]}`).join("; "));

  const after = honestyScan(fixed.tree, { contract });
  assert.deepEqual(after.findings, [], "remaining honesty findings: zero");

  assert.equal(fixed.fixed.length, 2, "both shared persistence modules are transformed locally");
});
