// WP13 — jobs, scheduling and integrations.
//
// The audit's proof for this package: provider-disabled contract tests, queue lifecycle, quotas,
// isolation, with provider/connector/job wrappers removed. The generated versions polled at a
// fixed interval forever, started a second job on the second click, discovered a quota at
// settlement, ran a schedule twice when two workers saw it due, and called a third-party API with
// a key in the source and no timeout.
//
// Nothing here contacts a provider. Every transport is a seam.

import test from "node:test";
import assert from "node:assert/strict";

import {
  CADENCES, JOB_ERROR, JobError, SCHEDULE_ERROR, compileActions, createJobs, createSchedules,
  idempotencyKeyFor, isDue, occurrenceKey, validateActionInput,
} from "../../src/scaffolds/reactVite/lib/modules/jobs.js";
import {
  CONNECTOR_ERROR, ConnectorError, buildUrl, compileConnectors, createConnectors, redactSecrets, validateResponse,
} from "../../src/scaffolds/reactVite/lib/modules/connectors.js";
import {
  PROVIDER_FAMILIES, deriveAutomationPlan, deriveConnectorPlan, deriveSchedulePlan,
} from "../../shell/server/lib/builderV2/platformModules/automationPlan.mjs";
import { deriveBuildSpec } from "../../shell/server/lib/builderV2/buildSpec.mjs";
import {
  APP_FACADE_CONNECTORS_PATH, APP_FACADE_JOBS_PATH, CONNECTORS_COMPOSED_PATH,
  JOBS_COMPOSED_PATH, SCHEDULES_COMPOSED_PATH, composeCapabilityFoundation,
} from "../../shell/server/lib/builderV2/capabilityComposer.mjs";
import { availabilityFromEnv } from "../../shell/server/lib/builderV2/platformModules/availability.mjs";
import { moduleManifest, validateModuleRegistry } from "../../shell/server/lib/builderV2/platformModules/registry.mjs";
import { RUNTIME_CAPABILITY_OPERATIONS } from "../../shell/server/lib/capabilityRuntime.mjs";
import { isProtectedPath } from "../../shell/server/lib/builderV2/patchEngine.mjs";
import { REACT_VITE } from "../../src/scaffolds/reactVite.mjs";

const ACTIONS = compileActions([
  { id: "summarise", actionKey: "openai:text", inputs: ["prompt", "tone"], required: ["prompt"], cost: 2 },
  { id: "render", actionKey: "media:compose", inputs: ["clipId"], required: ["clipId"], cost: 0 },
]);

function fakeQueue({ status = "queued" } = {}) {
  const invocations = [];
  const jobs = new Map();
  let seq = 0;
  return {
    invocations, jobs,
    transport: {
      async invoke(actionKey, input, { idempotencyKey }) {
        // A real queue keys on this. The point of the deterministic key is that it can.
        const existing = [...jobs.values()].find((job) => job.idempotencyKey === idempotencyKey);
        invocations.push({ actionKey, input, idempotencyKey, deduplicated: Boolean(existing) });
        if (existing) return { ...existing };
        const job = { id: `job-${++seq}`, status, idempotencyKey, actionKey };
        jobs.set(job.id, job);
        return { ...job };
      },
      async getJob(id) { return jobs.has(id) ? { ...jobs.get(id) } : null; },
      async cancel(id) { const job = { ...jobs.get(id), status: "cancelled" }; jobs.set(id, job); return { ...job }; },
    },
    finish(id, status = "succeeded") { jobs.set(id, { ...jobs.get(id), status }); },
  };
}

test("WP13 — the same action with the same input is ONE job, whatever order the keys arrive in", async () => {
  const queue = fakeQueue();
  const jobs = createJobs({ actions: ACTIONS, transport: queue.transport, usage: { getBalance: async () => 100 } });

  const first = await jobs.invoke("summarise", { prompt: "hello", tone: "warm" });
  const second = await jobs.invoke("summarise", { tone: "warm", prompt: "hello" });
  assert.equal(first.ok, true);
  assert.equal(first.idempotencyKey, second.idempotencyKey, "key order in the input does not change the key");
  assert.equal(queue.jobs.size, 1, "a double-clicked button starts one job");
  assert.equal(queue.invocations[1].deduplicated, true);

  // Different input is different work.
  const other = await jobs.invoke("summarise", { prompt: "different" });
  assert.notEqual(other.idempotencyKey, first.idempotencyKey);
  assert.equal(queue.jobs.size, 2);
  assert.equal(idempotencyKeyFor("a", { x: 1 }), idempotencyKeyFor("a", { x: 1 }));
  assert.notEqual(idempotencyKeyFor("a", { x: 1 }), idempotencyKeyFor("b", { x: 1 }));
  // A caller that genuinely wants a second run says so.
  assert.notEqual((await jobs.invoke("summarise", { prompt: "hello", tone: "warm" }, { salt: "retry" })).idempotencyKey, first.idempotencyKey);
});

test("WP13 — an undeclared action, a missing input and an exhausted quota are all refused before dispatch", async () => {
  const queue = fakeQueue();
  let balance = 1;
  const jobs = createJobs({
    actions: ACTIONS, transport: queue.transport, usage: { getBalance: async () => balance },
    authorize: async (grant) => grant !== "denied",
  });

  await assert.rejects(() => jobs.invoke("teleport", {}),
    (error) => error instanceof JobError && error.code === JOB_ERROR.UNKNOWN_ACTION);
  assert.equal((await jobs.invoke("summarise", {})).reason, JOB_ERROR.INPUT_INVALID);
  assert.deepEqual((await jobs.invoke("summarise", {})).missing, ["prompt"]);

  // Discovering a quota at settlement means the work ran and the customer still cannot have it.
  const refused = await jobs.invoke("summarise", { prompt: "x" });
  assert.equal(refused.reason, JOB_ERROR.QUOTA_EXCEEDED);
  assert.equal(refused.required, 2);
  assert.equal(refused.balance, 1);
  assert.equal(queue.invocations.length, 0, "nothing was dispatched");

  balance = 100;
  assert.equal((await jobs.invoke("summarise", { prompt: "x" })).ok, true);
  // A free action needs no balance at all.
  assert.equal((await jobs.invoke("render", { clipId: "c1" })).ok, true);

  const guarded = createJobs({
    actions: compileActions([{ id: "secret", actionKey: "openai:text", inputs: ["prompt"], grant: "denied" }]),
    transport: queue.transport, authorize: async () => false,
  });
  assert.equal((await guarded.invoke("secret", { prompt: "x" })).reason, "forbidden");
  assert.deepEqual(validateActionInput(ACTIONS.definitions.summarise, { prompt: "p", extra: 1 }).unknown, ["extra"]);
});

test("WP13 — waiting prefers the live subscription, backs off when polling, and gives up at the deadline", async () => {
  const queue = fakeQueue();
  let notify = null;
  const live = createJobs({
    actions: ACTIONS,
    transport: { ...queue.transport, subscribe: (id, callback) => { notify = callback; return () => { notify = null; }; } },
  });
  const started = await live.invoke("render", { clipId: "c1" });
  const waiting = live.wait(started.job.id, { timeout: 2000 });
  setTimeout(() => notify?.({ id: started.job.id, status: "succeeded" }), 5);
  const done = await waiting;
  assert.equal(done.ok, true);
  assert.equal(done.job.status, "succeeded");
  assert.equal(notify, null, "the subscription is released rather than left open");

  // No subscription: poll with backoff, and stop at the deadline rather than forever.
  const polls = [];
  const polling = createJobs({
    actions: ACTIONS,
    transport: {
      ...queue.transport,
      async getJob(id) { polls.push(Date.now()); return { id, status: "running" }; },
    },
  });
  const timedOut = await polling.wait("job-x", { timeout: 260, interval: 40, maxInterval: 120 });
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.reason, JOB_ERROR.TIMEOUT);
  assert.ok(polls.length >= 2 && polls.length <= 6, `backoff kept the poll count sane (${polls.length})`);
  const gaps = polls.slice(1).map((value, index) => value - polls[index]);
  assert.ok(gaps.length < 2 || gaps.at(-1) >= gaps[0], "the interval grows rather than hammering at a fixed rate");

  // A job that already finished is returned without waiting at all.
  queue.finish(started.job.id, "succeeded");
  assert.equal((await live.wait(started.job.id, { timeout: 50 })).job.status, "succeeded");
});

test("WP13 — a finished job cannot be cancelled, and the module checks before it refuses", async () => {
  const queue = fakeQueue();
  const jobs = createJobs({ actions: ACTIONS, transport: queue.transport });
  const started = await jobs.invoke("render", { clipId: "c1" });
  assert.equal((await jobs.cancel(started.job.id)).ok, true);
  assert.equal(queue.jobs.get(started.job.id).status, "cancelled");

  const refused = await jobs.cancel(started.job.id);
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, JOB_ERROR.NOT_CANCELLABLE);

  // A job this controller has never seen is CHECKED, not assumed cancellable.
  queue.jobs.set("job-elsewhere", { id: "job-elsewhere", status: "succeeded" });
  const other = createJobs({ actions: ACTIONS, transport: queue.transport });
  assert.equal((await other.cancel("job-elsewhere")).reason, JOB_ERROR.NOT_CANCELLABLE);
});

const DIGEST = { id: "digest", cadence: "daily", atTime: "09:00", action: "render", input: { clipId: "c1" } };
const at = (iso) => new Date(iso);

test("WP13 — one occurrence runs once, however many workers see it due", async () => {
  const rows = [];
  const storage = {
    list: async () => rows.map((row) => ({ ...row })),
    put: async (row) => { const index = rows.findIndex((r) => r.id === row.id); if (index >= 0) rows[index] = { ...row }; else rows.push({ ...row }); },
  };
  const queue = fakeQueue();
  const jobs = createJobs({ actions: ACTIONS, transport: queue.transport });
  const schedules = createSchedules({ schedules: [DIGEST], storage, jobs });

  assert.deepEqual((await schedules.runDue({ at: at("2026-09-19T08:00:00Z") })).map((row) => row.outcome), ["not_due"]);
  const first = await schedules.runDue({ at: at("2026-09-19T09:30:00Z") });
  assert.equal(first[0].outcome, "ran");
  assert.equal(first[0].occurrence, "digest@2026-09-19");

  // The same slot again, whether from a retry or a second worker.
  assert.equal((await schedules.runDue({ at: at("2026-09-19T09:45:00Z") }))[0].outcome, "not_due");
  assert.equal((await schedules.runDue({ at: at("2026-09-19T23:00:00Z") }))[0].outcome, "not_due");
  assert.equal(queue.jobs.size, 1, "one run for one occurrence");

  // The next day is a new occurrence.
  assert.equal((await schedules.runDue({ at: at("2026-09-20T09:30:00Z") }))[0].outcome, "ran");
  assert.equal(queue.jobs.size, 2);

  // Pausing stops it; resuming does not replay the slots it missed, which is the right answer for
  // a digest: nobody wants four days of them at once.
  await schedules.pause("digest");
  assert.equal((await schedules.runDue({ at: at("2026-09-21T09:30:00Z") }))[0].outcome, "paused");
  await schedules.resume("digest");
  assert.equal((await schedules.runDue({ at: at("2026-09-23T09:30:00Z") }))[0].outcome, "ran");
  assert.equal(queue.jobs.size, 3, "one catch-up run, not one per missed day");
  await assert.rejects(() => schedules.pause("ghost"), (error) => error.code === SCHEDULE_ERROR.UNKNOWN_SCHEDULE);
});

test("WP13 — occurrence keys follow the cadence and honour a time-zone offset", () => {
  assert.equal(occurrenceKey({ id: "d", cadence: "daily" }, at("2026-09-19T23:30:00Z")), "d@2026-09-19");
  assert.equal(occurrenceKey({ id: "h", cadence: "hourly" }, at("2026-09-19T10:30:00Z")), "h@2026-09-19T10");
  assert.equal(occurrenceKey({ id: "w", cadence: "weekly" }, at("2026-09-19T10:00:00Z")), "w@2026-09-14");
  assert.equal(occurrenceKey({ id: "m", cadence: "monthly" }, at("2026-09-19T10:00:00Z")), "m@2026-09");

  // 23:30 UTC is already tomorrow in a +60 zone, and a schedule that drifts an hour twice a year
  // is a schedule nobody trusts.
  assert.equal(occurrenceKey({ id: "d", cadence: "daily" }, at("2026-09-19T23:30:00Z"), { offsetMinutes: 60 }), "d@2026-09-20");
  assert.equal(isDue({ ...DIGEST, lastOccurrence: "digest@2026-09-19" }, at("2026-09-19T10:00:00Z")), false);
  assert.equal(isDue({ ...DIGEST, paused: true }, at("2026-09-19T10:00:00Z")), false);
  assert.equal(isDue({ id: "w", cadence: "weekly", atTime: "09:00", weekday: 1 }, at("2026-09-21T10:00:00Z")), true);
  assert.equal(isDue({ id: "w", cadence: "weekly", atTime: "09:00", weekday: 1 }, at("2026-09-22T10:00:00Z")), false);
  assert.deepEqual([...CADENCES], ["hourly", "daily", "weekly", "monthly"]);
});

test("WP13 — a connector may reach exactly one declared https host, and nothing private", () => {
  assert.throws(() => compileConnectors([{ id: "bad", url: "http://localhost:9000/admin" }]),
    (error) => error instanceof ConnectorError && error.code === CONNECTOR_ERROR.TARGET_DENIED);
  assert.throws(() => compileConnectors([{ id: "bad", url: "https://169.254.169.254/latest/meta-data" }]),
    (error) => error.code === CONNECTOR_ERROR.TARGET_DENIED, "the cloud metadata endpoint is never a third-party API");
  assert.throws(() => compileConnectors([{ id: "bad", url: "https://10.0.0.5/internal" }]),
    (error) => error.code === CONNECTOR_ERROR.TARGET_DENIED);

  const schema = compileConnectors([
    { id: "weather", method: "GET", url: "https://api.weather.test/v1/{city}", secret: "WEATHER_KEY", inputs: ["city"], responseShape: { tempC: "number" } },
    { id: "charge", method: "POST", url: "https://api.pay.test/charge", inputs: ["amount"], retries: 3 },
  ]);
  assert.equal(schema.definitions.weather.host, "api.weather.test");
  assert.equal(schema.definitions.charge.retries, 0, "a POST never retries: that is how one charge becomes three");
  assert.equal(schema.definitions.weather.retries, 2);

  // A value in the path is encoded, so it cannot climb out of the declared host.
  assert.equal(buildUrl(schema.definitions.weather, { city: "../../evil.test/x" }),
    "https://api.weather.test/v1/..%2F..%2Fevil.test%2Fx");
  assert.throws(() => buildUrl({ ...schema.definitions.weather, url: "http://api.weather.test/v1/x" }, {}),
    (error) => error.code === CONNECTOR_ERROR.TARGET_DENIED, "https only");
});

test("WP13 — responses are validated, secrets are references, and only transient failures retry", async () => {
  const schema = compileConnectors([
    { id: "weather", method: "GET", url: "https://api.weather.test/v1/{city}", secret: "WEATHER_KEY", inputs: ["city"], responseShape: { tempC: "number" }, retries: 2 },
  ]);
  assert.deepEqual(validateResponse(schema.definitions.weather, { tempC: "warm" }).problems, ["tempC is number, expected number".replace("number is", "string is").replace("is number,", "is string,")]);

  let calls = 0;
  const transient = createConnectors({
    schema, secrets: async () => "sk-live-abcdefghijklmnop", sleep: async () => {},
    fetchImpl: async () => {
      calls += 1;
      return calls < 3
        ? { ok: false, status: 503, text: async () => "busy" }
        : { ok: true, status: 200, json: async () => ({ tempC: 14 }) };
    },
  });
  const recovered = await transient.invoke("weather", { city: "Leeds" });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.data.tempC, 14);
  assert.equal(recovered.attempts, 3);

  // A 400 will be a 400 next time too.
  let permanentCalls = 0;
  const permanent = createConnectors({
    schema, secrets: async () => "k", sleep: async () => {},
    fetchImpl: async () => { permanentCalls += 1; return { ok: false, status: 400, text: async () => "bad request with sk-live-abcdefghijkl" }; },
  });
  const failed = await permanent.invoke("weather", { city: "Leeds" });
  assert.equal(failed.code, CONNECTOR_ERROR.UPSTREAM);
  assert.equal(permanentCalls, 1, "a permanent failure is not retried");
  assert.equal(failed.message.includes("sk-live"), false, "no secret reaches an error the application can see");
  assert.equal(redactSecrets("token sk-live-abcdefghijkl here"), "token [redacted] here");

  // A provider that changed its payload is a named failure, not `undefined` three screens later.
  const drifted = createConnectors({
    schema, secrets: async () => "k",
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ temp: 14 }) }),
  });
  const invalid = await drifted.invoke("weather", { city: "Leeds" });
  assert.equal(invalid.code, CONNECTOR_ERROR.RESPONSE_INVALID);
  assert.deepEqual(invalid.problems, ["tempC is missing"]);

  // A secret the deployment has not configured is a named refusal, not a 401 from the provider.
  const unconfigured = createConnectors({ schema, secrets: async () => null, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }) });
  const missing = await unconfigured.invoke("weather", { city: "Leeds" });
  assert.equal(missing.code, CONNECTOR_ERROR.SECRET_MISSING);
  assert.equal(missing.secret, "WEATHER_KEY");
  assert.equal((await unconfigured.invoke("weather", {})).code, CONNECTOR_ERROR.INPUT_INVALID);
  await assert.rejects(() => unconfigured.invoke("ghost", {}), (error) => error.code === CONNECTOR_ERROR.UNKNOWN);
});

test("WP13 — the plan reads declared actions, schedules and connectors, and never a domain verb", () => {
  // "Generate an invoice" is a document an application renders. It is not a provider request.
  const prose = {
    summary: "invoicing tool",
    journeys: [{ id: "bill", title: "Staff generate an invoice and email it daily", steps: [] }],
    operations: [{ id: "make-invoice", kind: "create", entity: "invoice" }],
    entities: [],
  };
  const quiet = deriveAutomationPlan(prose);
  assert.deepEqual(quiet.actions, []);
  assert.deepEqual(quiet.schedules, [], "a cadence in prose is recorded as a mention, never turned into a schedule");
  assert.deepEqual(quiet.scheduleMentions, ["bill"]);
  assert.deepEqual(quiet.families, []);

  const declared = deriveAutomationPlan({
    actions: [{ id: "summarise", provider: "openai", operation: "text", inputs: ["prompt"], cost: 2 }],
    schedules: [{ id: "digest", action: "summarise", cadence: "daily", atTime: "09:00" }],
    connectors: [{ id: "weather", url: "https://api.weather.test/v1/{city}", inputs: ["city"] }],
    journeys: [], operations: [],
  });
  assert.deepEqual(declared.actions.map((action) => action.actionKey), ["openai:text"]);
  assert.deepEqual(declared.families, ["thrallo.aiActions", "thrallo.httpConnectors"]);
  assert.deepEqual(declared.schedules.map((row) => row.id), ["digest"]);
  assert.deepEqual(declared.connectors.map((row) => row.id), ["weather"]);

  // A schedule pointing at an action nobody declared fails silently at 3am, so it is refused here.
  const orphan = deriveSchedulePlan({ schedules: [{ id: "ghost", action: "nothing", cadence: "daily" }], journeys: [] },
    { actions: [{ id: "summarise" }] });
  assert.deepEqual(orphan.schedules, []);
  assert.deepEqual(orphan.refused, [{ id: "ghost", reason: 'no declared action "nothing"' }]);
  assert.deepEqual(deriveConnectorPlan({ connectors: [{ id: "no-url" }] }).connectors, []);

  // Every family this plan can name is one the capability runtime actually implements.
  for (const [provider, module] of Object.entries(PROVIDER_FAMILIES)) {
    if (provider === "http") continue;
    assert.ok(RUNTIME_CAPABILITY_OPERATIONS[provider], `${provider} is a real runtime family`);
    assert.ok(moduleManifest(module), `${module} is registered`);
  }
});

const STUDIO = {
  version: 2, summary: "content studio", auth: { required: true },
  actions: [{ id: "summarise", provider: "openai", operation: "text", inputs: ["prompt"], required: ["prompt"], cost: 2 }],
  schedules: [{ id: "digest", action: "summarise", cadence: "daily", atTime: "09:00", input: { prompt: "daily digest" } }],
  connectors: [{ id: "weather", method: "GET", url: "https://api.weather.test/v1/{city}", secret: "WEATHER_KEY", inputs: ["city"], responseShape: { tempC: "number" } }],
  entities: [{ name: "brief", fields: [{ name: "id" }, { name: "title", type: "string", required: true }] }],
  operations: [
    { id: "create-brief", kind: "create", entity: "brief" },
    { id: "list-briefs", kind: "list", entity: "brief" },
  ],
  journeys: [{ id: "work", title: "Writer creates a brief and summarises it", steps: [
    { id: "w1", operates: ["create-brief"], expect: "the brief is stored" },
    { id: "w2", operates: ["list-briefs"], expect: "the list shows it" },
  ] }],
};

const ENABLED = availabilityFromEnv({
  SUPABASE_URL: "https://project.test", SUPABASE_ANON_KEY: "anon",
  THRALLO_APP_SERVICE_RUNTIME_ACTIONS: "1", THRALLO_APP_SERVICE_KNOWLEDGE: "1", THRALLO_APP_SERVICE_ACCOUNTS: "1",
});

test("WP13 — a declaring contract locks the families it uses and composes protected modules", () => {
  const spec = deriveBuildSpec(STUDIO, { availability: ENABLED });
  assert.equal(spec.verdict.ok, true, spec.verdict.problems.join(" | "));
  const locked = spec.moduleLock.modules.map((row) => row.id);
  for (const id of ["thrallo.jobs", "thrallo.schedules", "thrallo.httpConnectors", "thrallo.aiActions"]) {
    assert.ok(locked.includes(id), `${id} is locked`);
  }
  assert.equal(locked.includes("thrallo.metaConnector"), false, "a family no declared action uses is not installed");
  assert.deepEqual(spec.moduleResolution.modules.find((row) => row.id === "thrallo.aiActions").reasons,
    ["a declared action uses this provider family"]);

  const { tree } = composeCapabilityFoundation({ ...REACT_VITE }, spec.capabilityGraph, {
    moduleLock: spec.moduleLock, identityPlan: spec.identityPlan, entitySchema: spec.entitySchema,
    routePlan: spec.routePlan, settingsPlan: spec.settingsPlan, behaviourPlan: spec.behaviourPlan,
    deliveryPlan: spec.deliveryPlan, insightPlan: spec.insightPlan, billingPlan: spec.billingPlan,
    automationPlan: spec.automationPlan,
  });
  assert.ok(tree[JOBS_COMPOSED_PATH].includes("compileActions("));
  assert.ok(tree[SCHEDULES_COMPOSED_PATH].includes("createSchedules("));
  assert.ok(tree[CONNECTORS_COMPOSED_PATH].includes("compileConnectors("));
  assert.ok(tree[CONNECTORS_COMPOSED_PATH].includes('"WEATHER_KEY"'), "the secret REFERENCE is composed");
  assert.equal(/sk-|Bearer\s+\w/.test(tree[CONNECTORS_COMPOSED_PATH]), false, "no secret value is ever composed");
  assert.ok(tree[APP_FACADE_JOBS_PATH].includes("export function useJob("));
  assert.ok(tree[APP_FACADE_CONNECTORS_PATH].includes("connectorCatalogue"));

  for (const path of [JOBS_COMPOSED_PATH, SCHEDULES_COMPOSED_PATH, CONNECTORS_COMPOSED_PATH,
    APP_FACADE_JOBS_PATH, APP_FACADE_CONNECTORS_PATH, "src/lib/modules/jobs.js", "src/lib/modules/connectors.js"]) {
    assert.ok(isProtectedPath(path), `${path} stays under the write guard`);
  }
  assert.equal(typeof REACT_VITE["src/lib/modules/jobs.js"], "string");
  assert.equal(typeof REACT_VITE["src/lib/modules/connectors.js"], "string");
  assert.deepEqual(validateModuleRegistry(), { ok: true, problems: [] });
});

test("WP13 — a provider this deployment has not configured blocks BEFORE generation", () => {
  // The audit's requirement in one assertion: unavailable services remain unavailable.
  const spec = deriveBuildSpec(STUDIO, {
    availability: availabilityFromEnv({
      SUPABASE_URL: "https://project.test", SUPABASE_ANON_KEY: "anon",
      THRALLO_APP_SERVICE_RUNTIME_ACTIONS: "1", THRALLO_APP_SERVICE_ACCOUNTS: "1",
    }),
  });
  assert.equal(spec.verdict.ok, false);
  const problem = spec.moduleResolution.problems.find((row) => row.module === "thrallo.aiActions");
  assert.equal(problem.code, "module_unavailable");
  assert.equal(problem.configurationRequired, true, "an operator configures the provider; the compiler does not generate around it");
  assert.ok(spec.verdict.problems.some((row) => row.includes("thrallo.aiActions")));

  // Without the runtime-actions service, nothing in this package installs at all.
  const bare = deriveBuildSpec(STUDIO, {
    availability: availabilityFromEnv({ SUPABASE_URL: "https://x.test", SUPABASE_ANON_KEY: "k", THRALLO_APP_SERVICE_ACCOUNTS: "1" }),
  });
  assert.equal(bare.verdict.ok, false);
  assert.ok(bare.moduleResolution.problems.some((row) => row.module === "thrallo.jobs"));
  assert.ok(moduleManifest("thrallo.jobs").requires.services.includes("runtime_actions"));
  assert.ok(moduleManifest("thrallo.metaConnector").requires.services.includes("meta_connector"));
});

test("WP13 — negative control: a contract declaring none of this composes none of it", () => {
  const quiet = {
    version: 2, summary: "customer list", auth: { required: true },
    entities: [{ name: "customer", fields: [{ name: "id" }, { name: "name", type: "string", required: true }] }],
    operations: [
      { id: "add-customer", kind: "create", entity: "customer" },
      { id: "list-customers", kind: "list", entity: "customer" },
    ],
    journeys: [{ id: "admin", title: "Staff add a customer and see the list", steps: [
      { id: "a1", operates: ["add-customer"], expect: "the customer is stored" },
      { id: "a2", operates: ["list-customers"], expect: "the list shows them" },
    ] }],
  };
  const spec = deriveBuildSpec(quiet, { availability: ENABLED });
  assert.equal(spec.verdict.ok, true, spec.verdict.problems.join(" | "));
  assert.deepEqual(spec.automationPlan.actions, []);
  assert.deepEqual(spec.automationPlan.families, []);
  const locked = spec.moduleLock.modules.map((row) => row.id);
  for (const id of ["thrallo.jobs", "thrallo.schedules", "thrallo.httpConnectors", "thrallo.aiActions"]) {
    assert.equal(locked.includes(id), false, `${id} was locked for a contract that never asked`);
  }
  const { tree } = composeCapabilityFoundation({ ...REACT_VITE }, spec.capabilityGraph, {
    moduleLock: spec.moduleLock, identityPlan: spec.identityPlan, entitySchema: spec.entitySchema,
    routePlan: spec.routePlan, settingsPlan: spec.settingsPlan, behaviourPlan: spec.behaviourPlan,
    deliveryPlan: spec.deliveryPlan, insightPlan: spec.insightPlan, billingPlan: spec.billingPlan,
    automationPlan: spec.automationPlan,
  });
  for (const path of [JOBS_COMPOSED_PATH, SCHEDULES_COMPOSED_PATH, CONNECTORS_COMPOSED_PATH,
    APP_FACADE_JOBS_PATH, APP_FACADE_CONNECTORS_PATH]) {
    assert.equal(path in tree, false, `${path} composed for a contract that declares none of it`);
  }
});
