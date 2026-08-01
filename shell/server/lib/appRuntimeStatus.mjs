// Per-app backend runtime probe (cached): is app-auth deployed and the entities store
// present? runJob gates on this when a generated app actually uses the backend SDK — a
// build must never report success against a dead backend (Stuart, 2026-07-31).

import { optionalEnv } from "./env.mjs";

let cache = null; // { at, value: { ready, reason } }
const TTL_MS = 5 * 60_000;

export async function backendRuntimeReady({ fetchImpl = fetch, force = false } = {}) {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.value;
  const url = optionalEnv("SUPABASE_URL");
  const anonKey = optionalEnv("SUPABASE_ANON_KEY");
  let value;
  if (!url || !anonKey) {
    value = { ready: false, reason: "SUPABASE_URL / SUPABASE_ANON_KEY are not configured on the server." };
  } else {
    try {
      const authRes = await fetchImpl(`${url}/functions/v1/app-auth`, {
        method: "OPTIONS",
        headers: { Authorization: `Bearer ${anonKey}`, apikey: anonKey },
        signal: AbortSignal.timeout(5_000),
      });
      if (authRes.status === 404) {
        value = { ready: false, reason: "The app-auth Edge Function is not deployed." };
      } else {
        const rest = await fetchImpl(`${url}/rest/v1/entities?select=id&limit=0`, {
          headers: { Authorization: `Bearer ${anonKey}`, apikey: anonKey },
          signal: AbortSignal.timeout(5_000),
        });
        // 200 (RLS-empty) or 401/permission responses mean the table EXISTS; PostgREST
        // answers 404 with a relation error only when it doesn't.
        value = rest.status === 404
          ? { ready: false, reason: "The entities store is missing." }
          : { ready: true, reason: null };
      }
    } catch (error) {
      value = { ready: false, reason: `Backend runtime probe failed: ${error.message}` };
    }
  }
  cache = { at: Date.now(), value };
  return value;
}

// True only when APP CODE actually imports the backend SDK. The scaffold always ships the
// SDK files themselves, so file presence is meaningless — gating on it made the Verifier
// demand signup flows from explicitly backend-less apps (caught by build diagnostics
// 17e00fd2 on 2026-07-31: "Signup: no email/password fields found" on a no-account app).
export function treeUsesBackendSdk(tree) {
  if (!tree) return false;
  return Object.entries(tree).some(([path, content]) =>
    !String(path).startsWith("src/lib/backend/")
    && /(?:from\s+|require\()\s*["'][^"']*lib\/backend/.test(String(content)));
}

export function resetBackendRuntimeCacheForTests() {
  cache = null;
}
