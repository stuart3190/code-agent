// PER-CALL CEILING BY CLASS — the slice of a build's approved ceiling one call may reserve.
//
// The 2026-09-16 advanced qualification (build 13ab5175) was approved for 60 credits and died at
// 5.32: its core prompt could not fit 1,200 useful output tokens inside the constant 6-credit
// per-call ceiling, the lane split to single files, and the journey controller alone still did
// not fit. A simple build and an advanced build were sharing one per-call slice. The slice now
// scales with the class; the whole-build ceiling in planCallReservation is unchanged and remains
// the hard limit, and the fit failure states the numbers it was decided on.

import test from "node:test";
import assert from "node:assert/strict";

import { STEP_CEILING_SCALE, stepOutputPolicy } from "../../shell/server/lib/builderV2/runtimeComposition.mjs";
import { planCallReservation } from "../../shell/server/lib/builderV2/modelLanes.mjs";

test("the per-call ceiling scales with the build class and nothing else changes", () => {
  assert.deepEqual(STEP_CEILING_SCALE, { simple: 1, medium: 1.5, advanced: 2 });
  assert.equal(stepOutputPolicy("core").callCeilingCredits, 6, "no class keeps the historical constant");
  assert.equal(stepOutputPolicy("core", { profile: "simple" }).callCeilingCredits, 6);
  assert.equal(stepOutputPolicy("core", { profile: "medium" }).callCeilingCredits, 9);
  assert.equal(stepOutputPolicy("core", { profile: "advanced" }).callCeilingCredits, 12);
  assert.equal(stepOutputPolicy("repair", { profile: "advanced" }).callCeilingCredits, 12);
  assert.equal(stepOutputPolicy("contract", { profile: "advanced" }).callCeilingCredits, 6);
  assert.equal(stepOutputPolicy("edit", { profile: "medium" }).callCeilingCredits, 6);
  assert.equal(stepOutputPolicy("core", { profile: "unknown-class" }).callCeilingCredits, 6);
  const advanced = stepOutputPolicy("repair", { profile: "advanced" });
  assert.equal(advanced.maxOutputTokens, 10_000, "the output envelope is not widened");
  assert.equal(advanced.repairAllowanceCredits, 4, "the nominal repair allowance is not widened");
});

test("a fit failure names the input it estimated, the ceiling it hit and the output that would fit", () => {
  const model = "gpt-5.5";
  const options = { systemPrompt: "x".repeat(60_000), messages: [{ role: "user", content: "y".repeat(60_000) }] };
  let thrown = null;
  try {
    planCallReservation(options, model, {
      requestedMaxOutputTokens: 16_000, callCeilingCredits: 0.5,
      budget: { remainingCredits: 60, approvedCeilingCredits: 60, consumedCredits: 0 },
      repairSizing: { retrievedFileCount: 1, retrievalTokens: 0, problemCount: 1 },
    });
  } catch (error) { thrown = error; }
  assert.ok(thrown, "a 0.5-credit ceiling cannot hold a 40k-token prompt");
  assert.match(thrown.message, /^Builder V2 call cannot fit a useful response inside approved headroom \(estimated input \d+ tokens, per-call ceiling 0\.5 credits, remaining 60 credits: at most \d+ output tokens fit, \d+ are needed\)$/);
  assert.equal(thrown.dispatchState, "before_dispatch");
  // 120k prompt bytes at the calibrated 3.8 bytes per token (builder-v2-generation-envelope) is ~31.6k tokens.
  assert.equal(thrown.estimatedInputTokens > 30_000, true);
  assert.equal(thrown.callCeiling, 0.5);
});
