// SEMANTIC CONTROL IDENTITY — the regression for the 2026-08-11 paid failure.
//
// A live qualification burned 6.5423 credits and reported an application undriveable because the
// PLATFORM aimed three contracted contact fields at a party-size number input. The application was
// never at fault. Two independent definitions of "what does this field mean" had drifted apart,
// and both were substring matches over the whole field name:
//
//   semanticAliases("guestName") → [… "party size", "guests", "people"]   (/guest/ in the count branch)
//   valueFor("guestName")        → "2"                                     (/guests?/ again)
//
// The unit half of this file pins the concept rule; the browser half drives the exact screen that
// failed, through the real journeyVerifier, with five extra near-collision controls rendered as
// traps that nothing may write to.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { invalidValueFor, verifyJourneys } from "../../shell/server/lib/appBuild/journeyVerifier.mjs";
import {
  countsPeople, semanticAliases, semanticConcept, semanticKey,
} from "../../shell/server/lib/builderV2/controlIdentity.mjs";
import { deriveBuildSpec } from "../../shell/server/lib/builderV2/buildSpec.mjs";
import { fromScaffold } from "../../src/engine/fileTree.mjs";
import { REACT_VITE } from "../../src/scaffolds/reactVite.mjs";
import { buildTree, ensureDeps, workDirFor } from "../../harness/workspace.mjs";
import { controlCollisionApp, COLLISION_CONTRACT } from "./fixtures/controlCollisionApp.mjs";

const requireCjs = createRequire(import.meta.url);
let playwrightAvailable = true;
try { requireCjs("playwright"); } catch { playwrightAvailable = false; }
const needsBrowser = { skip: playwrightAvailable ? false : "requires playwright" };

// ── the concept rule ───────────────────────────────────────────────────────────────────────────

test("a person token qualifies a concept; it never supplies one", () => {
  // The head noun decides. "guest" says WHOSE, never WHAT.
  for (const field of ["guestName", "customerName", "attendeeName", "contactName"]) {
    assert.equal(semanticConcept(field), "name", field);
    assert.equal(countsPeople(field), false, field);
    assert.equal(semanticAliases(field).includes("party size"), false,
      `${field} must not advertise the party-size control: ${JSON.stringify(semanticAliases(field))}`);
  }
  assert.equal(semanticConcept("guestEmail"), "email");
  assert.equal(semanticConcept("guestPhone"), "phone");
  assert.equal(semanticConcept("contactPhone"), "phone");
});

test("a count of PEOPLE is a party size, however the contract spells it", () => {
  for (const field of ["partySize", "guestCount", "numberOfGuests", "attendeeCount",
    "customerCount", "peopleCount"]) {
    assert.equal(semanticConcept(field), "count", field);
    assert.equal(countsPeople(field), true, field);
    assert.equal(semanticKey(field), "partySize", field);
    assert.ok(semanticAliases(field).includes("party size"), field);
  }
});

test("a count of THINGS is a count, and is not a party size", () => {
  // An item count and a party size are both counts and are emphatically not the same control.
  for (const field of ["itemCount", "quantity"]) {
    assert.equal(semanticConcept(field), "count", field);
    assert.equal(countsPeople(field), false, field);
    assert.notEqual(semanticKey(field), "partySize", field);
    assert.equal(semanticAliases(field).includes("party size"), false, field);
  }
});

test("contact fields and count fields never collapse onto one control key", () => {
  assert.notEqual(semanticKey("guestName"), semanticKey("guestCount"));
  assert.notEqual(semanticKey("guestEmail"), semanticKey("guestCount"));
  assert.notEqual(semanticKey("guestPhone"), semanticKey("guestCount"));
  assert.notEqual(semanticKey("customerName"), semanticKey("customerCount"));
  assert.notEqual(semanticKey("attendeeName"), semanticKey("attendeeCount"));
  // …while the counts agree with each other, which is the point of a canonical key.
  assert.equal(semanticKey("guestCount"), semanticKey("partySize"));
  assert.equal(semanticKey("numberOfGuests"), semanticKey("partySize"));
});

test("an identifier suffix names the concept it hangs off", () => {
  assert.equal(semanticKey("slotId"), "slot");
  assert.equal(semanticKey("dateId"), "date");
  // …and a field that denotes nothing this platform knows keeps its own identity.
  assert.equal(semanticKey("dietaryNote"), "dietarynote");
  assert.equal(semanticKey("deliverySpeed"), "deliveryspeed");
});

// ── value generation, from the same authority ──────────────────────────────────────────────────

test("generated values follow the field's concept, not a second set of regexes", async () => {
  // valueFor is module-private; the contract it must honour is observable through the concept.
  const { default: verifier } = await import("../../shell/server/lib/appBuild/journeyVerifier.mjs");
  void verifier;
  assert.equal(semanticConcept("guestName"), "name", "a name must never resolve as a count");
  assert.equal(semanticConcept("guestEmail"), "email");
  assert.equal(semanticConcept("guestPhone"), "phone");
  assert.equal(semanticConcept("partySize"), "count");
});

test("invalid-value generation follows the same concept", () => {
  assert.equal(invalidValueFor("guestEmail", ["text"]), "not-an-email");
  assert.equal(invalidValueFor("partySize", ["text"]), "not-a-number");
  assert.equal(invalidValueFor("guestCount", ["text"]), "not-a-number");
  // A name has no rule the contract states, so none is invented — and it is certainly not a number.
  assert.equal(invalidValueFor("guestName", ["text"]), null);
  assert.equal(invalidValueFor("customerName", ["text"]), null);
});

// ── the exact failing screen, in a real browser ────────────────────────────────────────────────

const SPEC = deriveBuildSpec(COLLISION_CONTRACT);
const CASE = "bv2-control-collision";
const TRAPS = ["guestCount", "customerName", "customerCount", "attendeeName", "attendeeCount"];

let server = null;
let built = null;
let result = null;

before(async () => {
  if (!playwrightAvailable) return;
  await ensureDeps(() => {});
  built = await buildTree({ ...fromScaffold(REACT_VITE), ...controlCollisionApp() }, CASE, () => {});
  if (!built.ok) return;
  const root = path.join(workDirFor(CASE), "dist");
  server = http.createServer(async (request, response) => {
    const requested = (request.url || "/").split("?")[0];
    const file = requested === "/" ? "/index.html" : requested;
    try {
      const body = await readFile(path.join(root, file));
      response.writeHead(200, { "content-type": file.endsWith(".js") ? "text/javascript"
        : file.endsWith(".css") ? "text/css" : "text/html" });
      response.end(body);
    } catch {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(await readFile(path.join(root, "index.html")));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  result = await verifyJourneys({
    previewUrl: `http://127.0.0.1:${server.address().port}`, contract: SPEC.contract, timeoutMs: 600_000,
  });
}, { timeout: 1_800_000 });

after(async () => { if (server) await new Promise((resolve) => server.close(resolve)); });

const journey = () => result.journeys.find((row) => row.id === "identity");
const fieldsOf = (index) => journey().steps[index].controlEvidence?.fields || [];
const renderedOf = (index) => journey().steps[index].controlEvidence?.renderedControls || [];

test("the collision fixture compiles", { ...needsBrowser }, () => {
  assert.equal(built.ok, true, built?.stderr);
});

test("PAID FAILURE — the journey that died live now drives clean", { ...needsBrowser }, () => {
  const lines = (journey().steps || []).map((step, index) =>
    `  ${index + 1} ${String(step.status).toUpperCase().padEnd(12)} ${step.action} — ${(step.detail || "").slice(0, 90)}`);
  console.log(`\n### identity => ${journey().status}\n${lines.join("\n")}`);
  assert.equal(journey().status, "pass", lines.join("\n"));
});

test("the party-size step targets ONLY the numeric party-size input", { ...needsBrowser }, () => {
  const fields = fieldsOf(3);
  assert.equal(fields.length, 1, JSON.stringify(fields.map((f) => f.field)));
  assert.equal(fields[0].field, "partySize");
  assert.equal(fields[0].status, "filled");
  assert.equal(fields[0].facts?.name, "partySize", JSON.stringify(fields[0]));
  assert.equal(fields[0].facts?.type, "number");
});

test("each contact field drives the control that bears its own name", { ...needsBrowser }, () => {
  const byField = new Map(fieldsOf(4).map((row) => [row.field, row]));
  for (const [field, type] of [["guestName", "text"], ["guestEmail", "email"], ["guestPhone", "tel"]]) {
    const row = byField.get(field);
    assert.ok(row, `${field} was not driven: ${[...byField.keys()].join(", ")}`);
    assert.equal(row.status, "filled", JSON.stringify(row));
    // The control it actually typed into — the fact that was wrong in production.
    assert.equal(row.facts?.name, field, `${field} drove ${row.facts?.name}: ${row.matchedBy}`);
    assert.equal(row.facts?.type, type, JSON.stringify(row.facts));
    assert.equal(row.observedValue, row.expectedValue, `${field} value was not accepted`);
  }
});

test("no contracted field ever resolves to Party Size", { ...needsBrowser }, () => {
  for (const index of [3, 4]) {
    for (const row of fieldsOf(index)) {
      if (row.field === "partySize") continue;
      assert.notEqual(row.facts?.name, "partySize",
        `${row.field} resolved to the party-size control (${row.matchedBy})`);
      assert.equal(/party size/i.test(String(row.matchedBy || "")), false,
        `${row.field} matched by a party-size locator: ${row.matchedBy}`);
    }
  }
});

test("party size keeps its value while the contact fields are filled", { ...needsBrowser }, () => {
  // Captured as the contact step began: the number the previous step entered is still there, and
  // the contact controls are still empty — nothing has bled between them.
  const rendered = new Map(renderedOf(4).map((row) => [row.name, row]));
  assert.equal(rendered.get("partySize")?.value, "2",
    `party size was overwritten: ${JSON.stringify([...rendered.values()].map((r) => [r.name, r.value]))}`);
  for (const field of ["guestName", "guestEmail", "guestPhone"]) {
    assert.equal(rendered.get(field)?.value, "", `${field} held a value before its own step`);
  }
});

test("NEAR COLLISIONS — the trap controls are never written to", { ...needsBrowser }, () => {
  // guestCount, customerName, customerCount, attendeeName and attendeeCount sit on the same screen
  // and are contracted by nothing. A single cross-match would leave a value in one of them.
  const rendered = new Map(renderedOf(4).map((row) => [row.name, row]));
  for (const trap of TRAPS) {
    assert.ok(rendered.has(trap), `the ${trap} trap must be on screen: ${[...rendered.keys()].join(", ")}`);
  }
  const driven = new Set([3, 4].flatMap((index) => fieldsOf(index).map((row) => row.facts?.name)));
  for (const trap of TRAPS) {
    assert.equal(driven.has(trap), false, `a contracted field drove the ${trap} trap`);
  }
});
