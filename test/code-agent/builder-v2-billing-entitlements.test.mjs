// WP12 — billing and entitlements.
//
// The audit's requirement: "idempotent webhook lifecycle and entitlement enforcement; remove
// generated billing state logic". The generated version was wrong in ways that cost money in both
// directions — a cancelled customer kept access because a client-held `plan` field was stale, a
// paying one was locked out because `isSubscribed` collapsed six lifecycle states into one bit,
// and a retried webhook applied twice because nothing keyed on the event id.
//
// Nothing in this suite contacts a payment provider. The service is exercised over its storage
// seam, exactly as the account and platform-state services are.

import test from "node:test";
import assert from "node:assert/strict";

import {
  BILLING_ERROR, BillingError, DENIED, SUBSCRIPTION_STATUS, compilePlans, createBilling,
  evaluateEntitlement, evaluateLimit,
} from "../../src/scaffolds/reactVite/lib/modules/billing.js";
import {
  EVENT_STATUS, createBillingService, memoryBillingStorage,
} from "../../supabase/functions/app-accounts/billingService.mjs";
import { buildPolicy } from "../../supabase/functions/app-accounts/policy.js";
import { deriveBillingPlan, isPlanEntity } from "../../shell/server/lib/builderV2/platformModules/billingPlan.mjs";
import { deriveBuildSpec } from "../../shell/server/lib/builderV2/buildSpec.mjs";
import {
  APP_FACADE_BILLING_PATH, BILLING_COMPOSED_PATH, composeCapabilityFoundation,
} from "../../shell/server/lib/builderV2/capabilityComposer.mjs";
import { availabilityFromEnv } from "../../shell/server/lib/builderV2/platformModules/availability.mjs";
import { moduleManifest, validateModuleRegistry } from "../../shell/server/lib/builderV2/platformModules/registry.mjs";
import { isProtectedPath } from "../../shell/server/lib/builderV2/patchEngine.mjs";
import { REACT_VITE } from "../../src/scaffolds/reactVite.mjs";

const CATALOGUE = compilePlans([
  { id: "free", title: "Free", features: ["projects"], limits: { projects: 3 }, default: true },
  { id: "pro", title: "Pro", productId: "prod_pro", features: ["projects", "export", "team"], limits: { projects: 100 } },
  { id: "scale", title: "Scale", productId: "prod_scale", features: ["projects", "export", "team", "sso"], limits: {} },
]);
const NOW = new Date("2026-09-19T12:00:00Z");
const decide = (subscription, feature) => evaluateEntitlement(CATALOGUE, subscription, feature, { at: NOW });

test("WP12 — the lifecycle is a status, not a boolean, and each status answers differently", () => {
  assert.deepEqual(CATALOGUE.features, ["export", "projects", "sso", "team"]);
  assert.equal(CATALOGUE.defaultPlan, "free");

  // Before anyone pays, the declared default plan is what they have.
  assert.equal(decide(null, "projects").allowed, true);
  assert.equal(decide(null, "export").allowed, false);
  assert.equal(decide(null, "export").reason, DENIED.PLAN_LACKS_FEATURE);

  assert.equal(decide({ planId: "pro", status: SUBSCRIPTION_STATUS.ACTIVE }, "export").allowed, true);
  assert.equal(decide({ planId: "pro", status: SUBSCRIPTION_STATUS.TRIALING }, "export").allowed, true);
  // A failed card is a payment problem, not a reason to lock someone out of their own data.
  assert.equal(decide({ planId: "pro", status: SUBSCRIPTION_STATUS.PAST_DUE }, "export").allowed, true);

  // Cancelled keeps what it paid for until the period it paid for ends. Cutting access the moment
  // someone cancels is taking money for time not served.
  assert.equal(decide({ planId: "pro", status: SUBSCRIPTION_STATUS.CANCELLED, currentPeriodEnd: "2026-10-01T00:00:00Z" }, "export").allowed, true);
  const after = decide({ planId: "pro", status: SUBSCRIPTION_STATUS.CANCELLED, currentPeriodEnd: "2026-09-01T00:00:00Z" }, "export");
  assert.equal(after.allowed, false);
  assert.equal(after.reason, DENIED.SUBSCRIPTION_CANCELLED);
  assert.equal(decide({ planId: "pro", status: SUBSCRIPTION_STATUS.EXPIRED }, "export").reason, DENIED.SUBSCRIPTION_EXPIRED);

  // A denial names the plans that would allow it, so an upgrade prompt points at something real.
  assert.deepEqual(decide({ planId: "free", status: SUBSCRIPTION_STATUS.ACTIVE }, "sso").availableOn, ["scale"]);

  // A feature nobody declared is a wiring error, not a silent false: "you cannot" and "I have
  // never heard of that" are different answers and were indistinguishable before.
  assert.throws(() => decide(null, "teleport"),
    (error) => error instanceof BillingError && error.code === BILLING_ERROR.UNKNOWN_FEATURE);

  // With no declared free tier, nothing is entitled until a subscription exists.
  const paidOnly = compilePlans([{ id: "pro", productId: "p", features: ["export"] }]);
  assert.equal(evaluateEntitlement(paidOnly, null, "export").reason, DENIED.NO_SUBSCRIPTION);
});

test("WP12 — a limit counts what is stored, and an uncapped plan is uncapped rather than zero", () => {
  assert.equal(evaluateLimit(CATALOGUE, null, "projects", 2).remaining, 1);
  assert.equal(evaluateLimit(CATALOGUE, null, "projects", 2).allowed, true);
  const reached = evaluateLimit(CATALOGUE, null, "projects", 3);
  assert.equal(reached.allowed, false);
  assert.equal(reached.reason, DENIED.LIMIT_REACHED);
  assert.deepEqual(reached.availableOn, ["pro", "scale"], "including the plan that does not cap it at all");
  assert.equal(evaluateLimit(CATALOGUE, null, "projects", 99).remaining, 0, "over the cap is zero remaining, never negative");

  const uncapped = evaluateLimit(CATALOGUE, { planId: "scale", status: "active" }, "projects", 5000);
  assert.equal(uncapped.allowed, true);
  assert.equal(uncapped.cap, null, "a plan that does not cap a limit is not a plan that caps it at zero");
  assert.equal(uncapped.remaining, null);

  // A limit nobody declared does not deny: an undeclared cap is no cap.
  assert.equal(evaluateLimit(CATALOGUE, { planId: "pro", status: "active" }, "seats", 1000).allowed, true);
});

test("WP12 — entitlement is enforced where the work happens, and an outage falls back to the default plan", async () => {
  let stored = null;
  let counted = 3;
  const billing = createBilling({
    catalogue: CATALOGUE,
    transport: {
      status: async () => stored,
      checkout: async ({ productId }) => ({ url: `https://pay.test/${productId}` }),
    },
    usage: async () => counted,
    now: () => NOW,
  });

  await billing.load();
  assert.equal(billing.getState().plan.id, "free");
  assert.deepEqual(
    Object.fromEntries(Object.entries(billing.getState().entitlements).map(([key, value]) => [key, value.allowed])),
    { export: false, projects: true, sso: false, team: false },
    "every declared feature is decided once, so a screen never re-derives gating per element",
  );

  // The call a mutation makes. This is the difference between a disabled button and a limit.
  await assert.rejects(() => billing.require("export"),
    (error) => error.code === BILLING_ERROR.NOT_ENTITLED && error.details.reason === DENIED.PLAN_LACKS_FEATURE);
  await assert.rejects(() => billing.requireWithin("projects"),
    (error) => error.code === BILLING_ERROR.LIMIT_REACHED && error.details.remaining === 0);

  stored = { planId: "pro", status: SUBSCRIPTION_STATUS.ACTIVE };
  await billing.load();
  assert.equal((await billing.require("export")).allowed, true);
  assert.equal((await billing.requireWithin("projects")).remaining, 97);
  counted = 100;
  assert.equal((await billing.remaining("projects")).allowed, false, "the same plan, enforced against real usage");

  assert.equal((await billing.checkout("pro")).url, "https://pay.test/prod_pro");
  await assert.rejects(() => billing.checkout("enterprise"), (error) => error.code === BILLING_ERROR.UNKNOWN_PLAN);
  await assert.rejects(() => billing.checkout("free"),
    (error) => error.code === BILLING_ERROR.UNAVAILABLE, "a plan with no configured product cannot start a checkout that would fail at the provider");
  await assert.rejects(() => billing.portal(), (error) => error.code === BILLING_ERROR.UNAVAILABLE);

  // An unreachable billing service must not grant everything and must not deny everything: it
  // reports, and falls back to what someone has before they pay.
  const offline = createBilling({
    catalogue: CATALOGUE, transport: { status: async () => { throw new Error("billing down"); } }, now: () => NOW,
  });
  await offline.load();
  assert.equal(offline.getState().status, "error");
  assert.equal(offline.getState().error.code, BILLING_ERROR.UNAVAILABLE);
  assert.equal(offline.getState().plan.id, "free");
  assert.equal(offline.can("projects").allowed, true);
  assert.equal(offline.can("export").allowed, false);
});

const event = (id, type, occurredAt, extra = {}) => ({
  id, type, subject: "u1", occurredAt, productId: "prod_pro", ...extra,
});

test("WP12 — the same provider event applied twice changes nothing", async () => {
  const storage = memoryBillingStorage();
  const service = createBillingService({ storage, catalogue: CATALOGUE, now: () => "2026-09-19T12:00:00Z" });

  const first = await service.apply("app", event("evt_1", "subscription.created", "2026-09-19T10:00:00Z"));
  assert.equal(first.outcome, "applied");
  assert.equal(first.subscription.status, "active");
  assert.equal(first.subscription.planId, "pro");
  assert.equal(storage.state.subscriptions.length, 1);

  // Providers retry. Twenty times, after an outage.
  for (let index = 0; index < 5; index += 1) {
    const repeat = await service.apply("app", event("evt_1", "subscription.created", "2026-09-19T10:00:00Z"));
    assert.equal(repeat.outcome, "duplicate");
  }
  assert.equal(storage.state.subscriptions.length, 1);
  assert.equal(storage.state.events.filter((row) => row.eventId === "evt_1").length, 1,
    "the trail records the event once, so history stays readable");

  await assert.rejects(() => service.apply("app", { type: "subscription.created", subject: "u1" }),
    (error) => error.code === "billing_event_id_required");
  await assert.rejects(() => service.apply("app", { id: "x", type: "subscription.created" }),
    (error) => error.code === "billing_subject_required");
});

test("WP12 — an event older than the state it would overwrite is recorded and IGNORED", async () => {
  const storage = memoryBillingStorage();
  const service = createBillingService({ storage, catalogue: CATALOGUE, now: () => "2026-09-19T12:00:00Z" });

  await service.apply("app", event("evt_1", "subscription.created", "2026-09-19T10:00:00Z"));
  await service.apply("app", event("evt_2", "payment.succeeded", "2026-09-19T10:05:00Z"));
  assert.equal((await service.status("app", { userId: "u1", appId: "app" })).status, "active");

  // The cancellation was emitted BEFORE the payment but arrives after it. Applying whichever
  // landed last would downgrade a customer who has just paid.
  const late = await service.apply("app", event("evt_3", "subscription.cancelled", "2026-09-19T10:00:00Z"));
  assert.equal(late.outcome, "ignored_out_of_order");
  assert.equal(late.currentStatus, "active");
  assert.equal((await service.status("app", { userId: "u1", appId: "app" })).status, "active");

  // A genuinely newer cancellation does apply.
  const proper = await service.apply("app", event("evt_4", "subscription.cancelled", "2026-09-19T11:00:00Z", { cancelAt: "2026-10-01T00:00:00Z" }));
  assert.equal(proper.outcome, "applied");
  assert.equal(proper.previousStatus, "active");
  const status = await service.status("app", { userId: "u1", appId: "app" });
  assert.equal(status.status, "cancelled");
  assert.equal(status.cancelAt, "2026-10-01T00:00:00Z");

  // And the trail says what happened to every event, including the ones that did nothing.
  const history = await service.history("app", { userId: "u1", appId: "app" });
  // Newest first by the provider clock, then by arrival: the ignored cancellation shares its
  // timestamp with the creation and must still hold one stable place in the trail.
  assert.deepEqual(history.map((row) => [row.type, row.outcome]), [
    ["subscription.cancelled", "applied"],
    ["payment.succeeded", "applied"],
    ["subscription.cancelled", "ignored_out_of_order"],
    ["subscription.created", "applied"],
  ]);
  assert.deepEqual((await service.history("app", { userId: "u1", appId: "app" })).map((row) => row.outcome),
    history.map((row) => row.outcome), "two reads of the trail agree");
});

test("WP12 — an event the service cannot interpret is recorded, never guessed at", async () => {
  const storage = memoryBillingStorage();
  const service = createBillingService({ storage, catalogue: CATALOGUE, now: () => "2026-09-19T12:00:00Z" });

  const unknownType = await service.apply("app", event("evt_a", "invoice.doodled", "2026-09-19T10:00:00Z"));
  assert.equal(unknownType.outcome, "ignored_unknown_type");
  assert.equal(storage.state.subscriptions.length, 0, "writing a status from an event whose meaning is unknown is how billing state rots");

  // A product nobody declared cannot become a plan nobody can reason about.
  const unknownPlan = await service.apply("app", {
    id: "evt_b", type: "subscription.created", subject: "u2", occurredAt: "2026-09-19T10:00:00Z", productId: "prod_ghost",
  });
  assert.equal(unknownPlan.outcome, "ignored_unknown_plan");
  assert.equal(storage.state.subscriptions.length, 0);

  const unknownStatus = await service.apply("app", {
    id: "evt_c", type: "subscription.updated", subject: "u1", occurredAt: "2026-09-19T10:00:00Z",
    productId: "prod_pro", status: "vibing",
  });
  assert.equal(unknownStatus.outcome, "ignored_unknown_status");

  // subscription.updated carries its own status, and a declared one is applied.
  const updated = await service.apply("app", {
    id: "evt_d", type: "subscription.updated", subject: "u1", occurredAt: "2026-09-19T10:01:00Z",
    productId: "prod_pro", status: "trialing",
  });
  assert.equal(updated.outcome, "applied");
  assert.equal(updated.subscription.status, "trialing");
  assert.ok(Object.hasOwn(EVENT_STATUS, "payment.failed"));
  assert.equal(EVENT_STATUS["payment.failed"], "past_due");
});

test("WP12 — a member reads their own subscription; reading another's is administration", async () => {
  const storage = memoryBillingStorage();
  const policy = buildPolicy({ roles: ["admin", "member"] });
  const service = createBillingService({ storage, policy, catalogue: CATALOGUE, now: () => "2026-09-19T12:00:00Z" });
  await service.apply("app", event("evt_1", "subscription.created", "2026-09-19T10:00:00Z"));

  const admin = { userId: "u-admin", email: "a@x", role: "admin", status: "active", appId: "app" };
  const member = { userId: "u-member", email: "m@x", role: "member", status: "active", appId: "app" };

  assert.equal((await service.status("app", { userId: "u1", appId: "app" })).status, "active");
  assert.equal((await service.status("app", member)).status, "none", "a member with no subscription has none, not an error");
  assert.equal((await service.status("app", admin, { subject: "u1" })).status, "active");
  await assert.rejects(() => service.status("app", member, { subject: "u1" }),
    (error) => error.status === 403, "one member cannot read another's billing");
  await assert.rejects(() => service.status("other-app", admin),
    (error) => error.code === "unauthenticated" && error.status === 401);
});

test("WP12 — the plan catalogue is declared, never inferred from prose", () => {
  assert.equal(isPlanEntity({ name: "plan", fields: [{ name: "features" }, { name: "price" }] }), true);
  assert.equal(isPlanEntity({ name: "tier", fields: [{ name: "monthlyPrice" }] }), true);
  // A project plan is a schedule, not a pricing tier, and claiming it would delete a real concept.
  assert.equal(isPlanEntity({ name: "plan", fields: [{ name: "startDate" }, { name: "tasks" }] }), false);
  assert.equal(isPlanEntity({ name: "project", fields: [{ name: "price" }] }), false);

  // "Premium fixtures" is a product line. Nothing here reads it as a pricing tier.
  const prose = {
    summary: "catalogue of premium and standard lighting fixtures",
    entities: [{ name: "fixture", fields: [{ name: "name" }, { name: "price", type: "number" }] }],
    journeys: [{ id: "browse", title: "Customer compares premium fixtures", steps: [] }],
    operations: [],
  };
  assert.deepEqual(deriveBillingPlan(prose).plans, []);

  const declared = deriveBillingPlan({
    billing: { plans: [
      { id: "free", features: ["projects"], limits: { projects: 3 }, default: true },
      { id: "pro", productId: "prod_pro", features: ["projects", "export"] },
    ] },
    entities: [], operations: [], journeys: [],
  });
  assert.deepEqual(declared.plans.map((plan) => plan.id), ["free", "pro"]);
  assert.deepEqual(declared.features, ["projects", "export"]);
  assert.deepEqual(declared.limits, ["projects"]);
  assert.equal(declared.source, "contract.billing.plans");
  assert.equal(declared.plans[0].productId, null, "a product id is a deployment's own configuration");

  // A declared plan ENTITY means the catalogue is read at runtime; the compiler records the shape
  // rather than inventing tiers nobody priced.
  const fromEntity = deriveBillingPlan({
    entities: [{ name: "tier", fields: [{ name: "name" }, { name: "features" }, { name: "price", type: "number" }] }],
    operations: [], journeys: [],
  }, { entitySchema: { entities: ["tier"] } });
  assert.deepEqual(fromEntity.plans, []);
  assert.equal(fromEntity.catalogueEntity, "tier");
  assert.equal(fromEntity.durablePlanEntity, true);
  assert.equal(fromEntity.source, "entity:tier");
});

const PAID = {
  version: 2, summary: "project tool with paid tiers", auth: { required: true },
  billing: { plans: [
    { id: "free", title: "Free", features: ["projects"], limits: { projects: 3 }, default: true },
    { id: "pro", title: "Pro", productId: "prod_pro", features: ["projects", "export"], limits: { projects: 100 } },
  ] },
  entities: [{ name: "project", fields: [{ name: "id" }, { name: "name", type: "string", required: true }] }],
  operations: [
    { id: "create-project", kind: "create", entity: "project" },
    { id: "list-projects", kind: "list", entity: "project" },
  ],
  journeys: [{ id: "use", title: "Member creates projects within their plan limit", steps: [
    { id: "u1", operates: ["create-project"], expect: "the project is stored" },
    { id: "u2", operates: ["list-projects"], expect: "the list shows them" },
  ] }],
};

const ENABLED = availabilityFromEnv({
  SUPABASE_URL: "https://project.test", SUPABASE_ANON_KEY: "anon",
  THRALLO_APP_SERVICE_ACCOUNTS: "1", THRALLO_APP_SERVICE_PAYMENTS: "1",
});

test("WP12 — a declaring contract locks billing and composes a protected facade", () => {
  const spec = deriveBuildSpec(PAID, { availability: ENABLED });
  assert.equal(spec.verdict.ok, true, spec.verdict.problems.join(" | "));
  assert.deepEqual(spec.billingPlan.plans.map((plan) => plan.id), ["free", "pro"]);
  assert.ok(spec.moduleLock.modules.some((row) => row.id === "thrallo.billing"));
  assert.deepEqual(spec.moduleResolution.modules.find((row) => row.id === "thrallo.billing").reasons,
    ["the contract declares a plan catalogue"]);

  const { tree } = composeCapabilityFoundation({ ...REACT_VITE }, spec.capabilityGraph, {
    moduleLock: spec.moduleLock, identityPlan: spec.identityPlan, entitySchema: spec.entitySchema,
    routePlan: spec.routePlan, settingsPlan: spec.settingsPlan, behaviourPlan: spec.behaviourPlan,
    deliveryPlan: spec.deliveryPlan, insightPlan: spec.insightPlan, billingPlan: spec.billingPlan,
  });
  assert.ok(tree[BILLING_COMPOSED_PATH].includes("compilePlans("));
  assert.ok(tree[BILLING_COMPOSED_PATH].includes('"prod_pro"'));
  assert.ok(tree[BILLING_COMPOSED_PATH].includes("accounts.subscription()"),
    "entitlement is read from the server, never from a client-held field");
  assert.ok(tree[APP_FACADE_BILLING_PATH].includes("export function useBilling("));
  assert.ok(tree["src/lib/app/index.js"].includes('export * from "./billing.js";'));
  for (const path of [BILLING_COMPOSED_PATH, APP_FACADE_BILLING_PATH, "src/lib/modules/billing.js"]) {
    assert.ok(isProtectedPath(path), `${path} stays under the write guard`);
  }
  assert.equal(typeof REACT_VITE["src/lib/modules/billing.js"], "string");
  assert.ok(REACT_VITE["src/lib/modules/uiReact.js"].includes("export function useBillingState("));
  assert.ok(REACT_VITE["src/lib/backend/supabaseBackend.js"].includes("async subscription("),
    "the SDK can read the subscription and has no way to write it");
  assert.deepEqual(validateModuleRegistry(), { ok: true, problems: [] });

  const manifest = moduleManifest("thrallo.billing");
  assert.ok(manifest.requires.services.includes("payments"));
  assert.ok(manifest.requires.services.includes("accounts"));
  assert.equal(manifest.provides.operations.some((row) => /webhook|apply/i.test(row.id)), false,
    "the client ABI has no way to apply a billing event: that is the server's alone");
});

test("WP12 — billing is availability-gated, and a contract without a catalogue composes none of it", () => {
  // Without the payments service the build blocks rather than shipping a checkout that fails.
  const spec = deriveBuildSpec(PAID, {
    availability: availabilityFromEnv({ SUPABASE_URL: "https://x.test", SUPABASE_ANON_KEY: "k", THRALLO_APP_SERVICE_ACCOUNTS: "1" }),
  });
  assert.equal(spec.verdict.ok, false);
  const problem = spec.moduleResolution.problems.find((row) => row.module === "thrallo.billing");
  assert.equal(problem.code, "module_unavailable");
  assert.equal(problem.configurationRequired, true);

  const free = deriveBuildSpec({
    ...PAID, billing: undefined, summary: "project tool",
  }, { availability: ENABLED });
  assert.equal(free.verdict.ok, true, free.verdict.problems.join(" | "));
  assert.deepEqual(free.billingPlan.plans, []);
  assert.equal(free.moduleLock.modules.some((row) => row.id === "thrallo.billing"), false);
  const { tree } = composeCapabilityFoundation({ ...REACT_VITE }, free.capabilityGraph, {
    moduleLock: free.moduleLock, identityPlan: free.identityPlan, entitySchema: free.entitySchema,
    routePlan: free.routePlan, settingsPlan: free.settingsPlan, behaviourPlan: free.behaviourPlan,
    deliveryPlan: free.deliveryPlan, insightPlan: free.insightPlan, billingPlan: free.billingPlan,
  });
  assert.equal(BILLING_COMPOSED_PATH in tree, false);
  assert.equal(APP_FACADE_BILLING_PATH in tree, false);
});
