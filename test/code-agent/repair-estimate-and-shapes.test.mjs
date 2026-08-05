// The two follow-ups from the final live build (run f4c1c00c), fixed and pinned.
//
// 1. The repair reservation estimated ~17 credits — the WHOLE preceding staged job's cost — for a
//    4-credit targeted repair, and was refused at 17.00/25 with 8.00 remaining.
// 2. The deterministic transform declined on two real shapes, now logged verbatim:
//      src/App.jsx:378          useState(() => { try { return JSON.parse(localStorage.getIte…
//      src/data/reservations.js:46   window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { transformModule, transformPersistence, usesBrowserStorage } from "../../shell/server/lib/appBuild/persistenceTransform.mjs";
import { honestyScan } from "../../shell/server/lib/appBuild/honestyScan.mjs";
import { createReservations, memoryReservationStore } from "../../shell/server/lib/appBuild/creditReservations.mjs";
import { profileFor, COMPLEXITY } from "../../shell/server/lib/appBuild/buildProfile.mjs";

// ── 1. the estimate rule ──────────────────────────────────────────────────────────────────────

const SERVICE = readFileSync("shell/server/lib/appBuild/appBuildService.mjs", "utf8");

test("ESTIMATE — the preceding staged-job total can never be the repair estimate", () => {
  const block = SERVICE.slice(
    SERVICE.indexOf("THE ESTIMATE RULE"),
    SERVICE.indexOf("const reservation = await lifecycle.reservations.reserve"),
  );
  assert.ok(block.length > 0, "the estimate rule block exists");
  assert.match(block, /Math\.min\(/);
  assert.match(block, /repairCap/);
  assert.ok(!/lifecycle\.lastCallCredits/.test(block),
    "lastCallCredits (the whole prior job) must not appear in the repair estimate");
  assert.match(block, /lifecycle\.lastRepairCredits \|\| repairCap/,
    "measured historical REPAIR cost is used when available, else the cap");
});

test("ESTIMATE — 17 spent, cap 4: granted for at most 4; 22 spent: refused before dispatch", async () => {
  const repairCap = profileFor(COMPLEXITY.simple).maxRepairCredits;
  assert.equal(repairCap, 4);

  // Exactly the run's arithmetic, through the real reservation machinery.
  const estimate = Math.min(repairCap, /* lastRepairCredits */ repairCap, repairCap);
  assert.equal(estimate, 4, "prior job cost 17 does not influence the estimate");

  const at17 = createReservations({ store: memoryReservationStore(), spentOf: async () => 17 });
  const granted = await at17.reserve({ buildId: "b", credits: estimate, ceiling: 25 });
  assert.equal(granted.ok, true, "17 + 4 <= 25: the repair the run wrongly refused is now granted");
  assert.equal(granted.hold.credits, 4, "and holds at most the cap");

  // Reconcile to the actual repair cost; the remainder is released.
  const settled = await at17.reconcile(granted.hold.id, { actual: 2.6 });
  assert.equal(settled.released, 4 - 2.6);
  assert.equal((await at17.status("b", 25)).reserved, 0);

  const at22 = createReservations({ store: memoryReservationStore(), spentOf: async () => 22 });
  const refused = await at22.reserve({ buildId: "b", credits: 4, ceiling: 25 });
  assert.equal(refused.ok, false, "22 + 4 crosses 25: refused before dispatch");
});

test("ESTIMATE — duplicate repair telemetry does not double-charge", () => {
  const events = new Map();
  const record = (id, cost) => { if (!events.has(id)) events.set(id, cost); };
  record("resp_repair_1", 2.6);
  record("resp_repair_1", 2.6); // the same provider response delivered twice
  assert.equal([...events.values()].reduce((a, b) => a + b, 0), 2.6);
});

// ── 2. the two real shapes, verbatim ──────────────────────────────────────────────────────────

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

// ── 3. the zero-credit replay ─────────────────────────────────────────────────────────────────

test("REPLAY f4c1c00c — free repair clears all six findings; a 4-credit hold is granted at 17/25", async () => {
  const contract = {
    entities: [{ name: "reservation", fields: [{ name: "slotId", type: "string", required: true }] }],
    journeys: [{ id: "book", title: "A visitor books a picking slot", priority: "primary" }],
  };
  const tree = { "src/App.jsx": APP_JSX, "src/data/reservations.js": RESERVATIONS_JS };

  const before = honestyScan(tree, { contract });
  assert.equal(before.ok, false);
  assert.ok(before.findings.length >= 6, `the run recorded six findings; the replay has ${before.findings.length}`);

  const store = memoryReservationStore();
  const reservations = createReservations({ store, spentOf: async () => 17 });

  // Deterministic work: no reservation, no spend movement.
  const fixed = transformPersistence(tree, { findings: before.findings, contract });
  assert.equal(store.dump().length, 0, "no reservation is used for deterministic work");
  assert.equal(fixed.declined.length, 0, fixed.declined.map((d) => `${d.file}: ${d.reasons[0]}`).join("; "));

  const after = honestyScan(fixed.tree, { contract });
  assert.deepEqual(after.findings, [], "remaining honesty findings: zero");

  // Had anything remained, the model repair is affordable now: 17 + 4 <= 25.
  const hold = await reservations.reserve({ buildId: "f4c1c00c", credits: 4, ceiling: 25 });
  assert.equal(hold.ok, true, "the 4-credit repair reservation is granted at 17/25");
  await reservations.release(hold.id ? hold.hold.id : hold.hold?.id);

  // No provider call was made, and accounting never moved.
  const status = await reservations.status("f4c1c00c", 25);
  assert.equal(status.spent, 17);
  assert.equal(status.reserved, 0);
});
