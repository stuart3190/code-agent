// Proof: the per-app backend runtime works end-to-end through the EXACT SDK generated apps
// ship — create an account (app-auth Edge Function), persist data (entities + RLS), and
// "reload" (a fresh client resuming the same session) still sees it. Run with SUPABASE_URL
// and SUPABASE_ANON_KEY in the environment (e.g. on the VPS: `cd /home/ubuntu/code-agent &&
// node --env-file=shell/.env scripts/prove-app-backend.mjs`).

import { createSupabaseBackend } from "../src/scaffolds/reactVite/lib/backend/supabaseBackend.js";

const url = process.env.SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY;
if (!url || !anonKey) { console.error("SUPABASE_URL / SUPABASE_ANON_KEY required"); process.exit(1); }

const appId = "probe-app-backend";
const otherAppId = "probe-app-other";
const authUrl = `${url}/functions/v1/app-auth`;
const email = `probe+${Date.now()}@thrallo.dev`;
const password = "prove-me-123!";
const results = [];
const check = (name, ok, detail = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`); };

const backend = createSupabaseBackend({ url, anonKey, appId, authUrl });

// 1) account creation through app-auth
const signedUp = await backend.auth.signUp({ email, password }).catch((e) => ({ error: e.message }));
check("signup creates an account + session", !!signedUp?.id && !signedUp.error, signedUp.error || signedUp.email);

// 2) persist data through db.entity (RLS: owner = auth.uid())
const note = await backend.db.entity("note").create({ title: "hello", body: "persisted by the proof" }).catch((e) => ({ error: e.message }));
check("entity create persists", !!note?.id && !note.error, note.error || note.id);

// 3) reload: a FRESH backend (new client), same credentials via signIn — data still there
const reloaded = createSupabaseBackend({ url, anonKey, appId, authUrl });
const signedIn = await reloaded.auth.signIn({ email, password }).catch((e) => ({ error: e.message }));
check("sign-in after 'reload' restores the session", !!signedIn?.id && !signedIn.error, signedIn.error || signedIn.email);
const notes = await reloaded.db.entity("note").list().catch((e) => ({ error: e.message }));
check("data survives reload", Array.isArray(notes) && notes.some((n) => n.id === note.id), notes.error || `${notes.length ?? 0} note(s)`);

// 4) app namespacing: the same person in ANOTHER app sees an empty store
const other = createSupabaseBackend({ url, anonKey, appId: otherAppId, authUrl });
await other.auth.signUp({ email, password }).catch(() => other.auth.signIn({ email, password }));
const otherNotes = await other.db.entity("note").list().catch(() => []);
check("another app's namespace is empty", Array.isArray(otherNotes) && otherNotes.length === 0, `${otherNotes.length ?? "?"} rows`);

// 5) RLS: anonymous (no session) reads are denied outright
const anon = createSupabaseBackend({ url, anonKey, appId, authUrl });
const anonRead = await anon.db.entity("note").list().catch((e) => ({ error: e.message }));
const anonBlocked = (Array.isArray(anonRead) && anonRead.length === 0) || !!anonRead.error;
check("anonymous access is blocked by RLS", anonBlocked, anonRead.error || "empty for anon");

console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
process.exit(results.every(Boolean) ? 0 : 1);
