// The browser wires the PROVEN backend SDK (Phase 3) — it does NOT rebuild auth/db/storage.
// createSupabaseBackend is the exact factory the generated apps ship; here it authenticates the
// shell's own user and persists their projects, RLS-scoped to their owner id (auth.uid()).

import { createSupabaseBackend } from "../../../../src/scaffolds/reactVite/lib/backend/supabaseBackend.js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const backendConfigured = !!(url && anonKey);

let _backend = null;
export function backend() {
  if (!backendConfigured) {
    throw new Error("Supabase is not configured — set VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY in shell/web/.env");
  }
  if (!_backend) _backend = createSupabaseBackend({ url, anonKey });
  return _backend;
}

// The raw Supabase client (carries the signed-in session) — used to read the ledger under RLS and
// to fetch the access token attached to server calls.
export function client() {
  return backend()._client;
}

export async function accessToken() {
  const { data } = await client().auth.getSession();
  return data?.session?.access_token ?? null;
}
