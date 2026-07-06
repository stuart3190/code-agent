// app-auth — per-app end-user authentication for generated/published apps.
// (PLAN-per-app-auth default lane; deployed to the shared project via the Supabase MCP.)
//
// Published apps are static and cannot reach the Buildr101 shell, so this runs where they CAN
// reach: a Supabase Edge Function on the shared project. Mechanism: each (app_id, email) pair maps
// to a REAL Supabase auth user under an app-scoped synthetic address, so the same person can sign
// up with the same email in ten different apps without collisions — while sessions, refresh
// tokens, and the existing owner-based RLS/storage policies all keep working natively. The real
// email lives in user_metadata.app_email (the SDK surfaces it as user.email) and in the
// app_users mapping table (deny-all RLS; only this function's service role touches it).
//
//   POST { action: "signup" | "signin", appId, email, password }
//     -> 200 { user: { id, email }, session: { access_token, refresh_token } }
//     -> 409 already registered (signup) · 401 invalid login (signin) · 400 bad input
//   POST { action: "reset" } -> 501 (stage 4: needs an email provider — deliberately stubbed)
//
// Callers authenticate with the project anon key (Authorization: Bearer <anon>), which satisfies
// the platform's verify_jwt gate; per-user auth is what this function IS, so there is no user JWT yet.

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SYNTH_DOMAIN = "apps.buildr101.com";

const svc = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...CORS } });

async function syntheticEmail(appId: string, email: string): Promise<string> {
  const data = new TextEncoder().encode(`${appId}|${email.toLowerCase()}`);
  const hash = await crypto.subtle.digest("SHA-256", data);
  const hex = Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
  return `u.${hex.slice(0, 32)}@${SYNTH_DOMAIN}`;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json(405, { error: "POST only" });

  let body: { action?: string; appId?: string; email?: string; password?: string };
  try { body = await req.json(); } catch { return json(400, { error: "invalid JSON" }); }
  const action = String(body.action || "");
  const appId = String(body.appId || "").trim();
  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");

  if (action === "reset") {
    return json(501, { error: "Password reset isn't available yet for this app." });
  }
  if (!["signup", "signin"].includes(action)) return json(400, { error: "action must be signup or signin" });
  if (!appId || !/^[\w.-]{1,64}$/.test(appId)) return json(400, { error: "valid appId required" });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(400, { error: "valid email required" });
  if (password.length < 8) return json(400, { error: "password must be at least 8 characters" });

  const synth = await syntheticEmail(appId, email);
  const { data: existing, error: lookupErr } = await svc
    .from("app_users").select("id, auth_user_id").eq("app_id", appId).eq("email", email).maybeSingle();
  if (lookupErr) return json(500, { error: `lookup failed: ${lookupErr.message}` });

  if (action === "signup") {
    if (existing) return json(409, { error: "An account with this email already exists for this app — sign in instead." });
    const { data: created, error: createErr } = await svc.auth.admin.createUser({
      email: synth,
      password,
      email_confirm: true, // app end-users are confirmed by construction; reset flow is stage 4
      user_metadata: { app_id: appId, app_email: email },
    });
    if (createErr) return json(500, { error: `signup failed: ${createErr.message}` });
    const { error: mapErr } = await svc.from("app_users").insert({
      app_id: appId, email, auth_user_id: created.user.id,
    });
    if (mapErr) { // roll back the auth user so a retry works
      await svc.auth.admin.deleteUser(created.user.id).catch(() => {});
      return json(500, { error: `signup failed: ${mapErr.message}` });
    }
  } else if (!existing) {
    return json(401, { error: "Invalid email or password." });
  }

  // Both paths end in a REAL password sign-in against the synthetic address -> native session.
  const anon = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
  const { data: signed, error: signErr } = await anon.auth.signInWithPassword({ email: synth, password });
  if (signErr || !signed.session) return json(401, { error: "Invalid email or password." });

  return json(200, {
    user: { id: signed.user.id, email }, // the REAL email, not the synthetic one
    session: {
      access_token: signed.session.access_token,
      refresh_token: signed.session.refresh_token,
    },
  });
});
