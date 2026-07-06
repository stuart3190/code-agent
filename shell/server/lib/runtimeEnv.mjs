// Runtime backend config for generated apps — the "backend as a parameter" rule from
// baseline/DECISION-hosting.md made concrete. At MATERIALIZATION time (build check, preview
// start/update) the tree gains a `.env` carrying the shared Supabase project's public browser
// config plus the per-app namespace id. It is deliberately NEVER written into the durable
// projects.tree and never enters export ZIPs (those keep .env.example placeholders), so a
// different backend can be injected later with no rebuild.
//
// The anon key is the PUBLIC browser key (safe to ship to any preview); the security boundary
// stays the Phase 3.1 owner-scoped RLS. VITE_APP_ID namespaces one user's apps apart.

export function withRuntimeEnv(tree, projectId) {
  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!url || !anonKey) return tree; // unconfigured server -> fail-soft SDK message in the app
  return {
    ...tree,
    ".env": [
      "# Injected at materialization time by the shell — not part of the saved project.",
      `VITE_SUPABASE_URL=${url}`,
      `VITE_SUPABASE_ANON_KEY=${anonKey}`,
      `VITE_APP_ID=${projectId}`,
      "",
    ].join("\n"),
  };
}
