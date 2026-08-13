import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyComplexity,
  COMPLEXITY,
  profileFor,
  createProfiler,
  budgetVerdict,
} from "../../shell/server/lib/appBuild/buildProfile.mjs";

test("named product shapes are classified into the expected complexity", () => {
  for (const prompt of [
    "build me a landing page",
    "a contact form for my studio",
    "a booking site for a strawberry farm",
    "my photography portfolio",
    "a simple CRUD todo app",
  ]) {
    assert.equal(classifyComplexity({ prompt }).level, COMPLEXITY.simple, prompt);
  }
  for (const prompt of [
    "an analytics dashboard",
    "a SaaS with subscriptions",
    "an ecommerce storefront with checkout",
    "an admin system for my team",
  ]) {
    assert.equal(classifyComplexity({ prompt }).level, COMPLEXITY.medium, prompt);
  }
  for (const prompt of [
    "a browser IDE with a code editor",
    "an AI writing assistant",
    "a Roblox model generator",
    "a drag-and-drop visual editor",
    "a CAD-style 3D modelling tool",
  ]) {
    assert.equal(classifyComplexity({ prompt }).level, COMPLEXITY.advanced, prompt);
  }
});

test("the generated contract outranks prompt wording when they disagree", () => {
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

test("simple and advanced profiles retain their intended verification and budget differences", () => {
  const simple = profileFor(COMPLEXITY.simple);
  const advanced = profileFor(COMPLEXITY.advanced);
  assert.equal(simple.genericAuthProbe, false);
  assert.equal(advanced.genericAuthProbe, true);
  assert.equal(simple.mergeStages, true);
  assert.ok(simple.maxCredits <= 12);
  assert.ok(simple.maxCredits < advanced.maxCredits);
  assert.ok(simple.maxRepairTurns < advanced.maxRepairTurns);
});

test("the profiler exposes expensive model phases and cache hits", () => {
  let clock = 0;
  const profiler = createProfiler({ level: COMPLEXITY.simple, now: () => clock });
  profiler.ai("Foundation", { credits: 1.94, usage: { input: 28_671, output: 5_615 }, durationMs: 98_900 });
  clock = 100_000;
  profiler.ai("Code changes", {
    credits: 28.84,
    usage: { input: 355_772, output: 21_222 },
    durationMs: 258_300,
    phase: "repair",
  });
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
  assert.equal(summary.hotspots[0].label, "Code changes");
  assert.ok(summary.hotspots[0].ratio > 15);
  assert.match(profiler.flame(), /BUILD PROFILE/);
  assert.match(profiler.flame(), /Code changes/);
});

test("profile budgets report the exhausted dimension", () => {
  let clock = 0;
  const profile = profileFor(COMPLEXITY.simple);
  const profiler = createProfiler({ level: COMPLEXITY.simple, now: () => clock });
  assert.equal(budgetVerdict(profiler, profile).ok, true);

  profiler.ai("big", { credits: profile.maxCredits, usage: { input: 1, output: 1 } });
  assert.equal(budgetVerdict(profiler, profile).reason, "credits");

  const fresh = createProfiler({ level: COMPLEXITY.simple, now: () => clock });
  assert.equal(budgetVerdict(fresh, profile, { repairCredits: 99 }).reason, "repair_credits");
  clock = profile.maxDurationMs + 1;
  assert.equal(budgetVerdict(fresh, profile).reason, "duration");
});
