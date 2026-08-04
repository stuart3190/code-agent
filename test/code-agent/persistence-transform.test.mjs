// The deterministic persistence transform, tested against the modules that actually defeated it.
//
// The first version was written against an idealised fixture and declined every real module in
// production. These are the real ones, reconstructed from the honesty findings of the run for job
// e0bc177a.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  transformModule, transformPersistence, transformSummary, usesBrowserStorage, isDevicePreference,
} from "../../shell/server/lib/appBuild/persistenceTransform.mjs";
import { honestyScan } from "../../shell/server/lib/appBuild/honestyScan.mjs";
import {
  RESERVATION_MODULE, NEWSLETTER_MODULE, UI_PREFERENCE_MODULE, REAL_MODULES,
} from "./fixtures/realPersistenceModules.mjs";

const CONTRACT = {
  entities: [
    { name: "reservation", fields: [{ name: "slotId", type: "string", required: true }] },
    { name: "newsletterSubscription", fields: [{ name: "email", type: "string", required: true }] },
  ],
};

// ── the real modules ──────────────────────────────────────────────────────────────────────────

test("REAL MODULE — reservation.js is transformed despite a constant key and window. access", () => {
  // Why the first transform declined: the key is GUEST_RESERVATIONS_KEY, not a string literal, so
  // the "exactly one key" test found zero and bailed before doing anything.
  const result = transformModule(RESERVATION_MODULE, { entity: "reservation", path: "src/data/reservation.js" });
  assert.equal(result.ok, true, `declined: ${result.declined.join("; ")}`);
  assert.equal(usesBrowserStorage(result.source), false, "no browser storage may remain");

  assert.match(result.source, /await db\.entity\("reservation"\)\.list\(\)/);
  assert.match(result.source, /await db\.entity\("reservation"\)\.create\(reservation\)/);

  // Everything that was not persistence survives untouched — this is why the module is rewritten
  // at call sites rather than wholesale.
  assert.match(result.source, /export function validateReservation/, "validation is preserved");
  assert.match(result.source, /Please give us a name/);
  assert.match(result.source, /localeCompare/, "sorting is preserved");
  assert.match(result.source, /function makeReference/, "helpers are preserved");
  assert.match(result.source, /export async function listReservations/);
  assert.match(result.source, /export async function createReservation/);
});

test("REAL MODULE — newsletterSubscription.js keeps its working signed-in path", () => {
  // The hybrid: signed-in users already used the real store, with browser storage as a guest
  // fallback inside a ternary. A whole-module rewrite would have deleted the working path.
  const result = transformModule(NEWSLETTER_MODULE, {
    entity: "newsletterSubscription", path: "src/data/newsletterSubscription.js",
  });
  assert.equal(result.ok, true, `declined: ${result.declined.join("; ")}`);
  assert.equal(usesBrowserStorage(result.source), false);

  // The real branch survives; the fallback is gone rather than translated into a second store call.
  assert.match(result.source, /await store\.list\(\{ limit: 500 \}\)/);
  assert.ok(!/JSON\.parse/.test(result.source), "the guest fallback read is removed, not rewritten");
  assert.ok(result.applied.includes("hybrid_ternary"));

  // The append becomes a create of the new record, not a write of the whole list.
  assert.match(result.source, /db\.entity\("newsletterSubscription"\)\.create\(guestSubscription\)/);
});

test("every real module ends with zero honesty findings", () => {
  const tree = Object.fromEntries(REAL_MODULES.map((m) => [m.path, m.source]));
  const before = honestyScan(tree, { contract: CONTRACT });
  assert.ok(before.findings.filter((f) => f.id === "fake_persistence").length >= 4,
    "the corpus must reproduce the production findings");

  const result = transformPersistence(tree, { findings: before.findings, contract: CONTRACT });
  assert.equal(result.declined.length, 0, JSON.stringify(result.declined, null, 1));
  assert.equal(result.fixed.length, 2);

  const after = honestyScan(result.tree, { contract: CONTRACT });
  assert.deepEqual(after.findings.filter((f) => f.id === "fake_persistence"), [],
    "the defect this exists for must be gone");
  assert.match(transformSummary(result), /with no model call/);
});

test("the transformed modules still parse and keep their exports", async () => {
  const tree = Object.fromEntries(REAL_MODULES.map((m) => [m.path, m.source]));
  const before = honestyScan(tree, { contract: CONTRACT });
  const { tree: fixed } = transformPersistence(tree, { findings: before.findings, contract: CONTRACT });

  for (const { path, source } of REAL_MODULES) {
    const after = fixed[path];
    // Parses: an actual parse, not a regex that hopes.
    assert.doesNotThrow(() => new Function(`return (async () => { ${after.replace(/^import .*$/gm, "").replace(/\bexport\s+/g, "")} })`),
      `${path} no longer parses`);

    // Exported names are unchanged — callers must keep working.
    const names = (text) => [...text.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)].map((m) => m[1]).sort();
    assert.deepEqual(names(after), names(source), `${path} changed its exports`);
  }
});

// ── what it must still decline ────────────────────────────────────────────────────────────────

test("a device preference is left in the browser, where it belongs", () => {
  // Moving the theme into the database would be actively wrong, not merely unnecessary.
  assert.equal(isDevicePreference(UI_PREFERENCE_MODULE, "src/ui/theme.js"), true);
  const result = transformModule(UI_PREFERENCE_MODULE, { entity: "reservation", path: "src/ui/theme.js" });
  assert.equal(result.ok, false);
  assert.match(result.declined[0], /device preference/);
  assert.equal(result.source, UI_PREFERENCE_MODULE, "and it is returned untouched");
});

test("a partial transform is a decline, never a partial rewrite", () => {
  // Leaving one call behind is the same defect with fewer findings — the substitution failure this
  // whole line of work exists to prevent.
  const mixed = `export async function list() {
  return JSON.parse(window.localStorage.getItem("k") || "[]");
}
export function weird(x) {
  window.localStorage.setItem("k", btoa(String(x)));
}
`;
  const result = transformModule(mixed, { entity: "reservation", path: "src/data/reservation.js" });
  assert.equal(result.ok, false);
  assert.equal(result.source, mixed, "nothing is applied when the module cannot be finished");
  assert.ok(result.declined.some((d) => /btoa/.test(d)), `expected the unmapped line, got ${result.declined}`);
  // The reason names the exact expression, so a targeted repair gets the reason not the file.
  assert.match(result.declined[0], /src\/data\/reservation\.js:\d+/);
});

test("no entity to map to is a decline", () => {
  assert.equal(transformModule(RESERVATION_MODULE, { entity: null, path: "x.js" }).ok, false);
});

test("declined modules are reported for targeted repair, not silently skipped", () => {
  const tree = {
    "src/data/reservation.js": RESERVATION_MODULE,
    "src/data/odd.js": `export function save(x) { window.localStorage.setItem("odd", btoa(x)); }`,
  };
  const findings = honestyScan(tree, { contract: CONTRACT }).findings;
  const result = transformPersistence(tree, { findings, contract: CONTRACT });

  assert.equal(result.fixed.length, 1, "the module it can do is still done for free");
  assert.equal(result.declined.length, 1);
  assert.equal(result.declined[0].file, "src/data/odd.js");
  assert.match(transformSummary(result), /declined 1/);
});

test("storage detection covers the forms real code uses", () => {
  assert.equal(usesBrowserStorage('window.localStorage.getItem("k")'), true);
  assert.equal(usesBrowserStorage('globalThis.sessionStorage.setItem("k", "v")'), true);
  assert.equal(usesBrowserStorage("indexedDB.open('db')"), true);
  assert.equal(usesBrowserStorage("const x = 1;"), false);
});

test("COMPONENT-LOCAL — storage inside a component is transformed, not just data modules", () => {
  // The latest production run put four of nine findings in App.jsx: a useState initialiser, reads
  // inside handlers and an append in a submit callback. A module-shaped transform saw none of them.
  const component = `import React, { useState } from "react";
import { db } from "./lib/backend";

export default function App() {
  const [bookings, setBookings] = useState(JSON.parse(window.localStorage.getItem("bookings") || "[]"));

  const submit = async (form) => {
    const existing = JSON.parse(window.localStorage.getItem("bookings") || "[]");
    const record = { ...form, id: Date.now() };
    window.localStorage.setItem("bookings", JSON.stringify([...existing, record]));
    setBookings([...existing, record]);
  };

  return <form onSubmit={submit}><button type="submit">Book</button></form>;
}
`;
  const result = transformModule(component, { entity: "booking", path: "src/App.jsx" });
  assert.equal(result.ok, true, `declined: ${result.declined.join("; ")}`);
  assert.equal(usesBrowserStorage(result.source), false, "no browser storage may remain");

  // The initialiser cannot become an await — a synchronous initialiser that awaits does not compile.
  assert.match(result.source, /useState\(\[\]\)/);
  assert.ok(result.applied.includes("usestate_initialiser"));
  assert.match(result.source, /await db\.entity\("booking"\)\.list\(\)/);
  assert.match(result.source, /await db\.entity\("booking"\)\.create\(record\)/);

  // The component is otherwise untouched — this is a component, mostly rendering.
  assert.match(result.source, /<form onSubmit=\{submit\}>/);
  assert.match(result.source, /export default function App/);
});

test("a component transform still parses", () => {
  const component = `import React, { useState } from "react";
export default function App() {
  const [x, setX] = useState(JSON.parse(localStorage.getItem("bookings") || "[]"));
  return null;
}`;
  const result = transformModule(component, { entity: "booking", path: "src/App.jsx" });
  assert.equal(result.ok, true);
  assert.doesNotThrow(() => new Function(`return (${result.source.replace(/^import .*$/gm, "").replace(/export default /, "")})`));
});
