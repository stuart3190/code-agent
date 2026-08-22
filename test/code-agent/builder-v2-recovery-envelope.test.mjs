import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  BUILD_ENVELOPE_VERSION, FUNDING_POOL, contractRuntimeRequirements,
  createEnvelopeProgressGuard, deriveBuildEnvelope, envelopePoolCeiling, memoryBuildEnvelopes,
} from "../../shell/server/lib/builderV2/buildEnvelope.mjs";
import { customerBuildStatus, customerFailureMessage, structuredBuildFailure }
  from "../../shell/server/lib/builderV2/buildFailure.mjs";
import { memoryBuildSettlements } from "../../shell/server/lib/builderV2/buildSettlement.mjs";
import { memoryModelReservations } from "../../shell/server/lib/builderV2/modelReservations.mjs";
import { verificationDefectRecords } from "../../shell/server/lib/builderV2/verificationDefects.mjs";

const staticContract = {
  summary: "A marketing site without accounts or checkout",
  journeys: [{ id: "browse", title: "Browse information", owners: ["src/App.jsx"],
    steps: [{ action: "navigate", target: "pricing", expect: "pricing is visible" }] }],
  entities: [], capabilities: [], interactionContract: { flows: [] },
};

const crudContract = {
  summary: "A customer account task manager",
  journeys: Array.from({ length: 4 }, (_, index) => ({
    id: `journey-${index + 1}`, title: index ? "Update a saved task" : "Sign up for an account",
    owners: ["src/App.jsx", `src/features/Task${index + 1}.jsx`],
    steps: [
      { action: index ? "update" : "sign up", target: "task", expect: "saved state" },
      { action: "reload", target: "page", expect: "saved task remains" },
    ],
  })),
  entities: [{ name: "task" }], capabilities: ["auth", "durable mutation"],
  interactionContract: { flows: [] },
};

test("validated contracts receive immutable independent generation, recovery, and duration envelopes", async () => {
  const basic = deriveBuildEnvelope({ contract: staticContract, approvedCustomerCredits: 20, profile: "simple" });
  const complex = deriveBuildEnvelope({ contract: crudContract, approvedCustomerCredits: 100, profile: "advanced",
    measuredP95Ms: 1_000_000, measuredSampleCount: 20 });
  assert.equal(basic.version, BUILD_ENVELOPE_VERSION);
  assert.equal(basic.runtimeRequirements.accounts, false);
  assert.equal(basic.runtimeRequirements.durableMutation, false);
  assert.deepEqual(contractRuntimeRequirements(crudContract), { accounts: true, durableMutation: true });
  assert.deepEqual(contractRuntimeRequirements({ auth: { required: false }, entities: [],
    capabilities: ["No authentication or database"], journeys: [{ id: "public", steps: [
      { action: "navigate", expect: "pricing is visible without an account" },
    ] }] }), { accounts: false, durableMutation: false });
  assert.ok(complex.customerGeneration.plannedCredits > basic.customerGeneration.plannedCredits);
  assert.ok(complex.thralloRecovery.approvedCredits > basic.thralloRecovery.approvedCredits);
  assert.ok(complex.thralloRecovery.strategyCapacity > basic.thralloRecovery.strategyCapacity);
  assert.equal(complex.execution.softTargetDurationMs, 1_200_000);
  assert.equal(complex.execution.hardSafetyDurationMs, complex.execution.expectedDurationMs * 3);
  assert.equal(new Set(complex.stages.filter((stage) => stage.estimatedCredits > 0)
    .map((stage) => stage.fundingSource)).has(FUNDING_POOL.RECOVERY), false);

  const store = memoryBuildEnvelopes();
  await store.create({ owner: "owner", projectId: "project", buildId: "build", envelope: basic });
  await assert.rejects(store.create({ owner: "owner", projectId: "project", buildId: "build",
    envelope: complex }), (error) => error.code === "build_envelope_identity_conflict");
});

test("exceptional recovery increases require a durable actor, reason, allowance, and expiry", async () => {
  const envelope = deriveBuildEnvelope({ contract: staticContract, approvedCustomerCredits: 20 });
  const store = memoryBuildEnvelopes();
  await store.create({ owner: "owner", projectId: "project", buildId: "build", envelope });
  await assert.rejects(store.approveRecovery({ owner: "owner", buildId: "build",
    actor: "", reason: "", additionalAllowance: 4 }));
  const approval = await store.approveRecovery({ owner: "owner", buildId: "build",
    actor: "operator-1", reason: "new causal owner proven", additionalAllowance: 4,
    expiresAt: "2030-01-01T00:00:00.000Z" });
  const current = await store.get("owner", "build");
  assert.equal(approval.previousCeiling, envelope.thralloRecovery.approvedCredits);
  assert.equal(envelopePoolCeiling(current.envelope, FUNDING_POOL.RECOVERY),
    envelope.thralloRecovery.approvedCredits + 4);
});

test("the contract-derived 3x guard pauses before dispatch and keeps customer action false", async () => {
  const envelope = deriveBuildEnvelope({ contract: staticContract, approvedCustomerCredits: 20,
    startedAt: "2026-01-01T00:00:00.000Z" });
  const store = memoryBuildEnvelopes();
  await store.create({ owner: "owner", projectId: "project", buildId: "build", envelope });
  const guard = createEnvelopeProgressGuard({ envelopeStore: store,
    now: () => Date.parse("2027-01-01T00:00:00.000Z") });
  await assert.rejects(guard.beforeDispatch("owner", "build"), (error) => (
    error.code === "internal_extension_required" && error.providerCallMade === false
      && error.customerActionRequired === false
  ));
});

test("an internal duration extension is durable and revises the safety boundary without customer approval", async () => {
  const envelope = deriveBuildEnvelope({ contract: staticContract, approvedCustomerCredits: 20 });
  const store = memoryBuildEnvelopes();
  await store.create({ owner: "owner", projectId: "project", buildId: "build", envelope });
  await assert.rejects(store.approveDurationExtension({ owner: "owner", buildId: "build",
    actor: "operator", reason: "", revisedExpectedDurationMs: envelope.execution.expectedDurationMs * 2 }));
  const revised = envelope.execution.expectedDurationMs * 2;
  await store.approveDurationExtension({ owner: "owner", buildId: "build",
    actor: "operator", reason: "durable progress continues", revisedExpectedDurationMs: revised,
    expiresAt: "2030-01-01T00:00:00.000Z" });
  const current = await store.get("owner", "build");
  assert.equal(current.envelope.execution.expectedDurationMs, revised);
  assert.equal(current.envelope.execution.hardSafetyDurationMs, revised * 3);
  assert.equal(current.envelope.execution.internalExtension.reason, "durable progress continues");
});

test("BYOK generation and managed recovery settle into isolated pools and compensate only planned usage", async () => {
  const reservations = memoryModelReservations();
  const base = { owner: "owner", projectId: "project", buildId: "build", maxRepairs: 10, maxCorrections: 10 };
  const customer = await reservations.reserve({ ...base, callKey: "customer-1", step: "core",
    provider: "anthropic", model: "claude", billingLane: "byok_api", reservedCredits: 5,
    ceilingCredits: 20, usageResponsibility: "customer_request", fundingPool: FUNDING_POOL.CUSTOMER,
    logicalDispatchId: "core:1", continuationIndex: 0 });
  await reservations.settle("owner", customer.id, { actualCredits: 3, providerRequestIds: ["customer-request"] });
  const recovery = await reservations.reserve({ ...base, callKey: "recovery-1", step: "repair",
    provider: "openai", model: "gpt", billingLane: "managed", reservedCredits: 4,
    ceilingCredits: 10, usageResponsibility: "thrallo_repair", fundingPool: FUNDING_POOL.RECOVERY,
    logicalDispatchId: "repair:1", continuationIndex: 0 });
  await reservations.settle("owner", recovery.id, { actualCredits: 2, providerRequestIds: ["recovery-request"] });
  assert.equal((await reservations.budget("owner", "build", 20, FUNDING_POOL.CUSTOMER)).consumedCredits, 3);
  assert.equal((await reservations.budget("owner", "build", 10, FUNDING_POOL.RECOVERY)).consumedCredits, 2);

  const settlements = memoryBuildSettlements({ reservations });
  const settled = await settlements.settle({ owner: "owner", buildId: "build", terminalState: "failed",
    failureClassification: "generated_app", greenPreview: false, compensationEligible: true });
  assert.equal(settled.managedRefundCredits, 0);
  assert.equal(settled.serviceCreditCredits, 3);
  assert.equal((await settlements.settle({ owner: "owner", buildId: "build", terminalState: "failed" })), settled);
});

test("durable defects retain structural identity, failure refs, and redacted state fingerprints", () => {
  const records = verificationDefectRecords([{
    code: "control_cannot_hold_value", defectClass: "interaction", owner: "app", tier: "correction",
    journeyId: "create", stepIndex: 2, action: "type title",
    control: { id: "ctl-title", logicalField: "title" },
    modules: ["src/features/TaskForm.jsx"], failureRefs: ["src/App.jsx", "src/features/TaskForm.jsx"],
    evidence: { expected: "Launch", observed: "", drove: true,
      addresssing: { reason: "identified" }, consoleErrors: ["boom"], failedRequests: ["POST /tasks"],
      entityBefore: { count: 0 }, entityAfter: { count: 0 } },
  }], { sourceTreeHash: "a".repeat(64), candidateSnapshotId: null });
  assert.equal(records[0].version, 1);
  assert.equal(records[0].controlIdentity.id, "ctl-title");
  assert.deepEqual(records[0].failureRefs, ["src/App.jsx", "src/features/TaskForm.jsx"]);
  assert.equal(records[0].consoleFingerprint.length, 64);
  assert.equal(records[0].requestFingerprint.length, 64);
});

test("customer status and messages never expose internal Builder evidence", () => {
  const failure = structuredBuildFailure(Object.assign(new Error("src/App.jsx provider request req_123"), {
    code: "verification_platform_defect", classification: "platform",
  }));
  const status = customerBuildStatus({ internalState: "blocked", failure });
  const message = customerFailureMessage(failure);
  assert.equal(status.state, "failed");
  assert.equal(status.creditsProtected, true);
  assert.doesNotMatch(JSON.stringify({ status, message }), /src\/|req_123|verifier/i);
});

test("the additive migration enforces managed-only recovery and idempotent terminal settlement", async () => {
  const sql = await readFile(new URL("../../supabase/migrations/20260822160000_bv2_contract_envelopes_recovery_settlement.sql", import.meta.url), "utf8");
  assert.match(sql, /p_funding_pool='thrallo_recovery'.*p_billing_lane<>'managed'/s);
  assert.match(sql, /unique\(owner,build_id\)/);
  assert.match(sql, /on conflict\(owner,ref,kind,bucket\) do nothing/g);
  assert.match(sql, /funding_pool='customer_generation'.*usage_responsibility='customer_request'/s);
  assert.match(sql, /billing_lane in \('byok_api','connected_allowance'\)/);
  assert.match(sql, /p_event_type not in \('progress','stdout','stderr','structured_failure'\)/);
  assert.match(sql, /build_work_events_type_check check \([\s\S]*'structured_failure'/);
});
