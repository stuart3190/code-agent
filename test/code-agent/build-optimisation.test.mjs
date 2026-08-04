// Optimisation: the same guarantees, dramatically less money.
//
// The 62-credit booking site was not expensive because of staged generation — the four stages cost
// about 11 credits between them. Three verification repair rounds cost 28.84, 20.42 and 7.43, at
// input-to-output ratios of 17:1, because each re-sent the whole project on every turn.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyComplexity, COMPLEXITY, profileFor, createProfiler, budgetVerdict,
} from "../../shell/server/lib/appBuild/buildProfile.mjs";
import {
  concernsOf, changedConcerns, createVerificationCache, journeysToRerun,
} from "../../shell/server/lib/appBuild/verificationCache.mjs";
import {
  repairFakePersistence, deterministicRepairs, deterministicSummary,
} from "../../shell/server/lib/appBuild/deterministicRepair.mjs";
import { honestyScan } from "../../shell/server/lib/appBuild/honestyScan.mjs";

// ── 1. classification ─────────────────────────────────────────────────────────────────────────

test("the levels the brief names are classified as named", () => {
  for (const prompt of ["build me a landing page", "a contact form for my studio",
    "a booking site for a strawberry farm", "my photography portfolio", "a simple CRUD todo app"]) {
    assert.equal(classifyComplexity({ prompt }).level, COMPLEXITY.simple, prompt);
  }
  for (const prompt of ["an analytics dashboard", "a SaaS with subscriptions",
    "an ecommerce storefront with checkout", "an admin system for my team"]) {
    assert.equal(classifyComplexity({ prompt }).level, COMPLEXITY.medium, prompt);
  }
  for (const prompt of ["a browser IDE with a code editor", "an AI writing assistant",
    "a Roblox model generator", "a drag-and-drop visual editor", "a CAD-style 3D modelling tool"]) {
    assert.equal(classifyComplexity({ prompt }).level, COMPLEXITY.advanced, prompt);
  }
});

test("the contract outranks the wording when they disagree", () => {
  // Called a "simple booking site", but eight entities is not a simple booking site.
  const level = classifyComplexity({
    prompt: "a simple booking site",
    contract: {
      journeys: Array.from({ length: 9 }, (_, i) => ({ id: `j${i}`, title: `journey ${i}` })),
      entities: Array.from({ length: 5 }, (_, i) => ({ name: `e${i}` })),
      routes: [],
    },
  }).level;
  assert.equal(level, COMPLEXITY.medium);
});

test("a simple build skips the machinery that cost the most and proved the least", () => {
  const simple = profileFor(COMPLEXITY.simple);
  const advanced = profileFor(COMPLEXITY.advanced);

  // The generic signup probe failed three times on the booking site and drove every repair round,
  // on an app whose contract never mentioned accounts.
  assert.equal(simple.genericAuthProbe, false);
  assert.equal(advanced.genericAuthProbe, true);
  assert.equal(simple.mergeStages, true, "a small app's foundation and journey are the same work");

  // The budget that makes the target enforceable rather than aspirational.
  assert.ok(simple.maxCredits <= 12, `simple builds must be capped near the target, got ${simple.maxCredits}`);
  assert.ok(simple.maxCredits < advanced.maxCredits);
  assert.ok(simple.maxRepairTurns < advanced.maxRepairTurns);
});

// ── 2. differential verification ──────────────────────────────────────────────────────────────

test("a style-only change invalidates only visual checks", () => {
  const changed = changedConcerns(["src/index.css", "tailwind.config.js"]);
  const cache = createVerificationCache();
  for (const check of ["persistence", "authJourney", "honesty", "journeys", "visual"]) cache.recordPass(check);

  assert.equal(cache.needsRun("persistence", changed).run, false, "CSS cannot break persistence");
  assert.equal(cache.needsRun("authJourney", changed).run, false);
  assert.equal(cache.needsRun("honesty", changed).run, false);
  assert.equal(cache.needsRun("visual", changed).run, true);
  assert.match(cache.needsRun("persistence", changed).reason, /nothing affecting persistence changed/);
});

test("a data change invalidates persistence but not authentication", () => {
  const changed = changedConcerns(["src/data/bookings.js"]);
  const cache = createVerificationCache();
  for (const check of ["persistence", "authJourney", "visual"]) cache.recordPass(check);

  assert.equal(cache.needsRun("persistence", changed).run, true);
  assert.equal(cache.needsRun("authJourney", changed).run, false);
  assert.equal(cache.needsRun("visual", changed).run, false);
});

test("an auth change invalidates auth journeys", () => {
  const changed = changedConcerns(["src/auth/LoginForm.jsx"]);
  const cache = createVerificationCache();
  cache.recordPass("authJourney");
  cache.recordPass("visual");
  assert.equal(cache.needsRun("authJourney", changed).run, true);
});

test("a check that has never passed always runs, and a failure is never cached", () => {
  const cache = createVerificationCache();
  const changed = changedConcerns(["src/index.css"]);
  assert.equal(cache.needsRun("persistence", changed).run, true, "unverified is not the same as passed");

  cache.recordPass("persistence");
  assert.equal(cache.needsRun("persistence", changed).run, false);
  // Whatever it complained about is still there until proven otherwise.
  cache.recordFail("persistence");
  assert.equal(cache.needsRun("persistence", changed).run, true);
});

test("only the journeys a change could have broken are re-run", () => {
  const contract = {
    journeys: [
      { id: "book", title: "A visitor books a slot", priority: "primary" },
      { id: "newsletter", title: "A visitor joins the newsletter", priority: "secondary" },
      { id: "owner", title: "The owner cancels a booking", priority: "secondary" },
    ],
  };

  const afterBookingFix = journeysToRerun(contract, ["src/components/BookingJourney.jsx"]).map((j) => j.id);
  assert.ok(afterBookingFix.includes("book"));
  assert.ok(!afterBookingFix.includes("newsletter"), "a booking fix cannot break the newsletter journey");

  // Styling cannot break journey logic.
  assert.deepEqual(journeysToRerun(contract, ["src/index.css"]), []);

  // The primary journey always re-runs: the preview gate depends on it, so a stale pass there is
  // the most expensive kind of wrong.
  assert.ok(journeysToRerun(contract, ["src/unrelated/Thing.jsx"]).some((j) => j.id === "book"));

  // Anything that was failing re-runs regardless.
  const failing = journeysToRerun(contract, ["src/index.css"], { previouslyFailed: ["newsletter"] });
  assert.ok(failing.some((j) => j.id === "newsletter"));
});

test("file concerns are read from the path", () => {
  assert.ok(concernsOf("src/lib/backend/index.js").includes("backend"));
  assert.ok(concernsOf("src/index.css").includes("style"));
  assert.ok(concernsOf("src/auth/Login.jsx").includes("auth"));
  assert.ok(concernsOf("src/data/bookings.js").includes("data"));
  // A named component is UI and data-adjacent — calling it only "ui" would let a persistence bug
  // slip past the cache.
  assert.ok(concernsOf("src/components/BookingForm.jsx").includes("data"));
});

// ── 3. deterministic repair ───────────────────────────────────────────────────────────────────

const FAKE_MODULE = `export function listBookings() {
  return JSON.parse(localStorage.getItem("bookings") || "[]");
}

export function createBooking(booking) {
  const all = listBookings();
  all.push(booking);
  localStorage.setItem("bookings", JSON.stringify(all));
  return booking;
}
`;

test("PRODUCTION DEFECT — fake persistence is repaired with no model call", () => {
  const contract = { entities: [{ name: "booking", fields: [] }] };
  const before = honestyScan({ "src/data/bookings.js": FAKE_MODULE }, { contract });
  assert.equal(before.ok, false);

  const result = deterministicRepairs(
    { "src/data/bookings.js": FAKE_MODULE },
    { findings: before.findings, contract },
  );

  assert.equal(result.repaired.length, 1);
  assert.equal(result.remaining.filter((f) => f.id === "fake_persistence").length, 0);

  const fixed = result.tree["src/data/bookings.js"];
  assert.match(fixed, /db\.entity\("booking"\)\.list\(\)/);
  assert.match(fixed, /db\.entity\("booking"\)\.create\(record\)/);
  assert.ok(!/localStorage|sessionStorage/.test(fixed), "no browser storage may remain");

  // And the scan agrees it is fixed — the point of the exercise.
  const after = honestyScan(result.tree, { contract });
  assert.deepEqual(after.findings.filter((f) => f.id === "fake_persistence"), []);
  assert.match(deterministicSummary(result), /with no model call/);
});

test("it refuses anything it cannot translate unambiguously", () => {
  // Two keys is two concerns; this transform is not smart enough and must say so.
  assert.equal(repairFakePersistence(
    `export function a(){return localStorage.getItem("one")}\nexport function b(){return localStorage.getItem("two")}`,
    { entity: "booking" },
  ), null);

  // An exported function whose purpose is not evident from its name — a stub would be silently
  // wrong, which is worse than leaving it for a model.
  assert.equal(repairFakePersistence(
    `export function frobnicate(){ return JSON.parse(localStorage.getItem("bookings")||"[]") }`,
    { entity: "booking" },
  ), null);

  // No entity to map to.
  assert.equal(repairFakePersistence(FAKE_MODULE, { entity: null }), null);
});

test("findings it cannot fix are handed on rather than silently dropped", () => {
  const findings = [
    { id: "empty_handler", file: "src/App.jsx", line: 4, snippet: "onClick={() => {}}" },
    { id: "fake_persistence", file: "src/weird.js", line: 2, snippet: 'localStorage.setItem("a", 1)' },
  ];
  const result = deterministicRepairs({ "src/weird.js": "const x = 1;" }, { findings, contract: { entities: [] } });
  assert.equal(result.repaired.length, 0);
  assert.equal(result.remaining.length, 2, "everything unfixed must reach the model tier");
});

// ── 4. profiling and budget ───────────────────────────────────────────────────────────────────

test("the profiler exposes the ratio that hid the real problem", () => {
  let clock = 0;
  const profiler = createProfiler({ level: COMPLEXITY.simple, now: () => clock });

  profiler.ai("Foundation", { credits: 1.94, usage: { input: 28671, output: 5615 }, durationMs: 98_900 });
  clock = 100_000;
  // The real 28-credit repair.
  profiler.ai("Code changes", { credits: 28.84, usage: { input: 355_772, output: 21_222 }, durationMs: 258_300, phase: "repair" });
  profiler.deterministic("imports");
  profiler.deterministic("compile");
  profiler.cache("persistence", true);
  profiler.repairRound();

  const summary = profiler.summary();
  assert.equal(summary.aiCalls, 2);
  assert.equal(summary.deterministicChecks, 2);
  assert.equal(summary.cacheHits, 1);
  assert.equal(summary.repairRounds, 1);
  assert.equal(summary.credits, 30.78);

  // Biggest spender first, with the in/out ratio that made the cause obvious.
  assert.equal(summary.hotspots[0].label, "Code changes");
  assert.ok(summary.hotspots[0].ratio > 15, `expected a lopsided ratio, got ${summary.hotspots[0].ratio}`);

  const flame = profiler.flame();
  assert.match(flame, /BUILD PROFILE — simple/);
  assert.match(flame, /Code changes/);
  assert.match(flame, /█/);
  assert.match(flame, /← 16\.8:1 in\/out/, "the flame graph flags the lopsided call");
});

test("budgets stop a build before it spends indefinitely", () => {
  let clock = 0;
  const profile = profileFor(COMPLEXITY.simple);
  const profiler = createProfiler({ level: COMPLEXITY.simple, now: () => clock });

  assert.equal(budgetVerdict(profiler, profile).ok, true);

  profiler.ai("big", { credits: profile.maxCredits, usage: { input: 1, output: 1 } });
  const spent = budgetVerdict(profiler, profile);
  assert.equal(spent.ok, false);
  assert.equal(spent.reason, "credits");
  assert.match(spent.detail, /12-credit limit/);

  // Each limit reports specifically which one ran out, so the customer is told something true.
  const fresh = createProfiler({ level: COMPLEXITY.simple, now: () => clock });
  assert.equal(budgetVerdict(fresh, profile, { repairCredits: 99 }).reason, "repair_credits");
  clock = profile.maxDurationMs + 1;
  assert.equal(budgetVerdict(fresh, profile).reason, "duration");
});
