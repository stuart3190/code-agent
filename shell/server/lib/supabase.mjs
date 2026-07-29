// Supabase clients for the server.
//   * serviceClient()  — SERVICE_ROLE key, bypasses RLS. Used ONLY for platform writes the
//     webhook/engine perform on behalf of any user (ledger grant/debit), exactly like PHASE-4-LIVE.
//   * ownerFromToken(jwt) — verifies a user's access token via the ANON client and returns their
//     uuid (auth.uid()). This is how the server scopes every request to its caller; it never trusts
//     an owner id sent in the request body.
//
// User DATA (projects) is NOT read/written here — that stays client-side through the backend SDK so
// RLS enforces owner-scoping (the honest Phase 3 path).

import { createClient } from "@supabase/supabase-js";
import { requireEnv, optionalEnv } from "./env.mjs";

let _service = null;
export function serviceClient() {
  if (_service) return _service;
  const url = requireEnv("SUPABASE_URL");
  // Match the proven proveBilling.mjs name (SUPABASE_SERVICE_ROLE_KEY); accept the shorter alias too.
  const key = optionalEnv("SUPABASE_SERVICE_ROLE_KEY") || requireEnv("SUPABASE_SERVICE_ROLE");
  _service = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return _service;
}

let _anon = null;
function anonClient() {
  if (_anon) return _anon;
  const url = requireEnv("SUPABASE_URL");
  const key = requireEnv("SUPABASE_ANON_KEY");
  _anon = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return _anon;
}

// Verify a bearer token and return { id, email } or null. The uuid is the RLS subject (auth.uid()).
export async function ownerFromToken(accessToken) {
  if (!accessToken) return null;
  const { data, error } = await anonClient().auth.getUser(accessToken);
  if (error || !data?.user) return null;
  return { id: data.user.id, email: data.user.email ?? null };
}

// Service-role routes bypass RLS, so every project-scoped operation must prove ownership here.
// Return null for both a missing project and somebody else's project to avoid an ID oracle.
export async function ownedProject(ownerId, projectId, columns = "id", client = serviceClient()) {
  if (!ownerId || !projectId) return null;
  const { data, error } = await client
    .from("projects")
    .select(columns)
    .eq("id", projectId)
    .eq("owner", ownerId)
    .maybeSingle();
  if (error) throw new Error(`project lookup failed: ${error.message}`);
  return data || null;
}

// Pull the bearer token out of an incoming request's Authorization header.
export function bearer(req) {
  const h = req.headers["authorization"] || req.headers["Authorization"];
  if (!h || typeof h !== "string") return null;
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

export function haveSupabaseEnv() {
  const svc = optionalEnv("SUPABASE_SERVICE_ROLE_KEY") || optionalEnv("SUPABASE_SERVICE_ROLE");
  return !!(optionalEnv("SUPABASE_URL") && svc && optionalEnv("SUPABASE_ANON_KEY"));
}
