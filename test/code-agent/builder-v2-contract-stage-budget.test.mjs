// THE CONTRACT STAGE IS FUNDED AS ONE WORKFLOW.
//
// Live sequence reproduced here: recessed-light rerun 7e74b401 (2026-09-18, medium, 30 customer
// credits, 3.5 preliminary recovery credits). Attempt 1 (customer): 3,996 in / 12,010 out =
// 1.6006 credits, rejected by the validator (an undeclared operated field). Protocol correction
// (Thrallo recovery): 11,917 in / 12,360 out = 2.4277 credits, a contract that reached the gate.
// The gate rejected it and the repair found 1.07 recovery credits - less than its input alone.
// With the resolver fix (c341be5) the same contract passes the gate; this suite proves the budget
// policy would have kept a repair affordable either way, and that no call is made whose follow-up
// could not be funded. No provider is contacted: every turn is a scripted reply with live usage.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  createModelLanes, conservativeCallReservation, contractWorkflowReservation,
} from "../../shell/server/lib/builderV2/modelLanes.mjs";
import { memoryModelReservations } from "../../shell/server/lib/builderV2/modelReservations.mjs";
import { memoryKnowledgeStore } from "../../shell/server/lib/builderV2/knowledge.mjs";
import { stepOutputPolicy } from "../../shell/server/lib/builderV2/runtimeComposition.mjs";
import {
  contractWorkflowRecoveryAuthority, CONTRACT_WORKFLOW_PHASE, CONTRACT_GATE_REPAIR_OUTPUT_TOKENS,
  CONTRACT_WORKFLOW_CEILING_MULTIPLIER,
} from "../../shell/server/lib/builderV2/contractStageBudget.mjs";
import { FUNDING_POOL } from "../../shell/server/lib/builderV2/buildEnvelope.mjs";
import { deriveBuildSpec } from "../../shell/server/lib/builderV2/buildSpec.mjs";
import { validateContract } from "../../shell/shared/implementationContract.mjs";
import { creditsForUsage } from "../../src/billing/costModel.mjs";

const RETAINED = new URL("./fixtures/retained/medium-20260918-recessed/", import.meta.url);
const POLICY = stepOutputPolicy("contract", { profile: "medium" });
const MODEL = "gpt-5.5";
const CUSTOMER_CREDITS = 30;
// runtimeComposition: Math.max(3, 1.5 + 2) for a medium request before any envelope exists.
const PRELIMINARY_MEDIUM = 3.5;
const LIVE = {
  attempt1: { input: 3996, output: 12010, reasoning: 490, total: 16006 },
  correction: { input: 11917, output: 12360, reasoning: 382, total: 24277 },
  // The largest gate repair in the 30-day ledger (8,975 in / 4,798 out).
  repair: { input: 8975, output: 4798, reasoning: 0, total: 13773 },
};
const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 0.0005, `${message}: ${actual} vs ${expected}`);

async function fixtures() {
  const contract = JSON.parse(await readFile(new URL("contract-7e74b401-attempt2.json", RETAINED), "utf8"));
  const request = (await readFile(new URL("request.txt", RETAINED), "utf8")).trim();
  const rejected = structuredClone(contract);
  const journey = rejected.journeys.find((row) => row.id === "design-and-estimate-project");
  journey.steps[12].operates = ["catalogueQuery", "search-products"];
  journey.steps[12].verificationValues = { catalogueQuery: "Aurora" };
  assert.equal(validateContract(rejected).ok, false, "attempt 1 is rejected before it can be judged");
  assert.equal(validateContract(contract).ok, true);
  return { contract, rejected, request };
}

const reply = (text, usage) => ({ text, usage });

function harness({ replies, preliminaryRecoveryCredits = PRELIMINARY_MEDIUM, customerCredits = CUSTOMER_CREDITS }) {
  const reservations = memoryModelReservations();
  const authorities = [];
  const logs = [];
  let calls = 0;
  const provider = {
    model: MODEL, providerId: "codex", provider: "codex",
    runTurn: async (options) => {
      const scripted = replies[calls];
      calls += 1;
      if (!scripted) throw new Error(`no scripted reply for provider call ${calls}`);
      if (typeof scripted === "function") return scripted(options, calls);
      return { text: scripted.text, toolCalls: [], usage: { ...scripted.usage, providerRequestId: `req-${calls}` } };
    },
  };
  const lanes = createModelLanes({
    providerForStep: async ({ recoveryDispatch }) => ({
      provider,
      decision: {
        provider: "codex", model: MODEL, billingLane: "connected_allowance", taskClass: "contract",
        estimatedCredits: POLICY.estimatedCredits, callCeilingCredits: POLICY.callCeilingCredits,
        maxOutputTokens: POLICY.maxOutputTokens,
        fundingPolicy: recoveryDispatch ? "thrallo_recovery" : "request_owner",
        usageResponsibility: recoveryDispatch ? "thrallo_repair" : "customer_request",
      },
    }),
    ceilingCredits: customerCredits, reservations, knowledgeStore: memoryKnowledgeStore(),
    log: (line) => logs.push(String(line)),
    // The production resolver (runtimeComposition) delegates the pre-envelope recovery pool to this
    // same authority; the customer pool is its approved ceiling.
    poolCeilingResolver: async ({ fundingPool, context }) => {
      if (fundingPool !== FUNDING_POOL.RECOVERY) return customerCredits;
      const authority = contractWorkflowRecoveryAuthority({ preliminaryRecoveryCredits, context });
      authorities.push({ ...authority, providerCallsBefore: calls });
      return authority;
    },
  });
  const budget = (pool, ceiling) => reservations.budget("owner", "build", ceiling, pool);
  return { lanes, reservations, authorities, logs, budget, calls: () => calls };
}

const runContract = (lanes, request, extra = {}) => lanes.contractFn({ owner: "owner", projectId: "project", buildId: "build", request, ...extra });

test("the recovery authority protects a gate-repair reserve for a protocol correction and bounds the raised ceiling", () => {
  const bare = contractWorkflowRecoveryAuthority({ preliminaryRecoveryCredits: 3.5, context: { step: "correction" } });
  assert.deepEqual(bare, { ceilingCredits: 3.5, completionReserveCredits: 0, workflowPhase: null });
  const correction = contractWorkflowRecoveryAuthority({ preliminaryRecoveryCredits: 3.5, context: {
    workflowPhase: CONTRACT_WORKFLOW_PHASE.PROTOCOL_CORRECTION, contractWorkflowCredits: 4.2, gateRepairReserveCredits: 1.7,
  } });
  assert.equal(correction.ceilingCredits, 4.2, "the ceiling grows to what the workflow needs");
  assert.equal(correction.completionReserveCredits, 1.7);
  const capped = contractWorkflowRecoveryAuthority({ preliminaryRecoveryCredits: 3.5, context: {
    workflowPhase: CONTRACT_WORKFLOW_PHASE.PROTOCOL_CORRECTION, contractWorkflowCredits: 40, gateRepairReserveCredits: 1.7,
  } });
  assert.equal(capped.ceilingCredits, 3.5 * CONTRACT_WORKFLOW_CEILING_MULTIPLIER, "never an unbounded platform allowance");
  const repair = contractWorkflowRecoveryAuthority({ preliminaryRecoveryCredits: 3.5, context: {
    workflowPhase: CONTRACT_WORKFLOW_PHASE.GATE_REPAIR, contractWorkflowCredits: 4.2,
  } });
  assert.equal(repair.ceilingCredits, 4.2, "the repair sees the same raised ceiling");
  assert.equal(repair.completionReserveCredits, 0, "the repair itself is what was protected");
  const small = contractWorkflowRecoveryAuthority({ preliminaryRecoveryCredits: 6, context: {
    workflowPhase: CONTRACT_WORKFLOW_PHASE.PROTOCOL_CORRECTION, contractWorkflowCredits: 4.2, gateRepairReserveCredits: 1.7,
  } });
  assert.equal(small.ceilingCredits, 6, "an already-sufficient preliminary pool is not raised");
});

test("the live 7e74b401 sequence: attempt 1 spends what it spent, the correction is admitted beside a protected repair reserve, and a repair stays affordable", async () => {
  const { contract, rejected, request } = await fixtures();
  const h = harness({ replies: [reply(JSON.stringify(rejected), LIVE.attempt1), reply(JSON.stringify(contract), LIVE.correction)] });
  const produced = await runContract(h.lanes, request);
  assert.equal(h.calls(), 2);
  assert.ok(h.logs.some((line) => /attempt 1 rejected/.test(line)), h.logs.join("\n"));

  const [first, correction] = h.reservations.rows();
  // 1. attempt 1 consumed the observed amount, customer-funded.
  assert.equal(first.fundingPool, FUNDING_POOL.CUSTOMER);
  assert.equal(first.state, "settled");
  near(first.actualCredits, 1.6006, "attempt 1 actual");
  near(creditsForUsage({ model: MODEL, usage: LIVE.attempt1 }), 1.6006, "live pricing");

  // 2. the remaining stage budget was evaluated BEFORE attempt 2 was dispatched.
  const admission = h.authorities.find((row) => row.workflowPhase === CONTRACT_WORKFLOW_PHASE.PROTOCOL_CORRECTION);
  assert.ok(admission, "the correction consulted the recovery authority");
  assert.equal(admission.providerCallsBefore, 1, "evaluated after attempt 1 and before attempt 2");
  assert.ok(admission.completionReserveCredits > 1, `protected ${admission.completionReserveCredits} credits for a gate repair`);
  assert.equal(admission.completionReserveCredits, correction.metadata.completionReserveCredits);

  // 3./4. the admitted reservation leaves the configured repair reserve intact, with the full output plan.
  assert.equal(correction.fundingPool, FUNDING_POOL.RECOVERY);
  assert.equal(correction.usageResponsibility, "thrallo_repair");
  assert.equal(correction.logicalDispatchId, "build:contract_protocol_correction:1");
  assert.equal(correction.metadata.budgetPlan.maxOutputTokens, POLICY.maxOutputTokens, "a full contract turn, not a squeezed one");
  assert.ok(correction.reservedCredits + admission.completionReserveCredits <= admission.ceilingCredits + 1e-9,
    `${correction.reservedCredits} reserved + ${admission.completionReserveCredits} protected within ${admission.ceilingCredits}`);
  assert.ok(admission.ceilingCredits > PRELIMINARY_MEDIUM, "the 3.5-credit preliminary pool could not hold this workflow; it was raised");
  assert.ok(admission.ceilingCredits <= PRELIMINARY_MEDIUM * CONTRACT_WORKFLOW_CEILING_MULTIPLIER);
  near(correction.actualCredits, 2.4277, "correction actual (live)");
  assert.ok(correction.reservedCredits + 1e-9 >= correction.actualCredits, "the 12k output plan makes the reservation a real upper bound");

  // 5. a gate repair on the same wire can still reserve: the reserve survived the correction.
  const recovery = await h.budget(FUNDING_POOL.RECOVERY, admission.ceilingCredits);
  near(recovery.consumedCredits, 2.4277, "recovery consumed");
  assert.ok(recovery.remainingCredits + 1e-9 >= admission.completionReserveCredits - (correction.actualCredits - correction.reservedCredits),
    `remaining ${recovery.remainingCredits} keeps the repair reserve ${admission.completionReserveCredits}`);
  const customer = await h.budget(FUNDING_POOL.CUSTOMER, CUSTOMER_CREDITS);
  near(customer.consumedCredits, 1.6006, "customer spend is attempt 1 only");
  assert.equal(customer.reservedCredits, 0);

  // Under c341be5 this contract passes the gate: no repair is required and no reserve is spent.
  assert.equal(deriveBuildSpec(produced).verdict.ok, true, "the build would continue to core generation");
});

test("if the gate had rejected the corrected contract, the repair reserves and dispatches from the protected remainder, and every pool settles truthfully", async () => {
  const { contract, rejected, request } = await fixtures();
  const h = harness({ replies: [
    reply(JSON.stringify(rejected), LIVE.attempt1), reply(JSON.stringify(contract), LIVE.correction),
    reply(JSON.stringify(contract), LIVE.repair),
  ] });
  await runContract(h.lanes, request);
  const admission = h.authorities.find((row) => row.workflowPhase === CONTRACT_WORKFLOW_PHASE.PROTOCOL_CORRECTION);
  const repaired = await runContract(h.lanes, request, {
    priorContract: contract,
    problems: ["design-and-estimate-project:15:navigation reads state before it is produced: design-and-estimate-project.custom.projectId"],
    issues: [],
  });
  assert.equal(h.calls(), 3, "the repair was dispatched");
  assert.equal(deriveBuildSpec(repaired).verdict.ok, true);
  const repairAuthority = h.authorities.find((row) => row.workflowPhase === CONTRACT_WORKFLOW_PHASE.GATE_REPAIR);
  assert.ok(repairAuthority, "the repair consulted the recovery authority under its own phase");
  assert.ok(repairAuthority.ceilingCredits + 1e-9 >= admission.ceilingCredits, `the repair ceiling ${repairAuthority.ceilingCredits} is at least the admission ceiling ${admission.ceilingCredits}`);
  assert.equal(repairAuthority.completionReserveCredits, 0);
  const rows = h.reservations.rows();
  assert.deepEqual(rows.map((row) => [row.fundingPool, row.usageResponsibility, row.state]), [
    [FUNDING_POOL.CUSTOMER, "customer_request", "settled"],
    [FUNDING_POOL.RECOVERY, "thrallo_repair", "settled"],
    [FUNDING_POOL.RECOVERY, "thrallo_repair", "settled"],
  ]);
  near(rows[2].actualCredits, 1.3773, "repair actual (largest observed gate repair)");
  assert.ok(rows[2].reservedCredits + 1e-9 >= rows[2].actualCredits);
  // 6./8. success accounting: customer spend is attempt 1; Thrallo recovery carries correction + repair.
  near((await h.budget(FUNDING_POOL.CUSTOMER, CUSTOMER_CREDITS)).consumedCredits, 1.6006, "customer");
  near((await h.budget(FUNDING_POOL.RECOVERY, admission.ceilingCredits)).consumedCredits, 2.4277 + 1.3773, "recovery");
});

test("negative control: enough for attempt 2 alone but not for attempt 2 plus the repair reserve - the correction is refused before dispatch", async () => {
  const { rejected, request } = await fixtures();
  // A preliminary pool whose doubled cap still cannot hold correction + reserve.
  const h = harness({ replies: [reply(JSON.stringify(rejected), LIVE.attempt1), reply("never sent", LIVE.correction)], preliminaryRecoveryCredits: 1.5 });
  await assert.rejects(runContract(h.lanes, request), (error) => error.code === "recovery_completion_reserve"
    && error.fundingPool === FUNDING_POOL.RECOVERY && error.dispatchState === "before_dispatch");
  assert.equal(h.calls(), 1, "no second provider call");
  const rows = h.reservations.rows();
  assert.equal(rows.length, 1, "no recovery reservation was even held");
  assert.equal(rows[0].fundingPool, FUNDING_POOL.CUSTOMER);
  const admission = h.authorities.find((row) => row.workflowPhase === CONTRACT_WORKFLOW_PHASE.PROTOCOL_CORRECTION);
  assert.equal(admission.ceilingCredits, 1.5 * CONTRACT_WORKFLOW_CEILING_MULTIPLIER, "raised to the cap and still short");
  assert.ok(admission.workflowCredits > admission.ceilingCredits);
  near((await h.budget(FUNDING_POOL.RECOVERY, admission.ceilingCredits)).consumedCredits, 0, "Thrallo spent nothing on an unfundable workflow");
});

test("negative control: enough for both - the preliminary pool is used as is and the correction is admitted", async () => {
  const { contract, rejected, request } = await fixtures();
  const h = harness({ replies: [reply(JSON.stringify(rejected), LIVE.attempt1), reply(JSON.stringify(contract), LIVE.correction)], preliminaryRecoveryCredits: 8 });
  await runContract(h.lanes, request);
  const admission = h.authorities.find((row) => row.workflowPhase === CONTRACT_WORKFLOW_PHASE.PROTOCOL_CORRECTION);
  assert.equal(admission.ceilingCredits, 8, "not raised");
  assert.ok(admission.completionReserveCredits > 0, "still protected");
  assert.equal(h.calls(), 2);
  assert.equal(h.reservations.rows()[1].state, "settled");
});

test("negative control: the first contract is accepted immediately - one customer call, the recovery pool untouched", async () => {
  const { contract, request } = await fixtures();
  const h = harness({ replies: [reply(JSON.stringify(contract), LIVE.attempt1)] });
  await runContract(h.lanes, request);
  assert.equal(h.calls(), 1);
  assert.deepEqual(h.reservations.rows().map((row) => row.fundingPool), [FUNDING_POOL.CUSTOMER]);
  assert.equal(h.authorities.length, 0, "no recovery authority was consulted");
});

test("negative control: an exhausted recovery pool refuses the correction before dispatch", async () => {
  const { rejected, request } = await fixtures();
  const h = harness({ replies: [reply(JSON.stringify(rejected), LIVE.attempt1), reply("never sent", LIVE.correction)] });
  // Earlier Thrallo-funded work already consumed the whole pre-envelope pool (and the cap).
  const hold = await h.reservations.reserve({
    owner: "owner", projectId: "project", buildId: "build", callKey: "prior:1", step: "correction",
    provider: "codex", model: MODEL, billingLane: "connected_allowance", reservedCredits: 7, ceilingCredits: 7,
    usageResponsibility: "thrallo_repair", fundingPool: FUNDING_POOL.RECOVERY, logicalDispatchId: "build:prior:1",
  });
  await h.reservations.settle("owner", hold.id, { actualCredits: 7, usage: { input: 35_000, output: 35_000, total: 70_000 }, providerRequestIds: ["prior"] });
  await assert.rejects(runContract(h.lanes, request), (error) => ["recovery_completion_reserve", "recovery_envelope_exhausted"].includes(error.code));
  assert.equal(h.calls(), 1);
  assert.equal(h.reservations.rows().filter((row) => row.step === "contract").length, 1);
});

test("negative control: a provider failure before any usage releases the correction's hold and spends nothing", async () => {
  const { rejected, request } = await fixtures();
  const h = harness({ replies: [reply(JSON.stringify(rejected), LIVE.attempt1), () => {
    throw Object.assign(new Error("Codex HTTP 429: platform allowance unavailable"), { status: 429, dispatchState: "provider_rejected", retrySafe: true });
  }] });
  await assert.rejects(runContract(h.lanes, request), /429/);
  const rows = h.reservations.rows();
  assert.deepEqual(rows.map((row) => [row.fundingPool, row.state]), [[FUNDING_POOL.CUSTOMER, "settled"], [FUNDING_POOL.RECOVERY, "released"]]);
  const admission = h.authorities.find((row) => row.workflowPhase === CONTRACT_WORKFLOW_PHASE.PROTOCOL_CORRECTION);
  const recovery = await h.budget(FUNDING_POOL.RECOVERY, admission.ceilingCredits);
  assert.equal(recovery.consumedCredits, 0);
  assert.equal(recovery.reservedCredits, 0);
});

test("negative control: provider usage followed by failure settles the correction at its real usage", async () => {
  const { rejected, request } = await fixtures();
  const h = harness({ replies: [reply(JSON.stringify(rejected), LIVE.attempt1), () => {
    throw Object.assign(new Error("stream closed after the reply was billed"), {
      usage: { ...LIVE.correction, providerRequestId: "req-billed" }, providerRequestId: "req-billed",
    });
  }] });
  await assert.rejects(runContract(h.lanes, request));
  const rows = h.reservations.rows();
  assert.equal(rows[1].fundingPool, FUNDING_POOL.RECOVERY);
  assert.equal(rows[1].state, "settled");
  near(rows[1].actualCredits, 2.4277, "settled at the billed usage");
  const admission = h.authorities.find((row) => row.workflowPhase === CONTRACT_WORKFLOW_PHASE.PROTOCOL_CORRECTION);
  near((await h.budget(FUNDING_POOL.RECOVERY, admission.ceilingCredits)).consumedCredits, 2.4277, "recovery consumed");
});

test("terminal failure accounting: a repair that never returns a usable contract settles both of its calls and the customer pool is untouched", async () => {
  const { contract, rejected, request } = await fixtures();
  const h = harness({ replies: [
    reply(JSON.stringify(rejected), LIVE.attempt1), reply(JSON.stringify(contract), LIVE.correction),
    reply("not json", LIVE.repair), reply("still not json", LIVE.repair),
  ], preliminaryRecoveryCredits: 8 });
  await runContract(h.lanes, request);
  await assert.rejects(runContract(h.lanes, request, { priorContract: contract, problems: ["gate problem"], issues: [] }), /contract generation failed/);
  assert.equal(h.calls(), 4);
  const rows = h.reservations.rows();
  assert.deepEqual(rows.map((row) => [row.fundingPool, row.state]), [
    [FUNDING_POOL.CUSTOMER, "settled"], [FUNDING_POOL.RECOVERY, "settled"], [FUNDING_POOL.RECOVERY, "settled"], [FUNDING_POOL.RECOVERY, "settled"],
  ]);
  near((await h.budget(FUNDING_POOL.CUSTOMER, CUSTOMER_CREDITS)).consumedCredits, 1.6006, "customer");
  near((await h.budget(FUNDING_POOL.RECOVERY, 8)).consumedCredits, 2.4277 + 1.3773 + 1.3773, "recovery");
});

test("the workflow price is the planner's own arithmetic on the correction wire", () => {
  const options = { systemPrompt: "s".repeat(4_000), messages: [{ role: "user", content: "u".repeat(40_000) }] };
  const workflow = contractWorkflowReservation(options, MODEL, { maxOutputTokens: POLICY.maxOutputTokens });
  assert.equal(workflow.correctionCredits, Math.round(conservativeCallReservation(options, MODEL, { maxOutputTokens: POLICY.maxOutputTokens, inputTokens: workflow.inputTokens }) * 10_000) / 10_000);
  assert.equal(workflow.gateRepairReserveCredits, Math.round(conservativeCallReservation(options, MODEL, { maxOutputTokens: CONTRACT_GATE_REPAIR_OUTPUT_TOKENS, inputTokens: workflow.inputTokens }) * 10_000) / 10_000);
  assert.ok(workflow.workflowCredits > workflow.correctionCredits);
  assert.equal(CONTRACT_GATE_REPAIR_OUTPUT_TOKENS, 5_000);
});
