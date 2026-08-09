import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { createBuilderV2Runtime } from "../../shell/server/lib/builderV2/runtimeComposition.mjs";
import {
  proveGeneratedRuntimeBackend, publicRuntimeConfig, withRuntimeEnv,
} from "../../shell/server/lib/runtimeEnv.mjs";
import { ensureAppVisitorSession } from "../../src/scaffolds/reactVite/lib/backend/supabaseBackend.js";

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
  assert.deepEqual(appAuth.map((request) => request.body.action), ["signup", "signin"]);
  assert.ok(appAuth.every((request) => request.origin
    === "https://p11111111111141118111111111111111.preview.thrallo.com"));
  assert.deepEqual(requests.filter((request) => request.url.startsWith("/rest/v1/entities"))
    .map((request) => request.method), ["POST", "GET", "PATCH", "GET", "DELETE"]);
  assert.ok(requests.every((request) => request.apikey === PUBLIC_KEY));
  assert.ok(requests.every((request) => !JSON.stringify(request).includes(SERVICE_KEY)));
});

test("14S app-auth failure is machine-readable with the exact failing stage before provider dispatch", async () => {
  await assert.rejects(proveGeneratedRuntimeBackend({
    projectId: PROJECT, adminClient: cleanupAdmin(), env: env(),
    backendFactory: () => ({
      _client: {},
      auth: { currentUser: async () => null,
        signUp: async () => { throw Object.assign(new Error("unauthorized"), { status: 401 }); },
        signIn: async () => null },
      db: { entity: () => ({}) },
    }),
  }), (error) => error.code === "runtime_app_auth_preflight_failed"
    && error.stage === "app_auth_visitor_signup" && error.status === 401
    && error.dispatchState === "before_dispatch");
});
