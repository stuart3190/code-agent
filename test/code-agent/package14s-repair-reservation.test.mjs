import test from "node:test";
import assert from "node:assert/strict";

import {
  conservativeCallReservation, planCallReservation, repairOutputEnvelope,
} from "../../shell/server/lib/builderV2/modelLanes.mjs";
import { memoryModelReservations } from "../../shell/server/lib/builderV2/modelReservations.mjs";
import { creditsForUsage } from "../../src/billing/costModel.mjs";

const options = {
  systemPrompt: "repair only the named defect",
  messages: [{ role: "user", content: "x".repeat(20_000) }],
  tools: [{ type: "function", name: "emit_patches" }],
};
const repairSizing = { retrievedFileCount: 3, retrievalTokens: 5_500, problemCount: 4 };

test("14S repair fits the confirmed 5.901-credit headroom instead of demanding the 6-credit maximum", () => {
  const plan = planCallReservation(options, "gpt-5.5", {
    requestedMaxOutputTokens: 10_000, callCeilingCredits: 6, repairAllowanceCredits: 4,
    repairSizing, budget: { approvedCeilingCredits: 12, consumedCredits: 6.099,
      reservedCredits: 0, remainingCredits: 5.901 },
  });
  assert.equal(plan.effectiveCallCeilingCredits, 5.901);
  assert.ok(plan.reservedCredits <= 5.901);
  assert.ok(plan.maxOutputTokens >= plan.outputEnvelope.minimumUsefulOutputTokens);
});

test("14S small targeted repairs do not reserve the nominal 10k output allowance", () => {
  const envelope = repairOutputEnvelope({ requestedMaxOutputTokens: 10_000,
    retrievedFileCount: 1, retrievalTokens: 2_000, problemCount: 1 });
  assert.ok(envelope.plannedOutputTokens >= envelope.minimumUsefulOutputTokens);
  assert.ok(envelope.plannedOutputTokens < 10_000);
});

test("14S configured call ceiling still caps a repair below larger build headroom", () => {
  const plan = planCallReservation(options, "gpt-5.5", {
    requestedMaxOutputTokens: 10_000, callCeilingCredits: 2.75, repairSizing,
    budget: { approvedCeilingCredits: 12, consumedCredits: 1, reservedCredits: 0, remainingCredits: 11 },
  });
  assert.equal(plan.effectiveCallCeilingCredits, 2.75);
  assert.ok(plan.reservedCredits <= 2.75);
});

test("14S genuinely insufficient headroom rejects before dispatch", () => {
  assert.throws(() => planCallReservation(options, "gpt-5.5", {
    requestedMaxOutputTokens: 10_000, callCeilingCredits: 6, repairSizing,
    budget: { approvedCeilingCredits: 12, consumedCredits: 11.8, reservedCredits: 0, remainingCredits: 0.2 },
  }), (error) => error.code === "budget_ceiling"
    && error.maximumFittingOutputTokens < error.minimumUsefulOutputTokens);
});

test("14S durable authority never permits spend plus holds past the approved build ceiling", async () => {
  const reservations = memoryModelReservations();
  const common = { owner: "owner", projectId: "project", buildId: "build", provider: "codex",
    model: "gpt-5.5", billingLane: "connected_allowance", ceilingCredits: 12,
    accountAvailableCredits: null };
  const core = await reservations.reserve({ ...common, callKey: "core", step: "core", reservedCredits: 6 });
  await reservations.settle("owner", core.id, { actualCredits: 5.5, usage: { input: 30_000, output: 25_000 } });
  await reservations.reserve({ ...common, callKey: "held", step: "repair", reservedCredits: 5 });
  await assert.rejects(reservations.reserve({ ...common, callKey: "overflow", step: "repair",
    reservedCredits: 1.5001 }), (error) => error.code === "budget_ceiling");
});

test("14S cancellation returns every unused repair hold", async () => {
  const reservations = memoryModelReservations();
  const common = { owner: "owner", projectId: "project", buildId: "build", provider: "codex",
    model: "gpt-5.5", billingLane: "connected_allowance", ceilingCredits: 12,
    accountAvailableCredits: null };
  const hold = await reservations.reserve({ ...common, callKey: "repair", step: "repair", reservedCredits: 5.5 });
  assert.equal((await reservations.budget("owner", "build", 12)).remainingCredits, 6.5);
  await reservations.release("owner", hold.id);
  assert.equal((await reservations.budget("owner", "build", 12)).remainingCredits, 12);
});

test("14S planning is conservative while cached and uncached usage reconcile at canonical prices", () => {
  const reserved = conservativeCallReservation(options, "gpt-5.5", { maxOutputTokens: 3_000 });
  const uncached = creditsForUsage({ model: "gpt-5.5",
    usage: { input: 8_000, cached: 0, output: 3_000 } });
  const cached = creditsForUsage({ model: "gpt-5.5",
    usage: { input: 8_000, cached: 6_000, output: 3_000 } });
  assert.ok(reserved >= uncached);
  assert.ok(cached < uncached);
});
