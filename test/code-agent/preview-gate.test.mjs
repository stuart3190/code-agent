// Detection without enforcement is not completion.
//
// PR6 and PR7 found the defects and the build shipped anyway: a production run ended
// "preview delivered, customer needed: no" with five of six contract journeys failing and seven
// honesty findings outstanding. These are the three gates that make the findings mean something.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BUILD_STATES, resolveBuildState, customerMessageFor, isShippable, blocksPublishing,
} from "../../shell/shared/buildStates.mjs";
import { verifyFunctionalRepair } from "../../shell/server/lib/appBuild/patchVerification.mjs";
import {
  functionalRepairBrief, persistenceRepairBrief, journeyRepairBrief,
  findingKey, nextFunctionalTier, regenerateModuleBrief, PROHIBITED_STORES,
} from "../../shell/server/lib/appBuild/functionalFindings.mjs";
import { honestyScan } from "../../shell/server/lib/appBuild/honestyScan.mjs";

const CONTRACT = {
  entities: [{
    name: "booking", owned: true,
    fields: [{ name: "slotId", type: "string", required: true }, { name: "email", type: "string", required: true }],
  }],
  operations: [{ id: "create-booking", description: "persist the booking via db.entity('booking').create" }],
  acceptance: [{ id: "a1", statement: "a submitted booking is readable after a page reload" }],
};

// The tree production actually produced, in miniature: compiles, renders, stores nothing real.
const BROWSER_ONLY = {
  "src/data/bookings.js": `
export function createBooking(booking) {
  const all = JSON.parse(localStorage.getItem("bookings") || "[]");
  all.push(booking);
  localStorage.setItem("bookings", JSON.stringify(all));
  return booking;
}
`,
};

// ── 1. THE GATE ───────────────────────────────────────────────────────────────────────────────

test("a compiling app with a failing primary journey never reaches preview_ready", () => {
  const state = resolveBuildState({
    compileOk: true,
    previewUrl: "https://preview.example/",
    journeys: { pass: false },
    honesty: { ok: true },
  });
  assert.equal(state, BUILD_STATES.verificationFailed);
  assert.equal(isShippable(state), false);
  assert.equal(blocksPublishing(state), true, "a failed build must not consume publish state");
});

test("outstanding honesty findings also block, however well it compiles", () => {
  const honesty = honestyScan(BROWSER_ONLY, { contract: CONTRACT });
  assert.equal(honesty.ok, false);
  const state = resolveBuildState({
    compileOk: true, previewUrl: "https://preview.example/",
    journeys: { pass: true }, honesty,
  });
  assert.equal(state, BUILD_STATES.verificationFailed);
  assert.equal(isShippable(state), false);
});

test("a build whose journeys were never run is pending, not ready", () => {
  // The precise hole: preview_ready used to be granted for compiling. Not being caught is not the
  // same as having passed.
  assert.equal(
    resolveBuildState({ compileOk: true, previewUrl: "https://p/", journeys: { pass: null }, honesty: { ok: true } }),
    BUILD_STATES.verificationPending,
  );
  assert.equal(
    resolveBuildState({ compileOk: true, previewUrl: null, journeys: { pass: true }, honesty: { ok: true } }),
    BUILD_STATES.verificationPending,
  );
});

test("preview_ready is reachable only when everything required has passed", () => {
  const state = resolveBuildState({
    compileOk: true, previewUrl: "https://preview.example/",
    journeys: { pass: true }, honesty: { ok: true }, acceptanceFailures: [],
  });
  assert.equal(state, BUILD_STATES.previewReady);
  assert.equal(isShippable(state), true);
  assert.equal(blocksPublishing(state), false);
});

test("every terminal state exists and says the right thing to the customer", () => {
  assert.deepEqual(Object.values(BUILD_STATES).sort(), [
    "blocked", "preview_ready", "repair_in_progress", "verification_failed", "verification_pending",
  ]);
  // The exact sentence the brief asks for.
  assert.equal(customerMessageFor(BUILD_STATES.verificationFailed),
    "Thrallo found a functional issue and is fixing it automatically.");
  assert.equal(customerMessageFor(BUILD_STATES.repairInProgress),
    "Thrallo found a functional issue and is fixing it automatically.");
  assert.match(customerMessageFor(BUILD_STATES.blocked), /last working version is saved/);
  assert.match(customerMessageFor(BUILD_STATES.verificationPending), /checking that it actually works/);
  // Only one state is shippable.
  assert.deepEqual(Object.values(BUILD_STATES).filter(isShippable), ["preview_ready"]);
});

test("repairing and exhausted states take priority over everything else", () => {
  assert.equal(resolveBuildState({ repairing: true, compileOk: true, journeys: { pass: true } }),
    BUILD_STATES.repairInProgress);
  assert.equal(resolveBuildState({ exhausted: true, compileOk: true, journeys: { pass: true } }),
    BUILD_STATES.blocked);
});

// ── 2. THE BRIEF ──────────────────────────────────────────────────────────────────────────────

test("the persistence brief carries every structured detail the repair needs", () => {
  const honesty = honestyScan(BROWSER_ONLY, { contract: CONTRACT });
  const brief = functionalRepairBrief({ honesty, contract: CONTRACT });

  // Exact files and lines.
  assert.match(brief, /src\/data\/bookings\.js:\d+/);
  // The detected API.
  assert.match(brief, /DETECTED BROWSER STORAGE APIS: localStorage/);
  // The contract requirement.
  assert.match(brief, /booking — rows belong to the signed-in user/);
  assert.match(brief, /slotId:string \(required\)/);
  assert.match(brief, /persist the booking via db\.entity\('booking'\)\.create/);
  assert.match(brief, /ACCEPTANCE: a submitted booking is readable after a page reload/);
  // The supported API, spelled out.
  assert.match(brief, /await db\.entity\("<type>"\)\.create\(record\)/);
  // The exact instruction the brief demands.
  assert.match(brief, /Replace browser-only persistence with the generated app's real database/);
  assert.match(brief, /Data must survive refresh and a new authenticated session/);
});

test("the brief forbids the substitution that actually happened", () => {
  const honesty = honestyScan(BROWSER_ONLY, { contract: CONTRACT });
  const brief = functionalRepairBrief({ honesty, contract: CONTRACT });

  assert.match(brief, /DO NOT substitute one browser store for another/);
  // Every prohibited store named, not just the one that was found — naming only localStorage is
  // how sessionStorage became the "fix".
  for (const store of ["localStorage", "sessionStorage", "indexedDB"]) {
    assert.ok(brief.includes(store), `the brief must rule out ${store}`);
  }
  assert.match(brief, /replaced localStorage with sessionStorage and\s*\n?was rejected/);
  assert.ok(PROHIBITED_STORES.length >= 5);
});

test("the journey brief carries step, expected, actual and the browser evidence", () => {
  const brief = journeyRepairBrief({
    journeys: {
      failures: [{
        title: "A visitor books a slot", priority: "primary",
        steps: [
          { action: "open the booking page", expect: "slots are visible", status: "pass" },
          { action: "submit the details", expect: "a booking reference is shown", status: "fail",
            detail: "expected reference; found none" },
        ],
      }],
      consoleErrors: ["TypeError: create is not a function"],
      failedRequests: ["500 POST /api/entities/booking"],
    },
    contract: CONTRACT,
  });

  assert.match(brief, /PRIMARY — the preview cannot ship until this passes/);
  assert.match(brief, /FAIL 2\. submit the details/);
  assert.match(brief, /expected: a booking reference is shown/);
  assert.match(brief, /actual:\s+expected reference; found none/);
  assert.match(brief, /TypeError: create is not a function/);
  assert.match(brief, /500 POST \/api\/entities\/booking/);
  assert.match(brief, /through db\.entity\(\)/);
  assert.match(brief, /do not remove the feature to make the check stop failing/);
  // A passing step is shown as context but not as the thing to fix.
  assert.match(brief, /ok\s+1\. open the booking page/);
});

// ── 3. THE VERIFIER ───────────────────────────────────────────────────────────────────────────

test("PRODUCTION SEQUENCE — localStorage becoming sessionStorage is never effective", () => {
  const before = honestyScan(BROWSER_ONLY, { contract: CONTRACT }).findings;
  // Exactly what the repair actually did.
  const after = honestyScan({
    "src/data/bookings.js": BROWSER_ONLY["src/data/bookings.js"].replace(/localStorage/g, "sessionStorage"),
  }, { contract: CONTRACT }).findings;

  const verdict = verifyFunctionalRepair({ before, after, keyOf: findingKey });
  assert.notEqual(verdict.verdict, "effective");
  assert.equal(verdict.effective, false);
  assert.ok(verdict.equivalent > 0, "the same defect in a new spelling must be recognised as equivalent");
});

test("PRODUCTION SEQUENCE — 4 findings becoming 7 is worse, never effective", () => {
  const before = Array.from({ length: 4 }, (_, i) => ({ id: "fake_persistence", file: `src/a${i}.js`, snippet: `localStorage.setItem("k${i}")` }));
  const after = Array.from({ length: 7 }, (_, i) => ({ id: "fake_persistence", file: `src/b${i}.js`, snippet: `sessionStorage.setItem("k${i}")` }));

  const verdict = verifyFunctionalRepair({ before, after, keyOf: findingKey });
  assert.equal(verdict.verdict, "worse");
  assert.equal(verdict.effective, false);
  assert.match(verdict.summary, /made it worse: 4 finding\(s\) became 7/);
});

test("compile success is irrelevant to a functional verdict", () => {
  // The whole reason the old verifier said "effective" twice: it was answering a different
  // question. Nothing in this signature can even express whether the project compiled.
  const before = honestyScan(BROWSER_ONLY, { contract: CONTRACT }).findings;
  const verdict = verifyFunctionalRepair({ before, after: before, keyOf: findingKey });
  assert.equal(verdict.verdict, "ineffective");
  assert.equal(verdict.remaining, before.length);
});

test("a real fix is effective", () => {
  const before = honestyScan(BROWSER_ONLY, { contract: CONTRACT }).findings;
  const after = honestyScan({
    "src/data/bookings.js": `
import { db } from "../lib/backend";
export async function createBooking(booking) {
  return db.entity("booking").create(booking);
}
`,
  }, { contract: CONTRACT }).findings;

  const verdict = verifyFunctionalRepair({ before, after, keyOf: findingKey });
  assert.equal(verdict.verdict, "effective");
  assert.equal(verdict.effective, true);
  assert.equal(verdict.afterCount, 0);
  assert.match(verdict.summary, /all \d+ finding\(s\) resolved/);
});

// ── escalation ────────────────────────────────────────────────────────────────────────────────

test("one ineffective targeted repair escalates to regenerating the module, then stops", () => {
  assert.equal(nextFunctionalTier("targeted"), "regenerate_module");
  assert.equal(nextFunctionalTier("regenerate_module"), "restore_and_block");
  assert.equal(nextFunctionalTier("restore_and_block"), null, "there is no fourth blind round");

  const brief = regenerateModuleBrief({
    findings: honestyScan(BROWSER_ONLY, { contract: CONTRACT }).findings,
    contract: CONTRACT,
  });
  assert.match(brief, /REGENERATE THIS MODULE/);
  assert.match(brief, /src\/data\/bookings\.js/);
  assert.match(brief, /Keep the exported/);
  assert.match(brief, /Touch no other file/, "this is a module rewrite, not another whole-project pass");
});
