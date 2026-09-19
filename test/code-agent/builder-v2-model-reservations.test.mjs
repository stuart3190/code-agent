import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  fundingPoolFor, memoryModelReservations, modelCallKey,
} from "../../shell/server/lib/builderV2/modelReservations.mjs";

test("reservation responsibilities select the only database-valid funding pool", () => {
  assert.equal(fundingPoolFor({ usageResponsibility: "customer_request" }), "customer_generation");
  for (const usageResponsibility of ["thrallo_repair", "platform_failure", "qualification"]) {
    assert.equal(fundingPoolFor({ usageResponsibility }), "thrallo_recovery", usageResponsibility);
  }
});

const input = (overrides = {}) => ({
  owner: "owner-a", projectId: "project-a", buildId: "build-a",
  callKey: modelCallKey({ buildId: "build-a", step: "core", sequence: 1 }),
  step: "core", provider: "openai", model: "quality", billingLane: "managed",
  reservedCredits: 2, ceilingCredits: 5, accountAvailableCredits: 100, ...overrides,
});

test("V2 model calls reserve before dispatch and duplicate reserve is idempotent", async () => {
  const store = memoryModelReservations();
  const first = await store.reserve(input());
  const again = await store.reserve(input());
  assert.equal(first.id, again.id);
  assert.equal(store.rows().length, 1);
});

test("V2 model reservations include held and settled amounts in the ceiling", async () => {
  const store = memoryModelReservations();
  const first = await store.reserve(input());
  await store.settle("owner-a", first.id, { actualCredits: 1.5, usage: { total: 10 } });
  await store.reserve(input({ callKey: modelCallKey({ buildId: "build-a", step: "repair", sequence: 2 }), step: "repair", reservedCredits: 3 }));
  await assert.rejects(
    store.reserve(input({ callKey: modelCallKey({ buildId: "build-a", step: "repair", sequence: 3 }), step: "repair", reservedCredits: 1 })),
    (error) => error.code === "budget_ceiling" && error.spent === 1.5 && error.held === 3,
  );
});

test("duplicate settlement cannot double charge or change telemetry", async () => {
  const store = memoryModelReservations();
  const row = await store.reserve(input());
  const settlement = { actualCredits: 1.25, usage: { input: 100, cached: 80 }, providerRequestIds: ["req-1"] };
  await store.settle("owner-a", row.id, settlement);
  await store.settle("owner-a", row.id, settlement);
  assert.equal(store.rows().filter((candidate) => candidate.state === "settled").length, 1);
  await assert.rejects(store.settle("owner-a", row.id, { ...settlement, actualCredits: 1.5 }), /disagrees/);
});

test("release is idempotent but a settled call cannot be released", async () => {
  const store = memoryModelReservations();
  const neverStarted = await store.reserve(input());
  await store.release("owner-a", neverStarted.id);
  await store.release("owner-a", neverStarted.id);
  const started = await store.reserve(input({ callKey: modelCallKey({ buildId: "build-a", step: "edit", sequence: 2 }), step: "edit" }));
  await store.settle("owner-a", started.id, { actualCredits: 0.5 });
  await assert.rejects(store.release("owner-a", started.id), /cannot release/);
});

test("reservation identities and owners cannot be crossed", async () => {
  const store = memoryModelReservations();
  const row = await store.reserve(input());
  await assert.rejects(store.release("owner-b", row.id), /not found/);
  await assert.rejects(store.reserve(input({ model: "different" })), /reused with different/);
});

test("managed holds are owner-wide across concurrent builds", async () => {
  const store = memoryModelReservations();
  await store.reserve(input({ reservedCredits: 3, accountAvailableCredits: 5 }));
  await assert.rejects(store.reserve(input({
    projectId: "project-b", buildId: "build-b",
    callKey: modelCallKey({ buildId: "build-b", step: "core", sequence: 1 }),
    reservedCredits: 3, accountAvailableCredits: 5,
  })), (error) => error.code === "account_budget" && error.ownerHeld === 3);
});

test("one provider request cannot charge two reservations", async () => {
  const store = memoryModelReservations();
  const first = await store.reserve(input());
  const second = await store.reserve(input({
    callKey: modelCallKey({ buildId: "build-a", step: "repair", sequence: 2 }), step: "repair",
  }));
  await store.settle("owner-a", first.id, { actualCredits: 1, providerRequestIds: ["req-same"] });
  await assert.rejects(store.settle("owner-a", second.id, {
    actualCredits: 1, providerRequestIds: ["req-same"],
  }), /already settled/);
});

test("migration grants reservations and RPCs only to service_role", async () => {
  const sql = await readFile(new URL("../../supabase/migrations/20260807213500_bv2_runtime_model_reservations.sql", import.meta.url), "utf8");
  assert.match(sql, /revoke all on table public\.bv2_model_reservations from public, anon, authenticated/i);
  assert.match(sql, /grant select, insert, update, delete on table public\.bv2_model_reservations to service_role/i);
  assert.match(sql, /pg_advisory_xact_lock/i);
  assert.match(sql, /v_owner_held \+ p_reserved_credits > p_account_available_credits/i);
  assert.match(sql, /bv2_model_reservations_provider_request_unique/i);
  assert.match(sql, /duplicate Builder V2 settlement disagrees/i);
  assert.match(sql, /insert into public\.ca_usage_records/i, "managed settlement is canonical and transactional");
  assert.match(sql, /v_row\.id, v_row\.owner/i, "reservation id is the idempotent charge identity");
  assert.doesNotMatch(sql, /grant execute[^;]+authenticated/i);
});
