import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  assertQueuedProviderSelection, defaultUsageResponsibilityFor, journeyRequiresPersistentMutation,
  prepareBuilderV2PipelineAttempt,
  verificationVisitorScopeForJourney,
} from "../../shell/server/lib/builderV2/runtimeComposition.mjs";
import { verificationExecutionContract } from "../../shell/server/lib/builderV2/orchestrator.mjs";
import { VERIFICATION_CACHE_VERSION } from "../../shell/server/lib/builderV2/verification.mjs";
import { serialiseWorkerFailure } from "../../build-worker/queue.mjs";

test("V2 runtime distinguishes persistent journeys from read-only navigation", () => {
  assert.equal(journeyRequiresPersistentMutation({
    title: "Book a slot", steps: [{ action: "Confirm booking", expect: "Confirmation appears" }],
  }), true);
  assert.equal(journeyRequiresPersistentMutation({
    title: "Browse services", steps: [{ action: "Open pricing", expect: "Pricing is visible" }],
  }), false);

  const journey = { id: "submit", title: "Submit a local form", steps: [{ action: "Submit", expect: "Confirmation appears" }] };
  assert.equal(journeyRequiresPersistentMutation(journey, { capabilityGraph: {
    operationResponsibilities: [{ journeyId: "submit", responsibilities: [
      { type: "custom_functional", capabilityMethod: null },
    ] }],
  } }), false, "submit prose cannot override structured local-state authority");
  assert.equal(journeyRequiresPersistentMutation(journey, { capabilityGraph: {
    operationResponsibilities: [{ journeyId: "submit", responsibilities: [
      { type: "persistence", capabilityMethod: "create" },
    ] }],
  } }), true, "a declared durable mutation still requires independent row evidence");
});

test("verification visitor identity follows independent and producer-consumer scenarios", () => {
  const contract = { prerequisiteInteractionContract: {
    scenarios: {
      reserve: { role: "produces", lifecycle: "booking:booking", scenario: "booking:booking" },
      recover: { role: "consumes", lifecycle: "booking:booking", scenario: "booking:booking" },
      capacity: { role: "independent", scenario: "independent:capacity", startState: "fresh" },
      contact: { role: "independent", scenario: "independent:contact", startState: "fresh" },
    },
    flows: [],
  } };
  const scope = (id, round = "round-1") => verificationVisitorScopeForJourney(round, { id }, contract);
  assert.equal(scope("reserve"), scope("recover"),
    "a consumer recovers the visitor that produced its durable record");
  assert.notEqual(scope("capacity"), scope("reserve"),
    "an independent journey cannot inherit a producer's terminal state");
  assert.notEqual(scope("capacity"), scope("contact"),
    "independent journeys cannot contaminate one another");
  assert.notEqual(scope("reserve", "round-1"), scope("reserve", "round-2"),
    "a later candidate cannot inherit a prior verification round");
});

test("historical contracts group only journeys with the same durable lifecycle", () => {
  const contract = { prerequisiteInteractionContract: { flows: [
    { journeyId: "create", durableLifecycle: "crud:lead" },
    { journeyId: "update", durableLifecycle: "crud:lead" },
    { journeyId: "browse" },
  ] } };
  const scope = (id) => verificationVisitorScopeForJourney("round", { id }, contract);
  assert.equal(scope("create"), scope("update"));
  assert.notEqual(scope("browse"), scope("create"));
});

test("V2 runtime requires app-scoped row evidence and persists it with cached verdicts", async () => {
  const [runtime, verification] = await Promise.all([
    readFile(new URL("../../shell/server/lib/builderV2/runtimeComposition.mjs", import.meta.url), "utf8"),
    readFile(new URL("../../shell/server/lib/builderV2/verification.mjs", import.meta.url), "utf8"),
  ]);
  assert.match(runtime, /\.eq\("app_id", String\(projectId\)\)/);
  assert.match(runtime, /\.in\("owner", userIds\)/);
  assert.match(runtime, /browser journey passed without a corresponding app-scoped database mutation/);
  assert.match(runtime, /preview\.mode !== "vps"/);
  assert.match(runtime, /contract: \{ \.\.\.journeyContract, journeys: \[journey\]/,
    "the browser worker receives the machine-readable contract rather than English journeys alone");
  assert.match(runtime, /scopeInteractionContract\(journeyContract\?\.interactionContract, \[journey\]\)/);
  assert.match(runtime, /prerequisiteInteractionContract: journeyContract\?\.prerequisiteInteractionContract/,
    "isolated journey verification preserves the full prerequisite contract across differential cache scoping");
  assert.match(runtime, /allJourneys: journeyContract\?\.allJourneys/);
  assert.match(runtime, /createVerificationIdentity\(\{/,
    "every repeat verification recovers a server-sealed project/journey test identity");
  assert.match(runtime, /secret: process\.env\.SUPABASE_SERVICE_ROLE_KEY \|\| process\.env\.SUPABASE_SERVICE_ROLE/);
  assert.match(runtime, /verifierDefects\.push/,
    "sandbox verifier defects must reach the orchestrator instead of being dropped at composition");
  assert.match(runtime, /sandboxCompatibility\.sandboxVerifier \|\| "in-process"/);
  assert.match(runtime, /sandboxCompatibility\.hostCommit \|\| VERIFICATION_CACHE_VERSION/,
    "passing evidence is keyed by the proven sandbox verifier and deployed orchestration revision");
  assert.match(verification, /backendEvidence: outcome\.backendEvidence \|\| null/);
  assert.match(runtime, /mode === "resume_verify"[\s\S]*runVerifyFromCheckpoint/,
    "checkpoint verification must resume directly from immutable V2 state");
  assert.doesNotMatch(runtime, /adoptLegacyTree|projects\.tree/,
    "checkpoint verification must not require legacy project-tree adoption");
});

test("V2 differential verification retains primary prerequisites when only a red secondary is driven", () => {
  const primary = { id: "create-asset", priority: "primary", steps: [] };
  const cached = { id: "responsive-layout", priority: "secondary", steps: [] };
  const red = { id: "edit-saved-asset", priority: "secondary", steps: [] };
  const primaryFlow = { id: "create:auth", journeyId: primary.id, kind: "flow_start",
    control: { accessibleName: "account form" } };
  const cachedFlow = { id: "responsive:resize", journeyId: cached.id, kind: "action",
    control: { accessibleName: "mobile viewport" } };
  const redFlow = { id: "edit:open", journeyId: red.id, kind: "flow_start",
    control: { accessibleName: "history item" } };
  const contract = {
    journeys: [primary, cached, red],
    interactionContract: { flows: [primaryFlow, cachedFlow, redFlow] },
  };

  const execution = verificationExecutionContract(contract, contract.journeys, [{ journey: red }]);
  assert.deepEqual(execution.allJourneys.map((journey) => journey.id),
    [primary.id, cached.id, red.id]);
  assert.deepEqual(execution.prerequisiteInteractionContract.flows,
    [primaryFlow, cachedFlow, redFlow], "the primary setup graph is retained even though its PASS was cached");
  assert.deepEqual(execution.interactionContract.flows, [redFlow],
    "the browser still drives only the red differential subset");
  assert.match(VERIFICATION_CACHE_VERSION, /^journey-verifier\/2026-08-25\./);
});

test("worker failures retain Error messages after classification", () => {
  const failure = Object.assign(new Error("project has no verified source tree to adopt"), {
    retryable: false,
  });
  assert.deepEqual(serialiseWorkerFailure(failure, "worker_error"), {
    classification: "worker_error",
    message: "project has no verified source tree to adopt",
    retryable: false,
    code: "worker_error",
    action: "stop",
    providerCallMade: null,
    reservationState: null,
    checkpointId: null,
    customerActionRequired: false,
    customerMessageKey: null,
    internalDetail: "project has no verified source tree to adopt",
  });
});

test("V2 refuses a queued job if its provider or billing lane changed before dispatch", () => {
  const expected = { provider: "codex", billingLane: "connected_allowance" };
  assert.doesNotThrow(() => assertQueuedProviderSelection(expected, {
    byok: true, policy: { primaryProvider: "codex", billingLane: "connected_allowance" },
  }));
  assert.throws(() => assertQueuedProviderSelection(expected, {
    byok: false, policy: { primaryProvider: "managed", billingLane: "managed" },
  }), (error) => error.code === "provider_selection_changed");
});

test("V2 crash recovery restarts only before provider dispatch", async () => {
  const calls = [];
  const retryPayload = {
    pipelineVersion: "v2", mode: "resume_repair",
    input: { sourceBuildId: "source-build", prompt: "resume" },
    checkpointId: "checkpoint-7", logicalDispatchId: "dispatch-7", continuationIndex: 2,
    usageResponsibility: "platform_failure",
  };
  const client = { rpc: async (name, args) => {
    calls.push({ name, args });
    return { data: { action: "restart_before_provider", abandonedBuildId: "old-build", payload: retryPayload }, error: null };
  } };
  const workJob = {
    id: "work", owner: "owner", build_id: "public", attempts: 2,
    payload: { pipelineVersion: "v2", usageResponsibility: "customer_request" },
  };
  assert.deepEqual(await prepareBuilderV2PipelineAttempt(workJob, { client }), {
    action: "restart_before_provider", abandonedBuildId: "old-build", payload: retryPayload,
  });
  assert.equal(workJob.payload, retryPayload, "the active lease adopts the payload reconciled by the RPC");
  assert.equal(workJob.payload.input.sourceBuildId, "source-build");
  assert.equal(workJob.payload.checkpointId, "checkpoint-7");
  assert.equal(workJob.payload.logicalDispatchId, "dispatch-7");
  assert.equal(workJob.payload.continuationIndex, 2);
  assert.equal(calls[0].name, "prepare_bv2_pipeline_retry");
});

test("qualification trigger metadata does not move customer generation into a platform funding pool", () => {
  assert.equal(defaultUsageResponsibilityFor({ trigger: "bv2_release_qualification" }), "customer_request");
  assert.equal(defaultUsageResponsibilityFor({
    trigger: "internal", usageResponsibility: "qualification",
  }), "qualification");
  assert.equal(defaultUsageResponsibilityFor({
    trigger: "internal", usageResponsibility: "platform_failure",
  }), "platform_failure");
});

test("V2 crash recovery returns durable completion and blocks provider ambiguity", async () => {
  const completed = await prepareBuilderV2PipelineAttempt({
    id: "work", owner: "owner", build_id: "public", attempts: 2,
  }, { client: { rpc: async () => ({ data: {
    action: "recovered", result: { buildOk: true, _worker: { bv2: { state: "green" } } },
  }, error: null }) } });
  assert.equal(completed.action, "recovered");
  assert.equal(completed.outcome.result.buildOk, true);
  assert.equal(completed.outcome.bv2.state, "green");

  await assert.rejects(() => prepareBuilderV2PipelineAttempt({
    id: "work", owner: "owner", build_id: "public", attempts: 2,
  }, { client: { rpc: async () => ({ data: {
    action: "provider_replay_unsafe", reservationCount: 1, reservationStates: { held: 1 },
  }, error: null }) } }), (error) => error.code === "provider_replay_unsafe" && error.retryable === false);
});

test("V2 crash retry RPC is service-only and serialises against public build state", async () => {
  const sql = await readFile(new URL("../../supabase/migrations/20260807221000_bv2_runtime_composition.sql", import.meta.url), "utf8");
  assert.match(sql, /create or replace function public\.prepare_bv2_pipeline_retry/);
  assert.match(sql, /from public\.build_jobs b[\s\S]*for update/i);
  assert.match(sql, /from public\.bv2_model_reservations/);
  assert.match(sql, /v_reservation_count > 0[\s\S]*provider_replay_unsafe/i);
  assert.match(sql, /revoke execute on function public\.prepare_bv2_pipeline_retry\(uuid, uuid, uuid\)[\s\S]*public, anon, authenticated/i);
});

test("V2 crash retry uses the canonical durable work payload and fails closed without it", async () => {
  const sql = await readFile(new URL(
    "../../supabase/migrations/20260822223523_fix_bv2_pipeline_retry_durable_payload.sql",
    import.meta.url,
  ), "utf8");
  assert.match(sql, /from public\.build_work_jobs j[\s\S]*from public\.build_work_payloads p[\s\S]*v_work\.payload_ref/i);
  assert.match(sql, /from public\.build_work_payloads p[\s\S]*p\.id = v_work\.payload_ref/i);
  assert.match(sql, /update public\.build_work_payloads set[\s\S]*payload_sha256 = v_payload_sha256/i);
  assert.doesNotMatch(sql, /update public\.build_work_jobs set\s+payload/i);
  assert.match(sql, /pg_advisory_xact_lock\(hashtextextended\('bv2-model:' \|\| p_owner::text, 0\)\)/i);
  assert.match(sql, /'action', 'retry_state_missing'[\s\S]*'code', 'durable_retry_state_missing'/i);

  await assert.rejects(() => prepareBuilderV2PipelineAttempt({
    id: "work", owner: "owner", build_id: "public", attempts: 2, payload: { pipelineVersion: "v2" },
  }, { client: { rpc: async () => ({ data: {
    action: "retry_state_missing", code: "durable_retry_state_missing", reason: "payload_missing",
  }, error: null }) } }), (error) => error.code === "durable_retry_state_missing"
    && error.recovery.reason === "payload_missing" && error.retryable === false);
});
