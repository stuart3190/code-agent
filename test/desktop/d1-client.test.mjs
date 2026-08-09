import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  AuthenticationExpiredError,
  CancelledError,
  FIXTURE_SCENARIO_NAMES,
  HOST_CAPABILITY_KEYS,
  PROVIDER_FAMILIES,
  ThralloClientError,
  assertProviderSuiteConformance,
  consumeEventStream,
  createFixtureProviderSuite,
  createHostCapabilities,
  createHttpTransport,
  createStableReadOnlyProvider,
  negotiateCapabilities,
  parseSseChunks,
} from "../../shared/thrallo-client/src/index.mjs";
import { runGuard } from "../../desktop/d0/guard.mjs";

async function collect(iterable) {
  const values = [];
  for await (const value of iterable) values.push(value);
  return values;
}

test("D1 runtime provider contracts exactly conform to the committed D0 families", async () => {
  const d0 = JSON.parse(await readFile(new URL("../../desktop/d0/provider-contracts.json", import.meta.url), "utf8"));
  const d1 = Object.values(PROVIDER_FAMILIES).map((family) => ({
    id: family.id,
    operations: Object.entries(family.operations).map(([id, kind]) => ({ id, kind })),
  }));
  assert.deepEqual(d1, d0.families.map((family) => ({
    id: family.id,
    operations: family.operations.map(({ id, kind }) => ({ id, kind })),
  })));
  assert.doesNotThrow(() => assertProviderSuiteConformance(createFixtureProviderSuite()));
});

test("identical fixture seeds produce identical results, events, calls and state", async () => {
  const options = {
    seed: "determinism-proof",
    scenario: "success",
    capabilities: { managedBuild: true, builderV2Mutation: true, publishing: true, integrations: true, browserDiagnostics: true },
  };
  const first = createFixtureProviderSuite(options);
  const second = createFixtureProviderSuite(options);

  const firstResults = [
    await first.projects.listProjects(),
    await first.plans.approvePlan({ planId: "fixture-plan-0001" }),
    await first.builds.startBuild({ projectId: "fixture-project-0001" }),
    await collect(first.builds.subscribeBuild()),
  ];
  const secondResults = [
    await second.projects.listProjects(),
    await second.plans.approvePlan({ planId: "fixture-plan-0001" }),
    await second.builds.startBuild({ projectId: "fixture-project-0001" }),
    await collect(second.builds.subscribeBuild()),
  ];

  assert.deepEqual(firstResults, secondResults);
  assert.deepEqual(first.getCalls(), second.getCalls());
  assert.deepEqual(first.getState(), second.getState());

  const different = createFixtureProviderSuite({ ...options, seed: "different-seed" });
  assert.notEqual((await different.projects.listProjects()).requestId, firstResults[0].requestId);
});

test("fixture catalogue covers every required D1 state", async () => {
  assert.deepEqual(FIXTURE_SCENARIO_NAMES, [
    "idle", "running", "success", "failure", "cancellation", "recovery", "waiting-approval",
    "budget-warning", "unsupported-capability", "conflict", "offline-reconnect", "expired-session",
  ]);

  assert.equal((await createFixtureProviderSuite({ scenario: "idle" }).agents.getRun()).data.state, "idle");
  assert.equal((await createFixtureProviderSuite({ scenario: "failure" }).builds.getBuild()).code, "fixture_failure");
  assert.equal((await createFixtureProviderSuite({ scenario: "budget-warning" }).models.getBudget()).data.remainingPercent, 12);
  assert.equal((await createFixtureProviderSuite({ scenario: "waiting-approval" }).plans.getPlan()).data.state, "waiting-approval");
  assert.equal((await createFixtureProviderSuite({ scenario: "expired-session" }).projects.listProjects()).code, "authentication_expired");

  const cancellation = await collect(createFixtureProviderSuite({ scenario: "cancellation" }).agents.subscribeRun());
  assert.equal(cancellation.at(-1).type, "cancelled");
  assert.equal(cancellation.at(-1).terminal, true);
  const recovery = await collect(createFixtureProviderSuite({ scenario: "recovery" }).builds.subscribeBuild());
  assert.deepEqual(recovery.map((event) => event.type), ["interrupted", "recovering", "recovered"]);
  const reconnect = await collect(createFixtureProviderSuite({ scenario: "offline-reconnect" }).conversations.subscribeConversation());
  assert.deepEqual(reconnect.map((event) => event.type), ["running", "offline", "reconnected", "succeeded"]);
});

test("unsupported fixture mutations are explicit, recorded and side-effect free", async () => {
  const suite = createFixtureProviderSuite({ scenario: "unsupported-capability" });
  const before = suite.getState();
  const result = await suite.builds.startBuild({ projectId: "fixture-project-0001" });
  assert.deepEqual({ ok: result.ok, code: result.code, retryable: result.retryable }, {
    ok: false,
    code: "capability_unavailable",
    retryable: false,
  });
  assert.equal(suite.getState().stateRevision, before.stateRevision);
  assert.deepEqual(suite.getCalls().map(({ familyId, operationId }) => [familyId, operationId]), [
    ["build-repair-verification", "startBuild"],
  ]);
});

test("every default fixture mutation fails closed without changing fixture state", async () => {
  const suite = createFixtureProviderSuite();
  let mutationCount = 0;
  for (const [providerKey, definition] of Object.entries(PROVIDER_FAMILIES)) {
    for (const [operationId, kind] of Object.entries(definition.operations)) {
      if (kind !== "mutation") continue;
      mutationCount += 1;
      const result = await suite[providerKey][operationId]({ fixture: true });
      assert.equal(result.ok, false, `${definition.id}.${operationId}`);
      assert.equal(result.code, "capability_unavailable", `${definition.id}.${operationId}`);
      assert.equal(result.retryable, false, `${definition.id}.${operationId}`);
    }
  }
  assert.ok(mutationCount > 20);
  assert.equal(suite.getState().stateRevision, 0);
  assert.equal(suite.getCalls().length, mutationCount);
});

test("conflict fixtures preserve canonical uncertainty instead of inventing Builder V2 behavior", async () => {
  const suite = createFixtureProviderSuite({ scenario: "conflict", capabilities: { builderV2Mutation: true } });
  const result = await suite.snapshots.applyWorkingSet({ baseSnapshotId: "fixture-snapshot-green-0001" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "base_snapshot_conflict");
  assert.equal(result.details.expected, "fixture-snapshot-green-0001");
  assert.equal(suite.getState().stateRevision, 0);
});

test("fixture call recording redacts credentials and never requires a network implementation", async () => {
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = async () => { networkCalls += 1; throw new Error("network must not run"); };
  try {
    const suite = createFixtureProviderSuite({ capabilities: { integrations: true } });
    await suite.integrations.setSecret({ name: "FIXTURE_API_KEY", secret: "sk-this-must-not-appear", authorization: "Bearer private-token" });
    const rendered = JSON.stringify(suite.getCalls());
    assert.doesNotMatch(rendered, /sk-this-must-not-appear|private-token/);
    assert.match(rendered, /\[REDACTED\]/);
    assert.equal(networkCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("host capability negotiation is explicit and fails closed", () => {
  assert.deepEqual(HOST_CAPABILITY_KEYS, [
    "localFilesystem", "localTerminal", "localGit", "cloudWorkspace", "managedBuild",
    "builderV2Mutation", "preview", "browserDiagnostics", "publishing", "integrations",
    "nativeKeychain", "nativeUpdates",
  ]);
  const capabilities = createHostCapabilities({ localFilesystem: true, localTerminal: true });
  assert.equal(capabilities.localFilesystem, true);
  assert.equal(capabilities.cloudWorkspace, false);
  assert.deepEqual(negotiateCapabilities(capabilities, ["localFilesystem", "publishing"]).missing, ["publishing"]);
  assert.throws(() => createHostCapabilities({ hiddenCapability: true }), /Unknown host capabilities/);
});

test("stable API adapters are explicit and read-only with no mutation fallback", async () => {
  const calls = [];
  const transport = {
    request: async (input) => { calls.push(input); return { ok: true, requestId: "read-1", data: [], observedAt: null, source: "http", revision: null }; },
    openEventStream: async () => { throw new Error("not used"); },
  };
  const projects = createStableReadOnlyProvider({
    providerKey: "projects",
    transport,
    operationMap: { listProjects: { method: "GET", path: "/read-only/projects" } },
  });
  assert.equal((await projects.listProjects()).ok, true);
  const blocked = await projects.createProject({ name: "Never sent" });
  assert.equal(blocked.code, "capability_unavailable");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "GET");
  assert.throws(() => createStableReadOnlyProvider({
    providerKey: "projects",
    transport,
    operationMap: { listProjects: { method: "POST", path: "/not-read-only" } },
  }), /refuses POST/);
});

test("HTTP transport injects host auth and request IDs while redacting logs", async () => {
  const seen = [];
  const logs = [];
  const transport = createHttpTransport({
    baseUrl: "https://unit.test",
    authProvider: () => ({ authorization: "Bearer host-secret" }),
    requestIdFactory: () => "request-fixed-1",
    logger: (entry) => logs.push(entry),
    fetchImpl: async (url, init) => {
      seen.push({ url: String(url), init });
      return new Response(JSON.stringify({ value: 7 }), { status: 200, headers: { "content-type": "application/json", etag: "fixture-etag" } });
    },
  });
  const result = await transport.request({
    path: "/read?token=do-not-log",
    operationId: "fixture.read",
    headers: { authorization: "Bearer caller-must-not-override-host" },
  });
  assert.equal(result.requestId, "request-fixed-1");
  assert.equal(result.data.value, 7);
  assert.equal(seen[0].init.headers.authorization, "Bearer host-secret");
  assert.equal(seen[0].init.headers["x-request-id"], "request-fixed-1");
  const renderedLogs = JSON.stringify(logs);
  assert.doesNotMatch(renderedLogs, /host-secret|caller-must-not-override-host|do-not-log/);
  assert.match(renderedLogs, /\?\[REDACTED\]/);
});

test("HTTP retry policy retries safe reads but never an unmarked mutation", async () => {
  let readAttempts = 0;
  const readTransport = createHttpTransport({
    baseUrl: "https://unit.test",
    requestIdFactory: () => "retry-read",
    sleep: async () => {},
    fetchImpl: async () => {
      readAttempts += 1;
      if (readAttempts < 3) return new Response(JSON.stringify({ code: "busy", retryable: true }), { status: 503, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({ recovered: true }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  assert.equal((await readTransport.request({ path: "/safe" })).data.recovered, true);
  assert.equal(readAttempts, 3);

  let mutationAttempts = 0;
  const mutationTransport = createHttpTransport({
    baseUrl: "https://unit.test",
    requestIdFactory: () => "retry-mutation",
    sleep: async () => {},
    fetchImpl: async () => {
      mutationAttempts += 1;
      return new Response(JSON.stringify({ code: "busy", retryable: true }), { status: 503, headers: { "content-type": "application/json" } });
    },
  });
  await assert.rejects(mutationTransport.request({ method: "POST", path: "/mutation", body: {} }), ThralloClientError);
  assert.equal(mutationAttempts, 1);
});

test("typed error mapping and cancellation redact tokens and secrets", async () => {
  const transport = createHttpTransport({
    baseUrl: "https://unit.test",
    requestIdFactory: () => "expired-request",
    fetchImpl: async () => new Response(JSON.stringify({
      code: "invalid_token",
      message: "Bearer secret-session expired",
      token: "thrallo_pat_private-value",
    }), { status: 401, headers: { "content-type": "application/json" } }),
  });
  const error = await transport.request({ path: "/expired" }).catch((caught) => caught);
  assert.ok(error instanceof AuthenticationExpiredError);
  assert.doesNotMatch(JSON.stringify(error), /secret-session|private-value/);
  assert.match(JSON.stringify(error), /\[REDACTED\]/);

  const authFailure = createHttpTransport({
    baseUrl: "https://unit.test",
    requestIdFactory: () => "auth-provider-failure",
    authProvider: () => { throw new Error("Bearer host-auth-secret could not refresh"); },
    fetchImpl: async () => { throw new Error("must not run"); },
  });
  const mappedAuthFailure = await authFailure.request({ path: "/auth" }).catch((caught) => caught);
  assert.ok(mappedAuthFailure instanceof ThralloClientError);
  assert.doesNotMatch(mappedAuthFailure.message, /host-auth-secret/);
  assert.match(mappedAuthFailure.message, /\[REDACTED\]/);

  const controller = new AbortController();
  controller.abort();
  let invoked = false;
  const cancelled = createHttpTransport({
    baseUrl: "https://unit.test",
    fetchImpl: async () => { invoked = true; return new Response(); },
  });
  await assert.rejects(cancelled.request({ path: "/cancelled", signal: controller.signal }), CancelledError);
  assert.equal(invoked, false);
});

test("SSE parsing preserves ids, event types and JSON payloads", async () => {
  async function* chunks() {
    yield "id: 1\nevent: progress\ndata: {\"progress\":25}\n\n";
    yield "id: 2\ndata: plain";
    yield " text\n\n";
  }
  const events = await collect(parseSseChunks(chunks()));
  assert.deepEqual(events, [
    { id: "1", type: "progress", data: { progress: 25 }, retry: null },
    { id: "2", type: "message", data: "plain text", retry: null },
  ]);
});

test("event consumption reconnects from the last delivered cursor exactly once", async () => {
  const cursors = [];
  const events = await collect(consumeEventStream({
    maxReconnects: 2,
    connect: ({ cursor, attempt }) => {
      cursors.push(cursor);
      return attempt === 1
        ? (async function* first() { yield "id: 1\ndata: {\"step\":1}\n\nid: 2\ndata: {\"step\":2}\n\n"; }())
        : (async function* second() { yield "id: 3\nevent: done\ndata: {\"step\":3,\"terminal\":true}\n\n"; }());
    },
  }));
  assert.deepEqual(cursors, [null, "2"]);
  assert.deepEqual(events.map((event) => event.cursor), ["1", "2", "3"]);
  assert.equal(events.at(-1).data.terminal, true);
});

test("HTTP event transport forwards the explicit cursor as Last-Event-ID", async () => {
  let seenHeaders = null;
  const transport = createHttpTransport({
    baseUrl: "https://unit.test",
    requestIdFactory: () => "stream-request",
    fetchImpl: async (_url, init) => {
      seenHeaders = init.headers;
      return new Response("id: next\nevent: done\ndata: {\"terminal\":true}\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  const opened = await transport.openEventStream({ path: "/events", cursor: "cursor-42" });
  assert.equal(opened.requestId, "stream-request");
  assert.equal(seenHeaders["last-event-id"], "cursor-42");
  assert.deepEqual((await collect(parseSseChunks(opened.chunks))).map((event) => event.id), ["next"]);
});

test("D0 protected paths, Buildr101 denylist and fixture-network guard still pass", () => {
  const result = runGuard();
  assert.ok(result.changedFiles.some((file) => file.startsWith("shared/thrallo-client/")));
  assert.ok(result.changedFiles.every((file) => !file.startsWith("shell/server/lib/builderV2/")));
});
