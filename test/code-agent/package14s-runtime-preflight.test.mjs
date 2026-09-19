import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { createBuilderV2Runtime } from "../../shell/server/lib/builderV2/runtimeComposition.mjs";
import {
  proveGeneratedRuntimeBackend, publicRuntimeConfig, withRuntimeEnv,
} from "../../shell/server/lib/runtimeEnv.mjs";
import {
  createSupabaseBackend, ensureAppVisitorSession, invalidateAppVisitorSession,
} from "../../src/scaffolds/reactVite/lib/backend/supabaseBackend.js";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PUBLIC_KEY = "sb_publishable_package14s_public";
const SERVICE_KEY = "sb_secret_package14s_server_only";

function env(overrides = {}) {
  return {
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_PUBLISHABLE_KEY: PUBLIC_KEY,
    SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
    PUBLIC_URL: "https://app.thrallo.com",
    ...overrides,
  };
}

function cleanupAdmin(deletedUsers = []) {
  const query = (value = { error: null }) => {
    const q = { eq: () => q, then: (resolve, reject) => Promise.resolve(value).then(resolve, reject) };
    return q;
  };
  return {
    auth: { admin: { deleteUser: async (id) => { deletedUsers.push(id); return { error: null }; } } },
    from: () => ({ delete: () => query(), select: () => query({ data: [], error: null }) }),
  };
}

test("14S exact missing-public-key regression fails before context or provider dispatch", async () => {
  let contextCalls = 0;
  const missing = env({ SUPABASE_PUBLISHABLE_KEY: "", SUPABASE_ANON_KEY: "" });
  const runtime = createBuilderV2Runtime({
    client: {}, requireWorker: false, preview: { mode: "vps" }, assets: {}, snapshots: {}, reservations: {},
    runtimePreflight: () => proveGeneratedRuntimeBackend({ projectId: PROJECT, env: missing,
      adminClient: cleanupAdmin() }),
    contextResolver: async () => { contextCalls += 1; throw new Error("provider context must not resolve"); },
  });
  await assert.rejects(runtime.execute({
    id: "job", owner: OWNER, project_id: PROJECT, build_id: "build", attempts: 1,
    payload: { pipelineVersion: "v2", input: { prompt: "booking" } },
  }), (error) => error.code === "runtime_public_config_missing"
    && error.dispatchState === "before_dispatch" && error.retryable === false);
  assert.equal(contextCalls, 0);
});

test("14S materialization contains the exact generated public auth runtime and no privileged key", () => {
  const runtime = withRuntimeEnv({ "src/App.jsx": "export default null" }, PROJECT, {
    env: env(), required: true,
  });
  assert.match(runtime[".env"], /VITE_SUPABASE_URL=https:\/\/example\.supabase\.co/);
  assert.match(runtime[".env"], new RegExp(`VITE_SUPABASE_ANON_KEY=${PUBLIC_KEY}`));
  assert.match(runtime[".env"], new RegExp(`VITE_APP_ID=${PROJECT}`));
  assert.match(runtime[".env"], /VITE_AUTH_URL=https:\/\/example\.supabase\.co\/functions\/v1\/app-auth/);
  assert.doesNotMatch(runtime[".env"], /SUPABASE_SERVICE_ROLE|sb_secret_/);
  assert.equal(publicRuntimeConfig(PROJECT, { env: env() }).source, "SUPABASE_PUBLISHABLE_KEY");
  assert.throws(() => publicRuntimeConfig(PROJECT, {
    env: env({ SUPABASE_PUBLISHABLE_KEY: SERVICE_KEY }),
  }), (error) => error.code === "runtime_public_credential_invalid");
});

test("14S fresh visitor goes directly to app-auth signup instead of generating the former 401", async () => {
  const calls = [];
  const storage = new Map();
  const auth = {
    currentUser: async () => null,
    signIn: async () => { calls.push("signin"); throw Object.assign(new Error("former 401"), { status: 401 }); },
    signUp: async () => { calls.push("signup"); return { id: "visitor" }; },
  };
  const user = await ensureAppVisitorSession({
    auth, appId: PROJECT,
    storage: { getItem: (key) => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
    randomUUID: () => "fresh",
  });
  assert.equal(user.id, "visitor");
  assert.deepEqual(calls, ["signup"], "no expected-failure signin request reaches browser diagnostics");
});

test("14S ten fresh concurrent visitor initializers share one signup and one valid result", async () => {
  const storage = new Map();
  let signupCalls = 0;
  let signinCalls = 0;
  let release;
  const signup = new Promise((resolve) => { release = resolve; });
  const user = { id: "one-visitor" };
  const auth = {
    currentUser: async () => null,
    signIn: async () => { signinCalls += 1; throw new Error("premature sign-in"); },
    signUp: async () => { signupCalls += 1; await signup; return user; },
    signOut: async () => {},
  };
  const calls = Array.from({ length: 10 }, () => ensureAppVisitorSession({
    auth, appId: PROJECT,
    storage: { getItem: (key) => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
    randomUUID: () => "single-flight",
  }));
  await Promise.resolve();
  release();
  const users = await Promise.all(calls);
  assert.equal(signupCalls, 1);
  assert.equal(signinCalls, 0);
  assert.ok(users.every((value) => value === user));
});

test("14S persisted visitor recovery is idempotent-signup single-flight and never emits a signin 401", async () => {
  const credentials = JSON.stringify({ email: "visitor@visitor.local", password: "secret" });
  const storage = { getItem: () => credentials, setItem: () => {} };
  let attempts = 0;
  let signinAttempts = 0;
  const recovered = { id: "recovered" };
  const auth = {
    currentUser: async () => null,
    signUp: async () => {
      attempts += 1;
      await new Promise((resolve) => setImmediate(resolve));
      return recovered;
    },
    signIn: async () => { signinAttempts += 1; throw Object.assign(new Error("former 401"), { status: 401 }); },
    signOut: async () => {},
  };
  const first = await Promise.all(Array.from({ length: 10 }, () => ensureAppVisitorSession({ auth, appId: PROJECT, storage })));
  assert.equal(attempts, 1);
  assert.equal(signinAttempts, 0);
  assert.ok(first.every((value) => value === recovered));

  let freshAttempts = 0;
  const failingAuth = { currentUser: async () => null, signIn: async () => null,
    signUp: async () => { freshAttempts += 1; await new Promise((resolve) => setImmediate(resolve));
      if (freshAttempts === 1) throw new Error("auth unavailable"); return recovered; }, signOut: async () => {} };
  const emptyStorage = { getItem: () => null, setItem: () => {} };
  await assert.rejects(Promise.all(Array.from({ length: 4 }, () => ensureAppVisitorSession({
    auth: failingAuth, appId: "failed-app", storage: emptyStorage,
  }))), /auth unavailable/);
  assert.equal(freshAttempts, 1, "all failed waiters share one initialization attempt");
  assert.equal((await ensureAppVisitorSession({ auth: failingAuth, appId: "failed-app", storage: emptyStorage })).id, "recovered");
  assert.equal(freshAttempts, 2, "a failed flight is cleared for a legitimate retry");
});

test("14S interrupted first load retries the saved visitor with idempotent signup, never signin", async () => {
  const values = new Map();
  const storage = { getItem: (key) => values.get(key) || null, setItem: (key, value) => values.set(key, value) };
  const user = { id: "same-visitor" };
  let signupCalls = 0;
  let signinCalls = 0;
  let releaseFirst;
  const firstPending = new Promise((resolve) => { releaseFirst = resolve; });
  const firstAuth = {
    currentUser: async () => null,
    signUp: async () => { signupCalls += 1; await firstPending; return user; },
    signIn: async () => { signinCalls += 1; throw Object.assign(new Error("race 401"), { status: 401 }); },
    signOut: async () => {},
  };
  const reloadedAuth = {
    currentUser: async () => null,
    signUp: async () => { signupCalls += 1; return user; },
    signIn: async () => { signinCalls += 1; throw Object.assign(new Error("race 401"), { status: 401 }); },
    signOut: async () => {},
  };
  const first = ensureAppVisitorSession({ auth: firstAuth, appId: PROJECT, storage, randomUUID: () => "same" });
  await new Promise((resolve) => setImmediate(resolve));
  const reloaded = ensureAppVisitorSession({ auth: reloadedAuth, appId: PROJECT, storage, randomUUID: () => "unused" });
  assert.equal((await reloaded).id, user.id);
  releaseFirst();
  assert.equal((await first).id, user.id);
  assert.equal(signupCalls, 2, "each isolated browser instance retries the same idempotent signup");
  assert.equal(signinCalls, 0, "the interrupted mapping race cannot emit an expected 401");
});

test("14S session flights are identity scoped and reset invalidates an in-progress initialization", async () => {
  const makeAuth = (id) => ({ currentUser: async () => null, signIn: async () => ({ id }),
    signUp: async () => ({ id }), signOut: async () => {} });
  const left = makeAuth("left");
  const right = makeAuth("right");
  const storage = { getItem: () => null, setItem: () => {} };
  const [a, b, c] = await Promise.all([
    ensureAppVisitorSession({ auth: left, appId: "app-a", storage, randomUUID: () => "a" }),
    ensureAppVisitorSession({ auth: left, appId: "app-b", storage, randomUUID: () => "b" }),
    ensureAppVisitorSession({ auth: right, appId: "app-a", storage, randomUUID: () => "c" }),
  ]);
  assert.deepEqual([a.id, b.id, c.id], ["left", "left", "right"]);

  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  let signOuts = 0;
  const resetAuth = { currentUser: async () => null, signIn: async () => null,
    signUp: async () => { await pending; return { id: "late" }; }, signOut: async () => { signOuts += 1; } };
  const initializing = ensureAppVisitorSession({ auth: resetAuth, appId: PROJECT, storage, randomUUID: () => "late" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(invalidateAppVisitorSession({ auth: resetAuth, appId: PROJECT }), true);
  release();
  await assert.rejects(initializing, (error) => error.code === "visitor_session_reset");
  assert.equal(signOuts, 1);
});

test("14S exact generated app-auth runtime shares initialization across concurrent entity operations", async (t) => {
  let signupCalls = 0;
  let signinCalls = 0;
  let entityCalls = 0;
  const token = [Buffer.from('{"alg":"HS256"}').toString("base64url"),
    Buffer.from(JSON.stringify({ sub: "visitor", role: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url"),
    "c2lnbmF0dXJl"].join(".");
  const server = http.createServer(async (request, response) => {
    const body = await new Promise((resolve) => { let value = ""; request.on("data", (chunk) => { value += chunk; }); request.on("end", () => resolve(value)); });
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/functions/v1/app-auth") {
      const input = JSON.parse(body);
      if (input.action === "signup") { signupCalls += 1; await new Promise((resolve) => setTimeout(resolve, 20)); }
      if (input.action === "signin") signinCalls += 1;
      response.end(JSON.stringify({ user: { id: "visitor", email: input.email }, session: { access_token: token, refresh_token: "refresh" } }));
      return;
    }
    if (request.url.startsWith("/auth/v1/user")) { response.end(JSON.stringify({ id: "visitor", role: "authenticated" })); return; }
    if (request.url.startsWith("/auth/v1/logout")) { response.statusCode = 204; response.end(); return; }
    if (request.url.startsWith("/rest/v1/entities") && request.method === "POST") {
      entityCalls += 1; response.statusCode = 201;
      response.end(JSON.stringify([{ id: `row-${entityCalls}`, type: "proof", data: JSON.parse(body).data, owner: "visitor" }])); return;
    }
    response.statusCode = 404; response.end(JSON.stringify({ message: "not found" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const backend = createSupabaseBackend({ url: `http://127.0.0.1:${address.port}`, anonKey: PUBLIC_KEY,
    appId: PROJECT, authUrl: `http://127.0.0.1:${address.port}/functions/v1/app-auth` });
  const storage = new Map();
  const ensure = () => ensureAppVisitorSession({ auth: backend.auth, appId: PROJECT,
    storage: { getItem: (key) => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
    randomUUID: () => "exact-runtime" });
  const rows = await Promise.all(Array.from({ length: 10 }, async (_, index) => {
    await ensure();
    return backend.db.entity("proof").create({ index });
  }));
  assert.equal(signupCalls, 1);
  assert.equal(signinCalls, 0);
  assert.equal(entityCalls, 10);
  assert.equal(rows.length, 10);
  await backend.auth.signOut();
  await ensure();
  assert.equal(signupCalls, 2, "logout invalidates the initialized session and idempotent signup recovers once");
  assert.equal(signinCalls, 0, "visitor recovery never emits an expected signin failure");
});

test("14S preflight uses VITE_AUTH_URL app-auth, recovers the visitor, and completes authenticated CRUD", async (t) => {
  const requests = [];
  let row = null;
  let user = null;
  const accessToken = [
    Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify({ sub: "runtime-user", role: "authenticated",
      exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url"),
    "c2lnbmF0dXJl",
  ].join(".");
  const server = http.createServer(async (request, response) => {
    const body = await new Promise((resolve) => {
      let value = "";
      request.on("data", (chunk) => { value += chunk; });
      request.on("end", () => resolve(value));
    });
    requests.push({ method: request.method, url: request.url, origin: request.headers.origin,
      apikey: request.headers.apikey, authorization: request.headers.authorization,
      body: request.url.startsWith("/functions/v1/app-auth") ? JSON.parse(body || "{}") : null });
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/functions/v1/app-auth") {
      const input = JSON.parse(body);
      if (input.action === "signup") user = { id: "runtime-user", email: input.email };
      if (!user) { response.statusCode = 401; response.end(JSON.stringify({ error: "Invalid email or password." })); return; }
      response.end(JSON.stringify({ user, session: {
        access_token: accessToken, refresh_token: "runtime-session-refresh",
      } }));
      return;
    }
    if (request.url.startsWith("/auth/v1/user")) { response.end(JSON.stringify({ ...user, aud: "authenticated", role: "authenticated" })); return; }
    if (request.url.startsWith("/auth/v1/logout")) { response.statusCode = 204; response.end(); return; }
    if (request.url.startsWith("/rest/v1/entities") && request.method === "POST") {
      const input = JSON.parse(body);
      row = { id: "runtime-entity", type: input.type, data: input.data, app_id: input.app_id,
        owner: "runtime-user", created_at: "2026-08-09T00:00:00Z" };
      response.statusCode = 201; response.end(JSON.stringify([row])); return;
    }
    if (request.url.startsWith("/rest/v1/entities") && request.method === "PATCH") {
      row = { ...row, data: JSON.parse(body).data };
      response.end(JSON.stringify([row])); return;
    }
    if (request.url.startsWith("/rest/v1/entities") && request.method === "GET") {
      response.setHeader("Content-Range", row ? "0-0/1" : "*/0");
      response.end(JSON.stringify(request.headers.accept?.includes("vnd.pgrst.object") ? row : row ? [row] : []));
      return;
    }
    if (request.url.startsWith("/rest/v1/entities") && request.method === "DELETE") {
      row = null; response.statusCode = 204; response.end(); return;
    }
    response.statusCode = 404; response.end(JSON.stringify({ message: "not found" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const deletedUsers = [];
  const proof = await proveGeneratedRuntimeBackend({
    projectId: PROJECT, adminClient: cleanupAdmin(deletedUsers),
    env: env({ SUPABASE_URL: `http://127.0.0.1:${address.port}` }),
    randomUUID: () => "22222222-2222-4222-8222-222222222222",
  });
  assert.deepEqual(proof, {
    ok: true, source: "SUPABASE_PUBLISHABLE_KEY",
    materialized: ["VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY", "VITE_APP_ID", "VITE_AUTH_URL"],
    backendInitialised: true, appAuth: true, visitorSession: true,
    createReadUpdateDelete: true, sessionRecovery: true, cleanup: true,
  });
  assert.equal(row, null);
  assert.deepEqual(deletedUsers, ["runtime-user"]);
  const appAuth = requests.filter((request) => request.url === "/functions/v1/app-auth");
  assert.deepEqual(appAuth.map((request) => request.body.action), ["signup", "signup"]);
  assert.ok(appAuth.every((request) => request.origin
    === "https://p11111111111141118111111111111111.preview.thrallo.com"));
  assert.ok(appAuth.every((request) => request.apikey === PUBLIC_KEY));
  assert.ok(appAuth.every((request) => request.authorization === undefined),
    "opaque publishable keys belong in apikey; Authorization is reserved for a user JWT");
  assert.deepEqual(requests.filter((request) => request.url.startsWith("/rest/v1/entities"))
    .map((request) => request.method), ["POST", "GET", "PATCH", "GET", "DELETE"]);
  assert.ok(requests.every((request) => request.apikey === PUBLIC_KEY));
  assert.ok(requests.every((request) => !JSON.stringify(request).includes(SERVICE_KEY)));
});

test("14S static contracts skip app-auth and entity probes after zero-network runtime proof", async () => {
  let backendCalls = 0;
  const proof = await proveGeneratedRuntimeBackend({
    projectId: PROJECT, env: env(), requirements: { accounts: false, durableMutation: false },
    backendFactory: () => { backendCalls += 1; throw new Error("must not initialise"); },
  });
  assert.equal(backendCalls, 0);
  assert.equal(proof.skipped, "contract_requires_no_accounts_or_durable_mutation");
  assert.equal(proof.appAuth, false);
  assert.equal(proof.createReadUpdateDelete, false);
});

test("14S app-auth failure is machine-readable with the exact failing stage before provider dispatch", async () => {
  await assert.rejects(proveGeneratedRuntimeBackend({
    projectId: PROJECT, adminClient: cleanupAdmin(), env: env(),
    backendFactory: () => ({
      _client: {},
      auth: { currentUser: async () => null,
        signUp: async () => { throw Object.assign(new Error("unauthorized"), {
          code: "app_auth_request_failed", status: 401,
        }); },
        signIn: async () => null },
      db: { entity: () => ({}) },
    }),
  }), (error) => error.code === "runtime_app_auth_preflight_failed"
    && error.stage === "app_auth_visitor_signup" && error.status === 401
    && error.retryable === true
    && error.dispatchState === "before_dispatch");
});

test("14S non-request runtime failures remain terminal before provider dispatch", async () => {
  await assert.rejects(proveGeneratedRuntimeBackend({
    projectId: PROJECT, adminClient: cleanupAdmin(), env: env(),
    backendFactory: () => { throw new Error("generated backend is malformed"); },
  }), (error) => error.code === "runtime_app_auth_preflight_failed"
    && error.stage === "generated_runtime_initialization"
    && error.retryable === false
    && error.dispatchState === "before_dispatch");
});

test("14S the app-auth refusal carries the upstream status, action and sentence into the record", async () => {
  // A live 403 (job 7688aea2, 2026-08-22) was recorded as "(app_auth_request_failed)" alone. The
  // status, the action and the function's own sentence are the ONLY things that separate an
  // ineligible-origin refusal from a disabled account or a rate limit, and by the time anyone
  // read the record the transient had cleared and the evidence existed nowhere.
  await assert.rejects(proveGeneratedRuntimeBackend({
    projectId: PROJECT, adminClient: cleanupAdmin(), env: env(),
    backendFactory: () => ({
      _client: {},
      auth: { currentUser: async () => null,
        signUp: async () => { throw Object.assign(
          new Error("This application is not eligible for authentication."),
          { code: "app_auth_request_failed", status: 403, action: "signup" },
        ); },
        signIn: async () => null },
      db: { entity: () => ({}) },
    }),
  }), (error) => error.code === "runtime_app_auth_preflight_failed"
    && error.status === 403
    && error.action === "signup"
    && error.upstream === "This application is not eligible for authentication."
    && error.message.includes("HTTP 403")
    && error.message.includes("action=signup")
    && error.message.includes("This application is not eligible for authentication.")
    && error.message.includes("no additional provider call was made"));
});
