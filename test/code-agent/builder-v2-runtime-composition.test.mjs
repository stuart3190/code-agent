import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  assertQueuedProviderSelection, journeyRequiresPersistentMutation, prepareBuilderV2PipelineAttempt,
} from "../../shell/server/lib/builderV2/runtimeComposition.mjs";
import { serialiseWorkerFailure } from "../../build-worker/queue.mjs";

test("V2 runtime distinguishes persistent journeys from read-only navigation", () => {
  assert.equal(journeyRequiresPersistentMutation({
    title: "Book a slot", steps: [{ action: "Confirm booking", expect: "Confirmation appears" }],
  }), true);
  assert.equal(journeyRequiresPersistentMutation({
    title: "Browse services", steps: [{ action: "Open pricing", expect: "Pricing is visible" }],
  }), false);
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
  assert.match(runtime, /prerequisiteInteractionContract: journeyContract\?\.interactionContract/,
    "isolated journey verification retains the full contract needed to reconstruct prerequisites");
  assert.match(runtime, /allJourneys: journeyContract\?\.journeys/);
  assert.match(verification, /backendEvidence: outcome\.backendEvidence \|\| null/);
  assert.match(runtime, /mode === "resume_verify"[\s\S]*runVerifyFromCheckpoint/,
    "checkpoint verification must resume directly from immutable V2 state");
  assert.doesNotMatch(runtime, /adoptLegacyTree|projects\.tree/,
    "checkpoint verification must not require legacy project-tree adoption");
});

test("worker failures retain Error messages after classification", () => {
  const failure = Object.assign(new Error("project has no verified source tree to adopt"), {
    retryable: false,
  });
  assert.deepEqual(serialiseWorkerFailure(failure, "worker_error"), {
    classification: "worker_error",
    message: "project has no verified source tree to adopt",
    retryable: false,
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
  const client = { rpc: async (name, args) => {
    calls.push({ name, args });
    return { data: { action: "restart_before_provider", abandonedBuildId: "old-build" }, error: null };
  } };
  assert.deepEqual(await prepareBuilderV2PipelineAttempt({
    id: "work", owner: "owner", build_id: "public", attempts: 2,
  }, { client }), { action: "restart_before_provider", abandonedBuildId: "old-build" });
  assert.equal(calls[0].name, "prepare_bv2_pipeline_retry");
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
