// Runtime backend config for generated apps — the "backend as a parameter" rule from
// baseline/DECISION-hosting.md made concrete. At MATERIALIZATION time (build check, preview
// start/update) the tree gains a `.env` carrying the shared Supabase project's public browser
// config plus the per-app namespace id. It is deliberately NEVER written into the durable
// projects.tree and never enters export ZIPs (those keep .env.example placeholders), so a
// different backend can be injected later with no rebuild.
//
// The anon key is the PUBLIC browser key (safe to ship to any preview); the security boundary
// stays the Phase 3.1 owner-scoped RLS. VITE_APP_ID namespaces one user's apps apart.

import crypto from "node:crypto";

import { REACT_VITE } from "../../../src/scaffolds/reactVite.mjs";
import {
  createSupabaseBackend, ensureAppVisitorSession,
} from "../../../src/scaffolds/reactVite/lib/backend/supabaseBackend.js";

const PREFLIGHT_ENTITY = "__thrallo_runtime_preflight";

function previewOrigin(projectId, { env = process.env } = {}) {
  const suffix = String(env.PREVIEW_DOMAIN_SUFFIX || "preview.thrallo.com").trim().toLowerCase();
  const label = `p${String(projectId).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 48) || "x"}`;
  return `https://${label}.${suffix}`;
}

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => { values.set(key, String(value)); },
    removeItem: (key) => { values.delete(key); },
  };
}

function browserFetch(fetchImpl, origin) {
  return (input, init = {}) => {
    const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
    headers.set("Origin", origin);
    return fetchImpl(input, { ...init, headers });
  };
}

function configurationError(code, message, details = {}) {
  return Object.assign(new Error(message), {
    code,
    retryable: false,
    dispatchState: "before_dispatch",
    platformConfiguration: true,
    ...details,
  });
}

function jwtRole(value) {
  const parts = String(value || "").split(".");
  if (parts.length !== 3) return null;
  try { return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"))?.role || null; }
  catch { return null; }
}

/** Resolve only values that are intentionally safe to ship to generated browser code. */
export function publicRuntimeConfig(projectId, { env = process.env } = {}) {
  const url = String(env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
  const publishable = String(env.SUPABASE_PUBLISHABLE_KEY || "").trim();
  const anon = String(env.SUPABASE_ANON_KEY || "").trim();
  const publishableKey = publishable || anon;
  const source = publishable ? "SUPABASE_PUBLISHABLE_KEY" : "SUPABASE_ANON_KEY";
  const appId = String(projectId || "").trim();
  const missing = [];
  if (!url) missing.push("SUPABASE_URL");
  if (!publishableKey) missing.push("SUPABASE_PUBLISHABLE_KEY_OR_ANON_KEY");
  if (!appId) missing.push("VITE_APP_ID");
  if (missing.length) {
    throw configurationError(
      "runtime_public_config_missing",
      `Builder V2 public runtime configuration is incomplete (${missing.join(", ")}); no provider call was made.`,
      { missing },
    );
  }
  let parsed;
  try { parsed = new URL(url); } catch { parsed = null; }
  if (!parsed || !["http:", "https:"].includes(parsed.protocol)) {
    throw configurationError("runtime_public_config_invalid",
      "Builder V2 public runtime Supabase URL is invalid; no provider call was made.",
      { field: "SUPABASE_URL" });
  }
  const serviceKeys = [env.SUPABASE_SERVICE_ROLE_KEY, env.SUPABASE_SERVICE_ROLE, env.SUPABASE_SECRET_KEY]
    .filter(Boolean).map((value) => String(value));
  if (publishableKey.startsWith("sb_secret_") || jwtRole(publishableKey) === "service_role"
      || serviceKeys.includes(publishableKey)) {
    throw configurationError("runtime_public_credential_invalid",
      "Builder V2 refused a privileged Supabase credential for browser materialization; no provider call was made.",
      { field: source });
  }
  const platformUrl = String(env.PUBLIC_URL || env.APP_URL || "https://buildr101.com").replace(/\/$/, "");
  return { url, publishableKey, source, appId, platformUrl };
}

export function runtimeEnvContents(projectId, options = {}) {
  const config = publicRuntimeConfig(projectId, options);
  return {
    config,
    contents: [
      "# Injected at materialization time by the shell — not part of the saved project.",
      `VITE_SUPABASE_URL=${config.url}`,
      `VITE_SUPABASE_ANON_KEY=${config.publishableKey}`,
      `VITE_APP_ID=${config.appId}`,
      `VITE_AUTH_URL=${config.url}/functions/v1/app-auth`,
      `VITE_PAYMENTS_URL=${config.platformUrl}/api/runtime/checkout`,
      `VITE_ACTIONS_URL=${config.url}/functions/v1/app-actions`,
      `VITE_RUNTIME_URL=${config.url}/functions/v1/app-runtime`,
      `VITE_CONNECTORS_URL=${config.platformUrl}/api/runtime/connectors`,
      "",
    ].join("\n"),
  };
}

export function withRuntimeEnv(tree, projectId, { env = process.env, required = false } = {}) {
  let runtime;
  try {
    runtime = runtimeEnvContents(projectId, { env });
  } catch (error) {
    // Downloads and deliberately unconfigured local V1 tooling retain the historical fail-soft
    // behaviour. Builder V2 production calls with required:true and fails before model dispatch.
    if (!required && error?.code === "runtime_public_config_missing") return tree;
    throw error;
  }
  return {
    ...tree,
    // Protected generated SDK files are platform-owned. Refresh them at materialization so an
    // older saved project can use newly added backend surfaces without a manual migration.
    "src/lib/backend/index.js": REACT_VITE["src/lib/backend/index.js"],
    "src/lib/backend/supabaseBackend.js": REACT_VITE["src/lib/backend/supabaseBackend.js"],
    // Keep the fixed dev bridge current in every materialized preview (old projects carry the
    // devReporter version they were built with; it's do-not-edit, so always refresh it). A dead
    // file for pre-F2 trees whose main.jsx doesn't import it — harmless.
    ...(tree["src/lib/devReporter.js"]
      ? { "src/lib/devReporter.js": REACT_VITE["src/lib/devReporter.js"] }
      : {}),
    // VITE_ANALYTICS_URL deliberately remains absent: analytics is a publish-time surface.
    ".env": runtime.contents,
  };
}

/** Zero-network runtime authority proof. Safe to run before contract planning or provider spend. */
export function proveGeneratedRuntimeConfig({ projectId, env = process.env } = {}) {
  const runtime = runtimeEnvContents(projectId, { env });
  const materialized = withRuntimeEnv({}, projectId, { env, required: true });
  const requiredValues = ["VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY", "VITE_APP_ID", "VITE_AUTH_URL"];
  for (const name of requiredValues) {
    if (!new RegExp(`^${name}=.+$`, "m").test(materialized[".env"] || "")) {
      throw configurationError("runtime_env_materialization_failed",
        `Builder V2 could not materialize ${name}; no provider call was made.`, { field: name });
    }
  }
  return { ok: true, source: runtime.config.source, materialized: requiredValues };
}

/**
 * Prove the exact generated-browser backend seam with a disposable authenticated identity and
 * entity. The privileged client is used only to guarantee cleanup after the generated app-auth
 * path creates the identity; it is never passed to the generated backend or returned in evidence.
 */
export async function proveGeneratedRuntimeBackend({
  projectId,
  adminClient,
  requirements = { accounts: true, durableMutation: true },
  env = process.env,
  backendFactory = createSupabaseBackend,
  visitorSession = ensureAppVisitorSession,
  fetchImpl = globalThis.fetch,
  randomUUID = () => crypto.randomUUID(),
} = {}) {
  const runtimeProof = proveGeneratedRuntimeConfig({ projectId, env });
  const runtime = runtimeEnvContents(projectId, { env });
  const needsAccounts = requirements?.accounts === true;
  const needsDurableMutation = requirements?.durableMutation === true;
  if (!needsAccounts && !needsDurableMutation) {
    return {
      ...runtimeProof,
      backendInitialised: false, appAuth: false, visitorSession: false,
      createReadUpdateDelete: false, sessionRecovery: false, cleanup: true,
      skipped: "contract_requires_no_accounts_or_durable_mutation",
    };
  }
  if (!adminClient?.auth?.admin?.deleteUser || !adminClient?.from || typeof fetchImpl !== "function") {
    throw configurationError("runtime_backend_preflight_unavailable",
      "Builder V2 runtime backend smoke authority is unavailable; no provider call was made.");
  }

  const nonce = randomUUID().replace(/[^a-z0-9]/gi, "").toLowerCase();
  const smokeAppId = String(projectId);
  let userId = null;
  let entityId = null;
  let backend = null;
  let failure = null;
  let stage = "generated_runtime_initialization";
  const origin = previewOrigin(smokeAppId, { env });
  const authUrl = `${runtime.config.url}/functions/v1/app-auth`;
  const storage = memoryStorage();
  const generatedFetch = browserFetch(fetchImpl, origin);
  const backendOptions = {
    url: runtime.config.url,
    anonKey: runtime.config.publishableKey,
    appId: smokeAppId,
    authUrl,
    fetchImpl: generatedFetch,
  };
  try {
    backend = backendFactory(backendOptions);
    if (!backend?.auth?.signUp || !backend?.auth?.signIn || !backend?.db?.entity) {
      throw new Error("generated app-scoped backend did not initialise");
    }
    // Entity RLS uses the generated visitor identity even when the product has no customer-facing
    // accounts. That internal namespace bootstrap is required for a durable-mutation proof, but
    // account recovery is not exercised unless accounts are part of the validated contract.
    stage = "app_auth_visitor_signup";
    const signedUp = await visitorSession({
      auth: backend.auth, appId: smokeAppId, storage, randomUUID: () => nonce,
    });
    userId = signedUp?.id || null;
    if (!userId) throw new Error("app-auth returned no visitor identity");
    if (needsDurableMutation) {
      const store = backend.db.entity(PREFLIGHT_ENTITY);
      stage = "authenticated_entity_create";
      const created = await store.create({ nonce, purpose: "runtime_preflight" });
      entityId = created?.id || null;
      if (!entityId) throw new Error("public runtime write returned no entity id");
      stage = "authenticated_entity_read";
      const listed = await store.list({ filters: { nonce }, limit: 5 });
      if (!listed.some((row) => row.id === entityId)) throw new Error("public runtime read did not return its write");
      stage = "authenticated_entity_update";
      const updated = await store.update(entityId, { nonce, purpose: "runtime_preflight", updated: true });
      if (!updated?.data?.updated) throw new Error("public runtime update did not return its change");
    }

    if (needsAccounts) {
      stage = "app_auth_session_recovery";
      await backend.auth.signOut();
      backend = backendFactory(backendOptions);
      const recovered = await visitorSession({
        auth: backend.auth, appId: smokeAppId, storage, randomUUID: () => nonce,
      });
      if (recovered?.id !== userId) throw new Error("app-auth recovery returned a different visitor identity");
      if (needsDurableMutation) {
        const recoveredRow = await backend.db.entity(PREFLIGHT_ENTITY).get(entityId);
        if (recoveredRow?.id !== entityId || !recoveredRow?.data?.updated) {
          throw new Error("recovered generated runtime could not read its entity");
        }
      }
    }

    if (needsDurableMutation) {
      stage = "authenticated_entity_delete";
      await backend.db.entity(PREFLIGHT_ENTITY).delete(entityId);
      entityId = null;
    }
    stage = "runtime_session_close";
    await backend.auth.signOut();
  } catch (error) {
    failure = error;
  } finally {
    const cleanupUserIds = new Set(userId ? [userId] : []);
    try {
      const mappings = await adminClient.from("app_users").select("auth_user_id").eq("app_id", smokeAppId);
      if (mappings.error) throw mappings.error;
      for (const row of mappings.data || []) if (row.auth_user_id) cleanupUserIds.add(row.auth_user_id);
    } catch (error) {
      if (!failure) failure = error;
    }
    if (entityId) {
      const cleanup = await adminClient.from("entities").delete().eq("id", entityId).eq("app_id", smokeAppId);
      if (cleanup.error && !failure) failure = cleanup.error;
    }
    for (const table of ["entities", "app_notifications", "app_auth_events", "app_password_resets", "app_users"]) {
      const cleanup = await adminClient.from(table).delete().eq("app_id", smokeAppId);
      if (cleanup.error && !failure) failure = cleanup.error;
    }
    for (const cleanupUserId of cleanupUserIds) {
      const cleanup = await adminClient.auth.admin.deleteUser(cleanupUserId);
      if (cleanup.error && !failure) failure = cleanup.error;
    }
  }
  if (failure) {
    // app-auth signup is idempotent for the exact visitor credentials. A gateway/network/auth
    // service interruption is therefore safe for the durable worker's single bounded retry, and
    // still occurs before any Builder model reservation or dispatch. Other runtime proof failures
    // remain terminal because replaying their mutations is not proven safe.
    const retryable = failure.code === "app_auth_request_failed";
    // Carry WHAT the upstream said, not merely that it said something. A live 403 was recorded
    // as `(app_auth_request_failed)` alone: the status, the action and the function's own
    // sentence — the only things that distinguish an ineligible-origin refusal from a disabled
    // account or a rate limit — were dropped here, and by the time anyone looked the transient
    // had cleared and the evidence did not exist anywhere.
    const upstreamStatus = Number(failure.status || 0) || null;
    const detail = [
      failure.code || failure.name || "runtime_error",
      upstreamStatus ? `HTTP ${upstreamStatus}` : null,
      failure.action ? `action=${failure.action}` : null,
      failure.message || null,
    ].filter(Boolean).join("; ");
    const code = stage.startsWith("authenticated_entity")
      ? "runtime_entity_preflight_failed" : "runtime_app_auth_preflight_failed";
    throw configurationError(code,
      `Builder V2 generated runtime capability preflight failed at ${stage} (${detail}); no additional provider call was made.`,
      { stage, status: upstreamStatus, action: failure.action || null, upstream: failure.message || null, retryable });
  }
  return {
    ...runtimeProof,
    backendInitialised: !!backend?._client,
    appAuth: needsAccounts,
    visitorSession: true,
    createReadUpdateDelete: needsDurableMutation,
    sessionRecovery: needsAccounts,
    cleanup: true,
  };
}
