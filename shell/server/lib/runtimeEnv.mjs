// Runtime backend config for generated apps — the "backend as a parameter" rule from
// baseline/DECISION-hosting.md made concrete. At MATERIALIZATION time (build check, preview
// start/update) the tree gains a `.env` carrying the shared Supabase project's public browser
// config plus the per-app namespace id. It is deliberately NEVER written into the durable
// projects.tree and never enters export ZIPs (those keep .env.example placeholders), so a
// different backend can be injected later with no rebuild.
//
// The anon key is the PUBLIC browser key (safe to ship to any preview); the security boundary
// stays the Phase 3.1 owner-scoped RLS. VITE_APP_ID namespaces one user's apps apart.

import { REACT_VITE } from "../../../src/scaffolds/reactVite.mjs";

export function withRuntimeEnv(tree, projectId) {
  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  const platformUrl = (process.env.PUBLIC_URL || process.env.APP_URL || "https://buildr101.com").replace(/\/$/, "");
  if (!url || !anonKey) return tree; // unconfigured server -> fail-soft SDK message in the app
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
    ".env": [
      "# Injected at materialization time by the shell — not part of the saved project.",
      `VITE_SUPABASE_URL=${url}`,
      `VITE_SUPABASE_ANON_KEY=${anonKey}`,
      `VITE_APP_ID=${projectId}`,
      // Per-app end-user auth (app-auth Edge Function): same email can register in many apps.
      `VITE_AUTH_URL=${url}/functions/v1/app-auth`,
      `VITE_PAYMENTS_URL=${platformUrl}/api/runtime/checkout`,
      `VITE_ACTIONS_URL=${url}/functions/v1/app-actions`,
      `VITE_RUNTIME_URL=${url}/functions/v1/app-runtime`,
      `VITE_CONNECTORS_URL=${platformUrl}/api/runtime/connectors`,
      `VITE_ANALYTICS_URL=${url}/functions/v1/app-analytics`,
      "",
    ].join("\n"),
  };
}
