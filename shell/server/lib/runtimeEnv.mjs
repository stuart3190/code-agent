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
import { createSupabaseBackend } from "../../../src/scaffolds/reactVite/lib/backend/supabaseBackend.js";

const PREFLIGHT_ENTITY = "__thrallo_runtime_preflight";

function configurationError(code, message, details = {}) {
  return Object.assign(new Error(message), {
    code,
    retryable: false,
    dispatchState: "before_dispatch",
    platformConfiguration: true,
    ...details,
  });
}

/** Resolve only values that are intentionally safe to ship to generated browser code. */
export function publicRuntimeConfig(projectId, { env = process.env } = {}) {
  const url = String(env.SUPABASE_URL || "").trim();
  const publishableKey = String(env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY || "").trim();
  const source = env.SUPABASE_PUBLISHABLE_KEY ? "SUPABASE_PUBLISHABLE_KEY" : "SUPABASE_ANON_KEY";
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
  if (publishableKey.startsWith("sb_secret_") || serviceKeys.includes(publishableKey)) {
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

/**
 * Prove the exact generated-browser backend seam with a disposable authenticated identity and
 * entity. The privileged client is used only to mint/remove that identity and to guarantee
 * cleanup; it is never passed to the generated backend or returned in evidence.
 */
export async function proveGeneratedRuntimeBackend({
  projectId,
  adminClient,
  env = process.env,
  backendFactory = createSupabaseBackend,
  randomUUID = () => crypto.randomUUID(),
} = {}) {
  const runtime = runtimeEnvContents(projectId, { env });
  const materialized = withRuntimeEnv({}, projectId, { env, required: true });
  for (const name of ["VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY", "VITE_APP_ID"]) {
    if (!new RegExp(`^${name}=.+$`, "m").test(materialized[".env"] || "")) {
      throw configurationError("runtime_env_materialization_failed",
        `Builder V2 could not materialize ${name}; no provider call was made.`, { field: name });
    }
  }
  if (!adminClient?.auth?.admin?.createUser || !adminClient?.auth?.admin?.deleteUser) {
    throw configurationError("runtime_backend_preflight_unavailable",
      "Builder V2 runtime backend smoke authority is unavailable; no provider call was made.");
  }

  const nonce = randomUUID().replace(/[^a-z0-9]/gi, "").toLowerCase();
  const smokeAppId = `runtime-preflight-${nonce}`;
  const email = `runtime-preflight-${nonce}@example.com`;
  const password = `Runtime-${nonce}-Aa1!`;
  let userId = null;
  let entityId = null;
  let backend = null;
  let failure = null;
  try {
    const createdUser = await adminClient.auth.admin.createUser({
      email, password, email_confirm: true, user_metadata: { runtime_preflight: true },
    });
    if (createdUser.error || !createdUser.data?.user?.id) throw createdUser.error || new Error("no preflight user id");
    userId = createdUser.data.user.id;
    backend = backendFactory({ url: runtime.config.url, anonKey: runtime.config.publishableKey, appId: smokeAppId });
    if (!backend?._client?.auth?.signInWithPassword || !backend?.db?.entity) throw new Error("generated backend did not initialise");
    const signedIn = await backend._client.auth.signInWithPassword({ email, password });
    if (signedIn.error || !signedIn.data?.user?.id) throw signedIn.error || new Error("public client could not sign in");
    const store = backend.db.entity(PREFLIGHT_ENTITY);
    const created = await store.create({ nonce, purpose: "runtime_preflight" });
    entityId = created?.id || null;
    if (!entityId) throw new Error("public runtime write returned no entity id");
    const listed = await store.list({ filters: { nonce }, limit: 5 });
    if (!listed.some((row) => row.id === entityId)) throw new Error("public runtime read did not return its write");
    await store.delete(entityId);
    entityId = null;
  } catch (error) {
    failure = error;
  } finally {
    if (entityId) {
      const cleanup = await adminClient.from("entities").delete().eq("id", entityId).eq("app_id", smokeAppId);
      if (cleanup.error && !failure) failure = cleanup.error;
    }
    if (userId) {
      const cleanup = await adminClient.auth.admin.deleteUser(userId);
      if (cleanup.error && !failure) failure = cleanup.error;
    }
  }
  if (failure) {
    throw configurationError("runtime_backend_preflight_failed",
      `Builder V2 public runtime backend smoke failed (${failure.code || failure.name || "backend_error"}); no provider call was made.`,
      { stage: "public_read_write_smoke" });
  }
  return {
    ok: true,
    source: runtime.config.source,
    materialized: ["VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY", "VITE_APP_ID"],
    backendInitialised: !!backend?._client,
    readWriteSmoke: true,
    cleanup: true,
  };
}
