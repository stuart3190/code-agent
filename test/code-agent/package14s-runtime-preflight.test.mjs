import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { createBuilderV2Runtime } from "../../shell/server/lib/builderV2/runtimeComposition.mjs";
import {
  proveGeneratedRuntimeBackend, publicRuntimeConfig, withRuntimeEnv,
} from "../../shell/server/lib/runtimeEnv.mjs";

const PROJECT = "11111111-1111-4111-8111-111111111111";
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

test("14S exact missing-public-key regression fails before context or provider dispatch", async () => {
  let contextCalls = 0;
  let backendCalls = 0;
  const missing = env({ SUPABASE_PUBLISHABLE_KEY: "", SUPABASE_ANON_KEY: "" });
  const runtime = createBuilderV2Runtime({
    client: {}, requireWorker: false, preview: { mode: "vps" }, assets: {}, snapshots: {}, reservations: {},
    runtimePreflight: () => proveGeneratedRuntimeBackend({
      projectId: PROJECT, env: missing,
      adminClient: { auth: { admin: { createUser: async () => { backendCalls += 1; } } } },
    }),
    contextResolver: async () => { contextCalls += 1; throw new Error("provider context must not resolve"); },
  });
  await assert.rejects(runtime.execute({
    id: "job", owner: "owner", project_id: PROJECT, build_id: "build", attempts: 1,
    payload: { pipelineVersion: "v2", input: { prompt: "booking" } },
  }), (error) => error.code === "runtime_public_config_missing"
    && error.dispatchState === "before_dispatch" && error.retryable === false);
  assert.equal(contextCalls, 0);
  assert.equal(backendCalls, 0);
});

test("14S materialization contains only public runtime values and the project identity", () => {
  const runtime = withRuntimeEnv({ "src/App.jsx": "export default null" }, PROJECT, {
    env: env(), required: true,
  });
  assert.match(runtime[".env"], new RegExp(`VITE_SUPABASE_URL=https://example\\.supabase\\.co`));
  assert.match(runtime[".env"], new RegExp(`VITE_SUPABASE_ANON_KEY=${PUBLIC_KEY}`));
  assert.match(runtime[".env"], new RegExp(`VITE_APP_ID=${PROJECT}`));
  assert.doesNotMatch(runtime[".env"], /SUPABASE_SERVICE_ROLE|sb_secret_/);
  assert.equal(publicRuntimeConfig(PROJECT, { env: env() }).source, "SUPABASE_PUBLISHABLE_KEY");
  assert.throws(() => publicRuntimeConfig(PROJECT, {
    env: env({ SUPABASE_PUBLISHABLE_KEY: SERVICE_KEY }),
  }), (error) => error.code === "runtime_public_credential_invalid");
});

test("14S public generated backend initialises and completes disposable write/read/delete", async (t) => {
  const requests = [];
  let row = null;
  const server = http.createServer(async (request, response) => {
    const body = await new Promise((resolve) => {
      let value = "";
      request.on("data", (chunk) => { value += chunk; });
      request.on("end", () => resolve(value));
    });
    requests.push({ method: request.method, url: request.url, apikey: request.headers.apikey,
      authorization: request.headers.authorization, body });
    response.setHeader("Content-Type", "application/json");
    if (request.url.startsWith("/auth/v1/token")) {
      response.end(JSON.stringify({ access_token: "public-session-access", refresh_token: "public-session-refresh",
        expires_in: 3600, token_type: "bearer", user: { id: "runtime-user", email: "runtime@example.com",
          aud: "authenticated", role: "authenticated" } }));
      return;
    }
    if (request.url.startsWith("/rest/v1/entities") && request.method === "POST") {
      const input = JSON.parse(body);
      row = { id: "runtime-entity", type: input.type, data: input.data, app_id: input.app_id,
        owner: "runtime-user", created_at: "2026-08-09T00:00:00Z" };
      response.statusCode = 201;
      response.end(JSON.stringify([row]));
      return;
    }
    if (request.url.startsWith("/rest/v1/entities") && request.method === "GET") {
      response.setHeader("Content-Range", row ? "0-0/1" : "*/0");
      response.end(JSON.stringify(row ? [row] : []));
      return;
    }
    if (request.url.startsWith("/rest/v1/entities") && request.method === "DELETE") {
      row = null;
      response.statusCode = 204;
      response.end();
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ message: "not found" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const deletedUsers = [];
  const adminClient = {
    auth: { admin: {
      createUser: async ({ email }) => ({ data: { user: { id: "runtime-user", email } }, error: null }),
      deleteUser: async (id) => { deletedUsers.push(id); return { data: {}, error: null }; },
    } },
    from: () => ({ delete: () => ({ eq: () => ({ eq: async () => ({ error: null }) }) }) }),
  };
  const proof = await proveGeneratedRuntimeBackend({
    projectId: PROJECT, adminClient,
    env: env({ SUPABASE_URL: `http://127.0.0.1:${address.port}` }),
    randomUUID: () => "22222222-2222-4222-8222-222222222222",
  });
  assert.deepEqual(proof, {
    ok: true, source: "SUPABASE_PUBLISHABLE_KEY",
    materialized: ["VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY", "VITE_APP_ID"],
    backendInitialised: true, readWriteSmoke: true, cleanup: true,
  });
  assert.equal(row, null, "the public-path entity is removed");
  assert.deepEqual(deletedUsers, ["runtime-user"]);
  assert.deepEqual(requests.filter((request) => request.url.startsWith("/rest/v1/entities"))
    .map((request) => request.method), ["POST", "GET", "DELETE"]);
  assert.ok(requests.every((request) => request.apikey === PUBLIC_KEY));
  assert.ok(requests.every((request) => !JSON.stringify(request).includes(SERVICE_KEY)));
});

test("14S a failed backend smoke is a machine-readable pre-dispatch platform error", async () => {
  const adminClient = {
    auth: { admin: {
      createUser: async () => ({ data: { user: { id: "runtime-user" } }, error: null }),
      deleteUser: async () => ({ data: {}, error: null }),
    } },
    from: () => ({ delete: () => ({ eq: () => ({ eq: async () => ({ error: null }) }) }) }),
  };
  await assert.rejects(proveGeneratedRuntimeBackend({
    projectId: PROJECT, adminClient, env: env(),
    backendFactory: () => ({ _client: { auth: { signInWithPassword: async () => ({
      data: {}, error: Object.assign(new Error("bad public credential"), { code: "invalid_key" }),
    }) } }, db: { entity: () => ({}) } }),
  }), (error) => error.code === "runtime_backend_preflight_failed"
    && error.stage === "public_read_write_smoke" && error.dispatchState === "before_dispatch");
});
