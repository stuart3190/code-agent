// app-auth — per-app end-user authentication for generated/published apps.
// (PLAN-per-app-auth default lane; deployed to the shared project via the Supabase MCP.)
//
// Published apps are static and cannot reach the shell, so this runs where they CAN
// reach: a Supabase Edge Function on the shared project. Mechanism: each (app_id, email) pair maps
// to a REAL Supabase auth user under an app-scoped synthetic address, so the same person can sign
// up with the same email in ten different apps without collisions — while sessions, refresh
// tokens, and the existing owner-based RLS/storage policies all keep working natively. The real
// email lives in user_metadata.app_email (the SDK surfaces it as user.email) and in the
// app_users mapping table (deny-all RLS; only this function's service role touches it).
//
//   POST { action: "signup" | "signin", appId, email, password }
//     -> 200 { user: { id, email }, session: { access_token, refresh_token } }
//     -> 409 already registered w/ different password (signup) · 401 invalid login (signin) · 400 bad input
//   POST { action: "reset", appId, email }
//     -> 200 { ok: true } ALWAYS (no account enumeration). If the account exists, a 6-digit
//        code is emailed to the REAL address via Resend (RESEND_API_KEY secret; 503 when unset).
//        Codes live in app_password_resets HASHED, expire in 15 min, die after 5 wrong guesses.
//   POST { action: "reset-confirm", appId, email, code, newPassword }
//     -> 200 { user, session } (password updated AND signed in) · 400 invalid/expired code
//
// Abuse guards (2026-07-15, DB-backed — edge functions are stateless): signup max 30/h per IP and
// 30/h per app (counted from app_auth_events / app_users); reset max 5/h per (app,email) and 20/h
// per IP. Over-limit -> 429. Event rows self-prune (>24h, same key) at check time.
//
// v3 (2026-08-06, from Builder v2 live evidence — diag 1e682279):
//   - SIGNUP IS IDEMPOTENT UNDER RACES: two parallel first-visit signups for the same visitor
//     used to 500 the loser ("already registered" from createUser / a mapping-row conflict);
//     losers now converge on the shared sign-in path and return the same session.
//   - createUser gets ONE retry on transient auth-schema errors ("Database error…").
//   - Retrying your OWN signup (the browser's saved visitor identity) is a sign-in, not a 409;
//     a DIFFERENT password for an existing account still 409s.
//   - The platform's own egress (preview journey verification drives real signups from one
//     VPS IP) skips ONLY the per-IP signup cap (PLATFORM_EGRESS_IPS env, VPS fallback).
//   - Per-IP signup cap raised 10 -> 30/h: one NAT'd family venue legitimately exceeds 10.
//
// Callers authenticate with the project anon key (Authorization: Bearer <anon>), which satisfies
// the platform's verify_jwt gate; per-user auth is what this function IS, so there is no user JWT yet.

import { createClient } from "npm:@supabase/supabase-js@2.111.0";
import {
  UUID_RE, requestOrigin, originIsEligible, projectPreviewOriginIsEligible, hmacHex,
} from "./policy.mjs";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") || "";
const RESEND_FROM = Deno.env.get("RESEND_FROM") || "Thrallo <noreply@thrallo.com>";
const SYNTH_DOMAIN = "apps.thrallo.com";
const RESET_PEPPER = Deno.env.get("APP_AUTH_RESET_PEPPER") || "";

const RESET_TTL_MIN = 15;
const RESET_MAX_ATTEMPTS = 5;
const LIMIT_SIGNUP_PER_IP_H = 30;
const LIMIT_SIGNUP_PER_APP_H = 30;
const LIMIT_RESET_PER_TARGET_H = 5;
const LIMIT_RESET_PER_IP_H = 20;
// The platform's own egress addresses (preview verification traffic). Overridable via env;
// the fallback is the Thrallo VPS. Exempts ONLY the per-IP signup cap.
const PLATFORM_IPS = (Deno.env.get("PLATFORM_EGRESS_IPS") || "51.195.136.189")
  .split(",").map((s) => s.trim()).filter(Boolean);

const svc = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

const cors = (origin: string | null) => ({
  ...(origin ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : {}),
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
});
const json = (status: number, body: unknown, origin: string | null = null) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...cors(origin) } });

async function sha256hex(s: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function syntheticEmail(appId: string, email: string): Promise<string> {
  return `u.${(await sha256hex(`${appId}|${email.toLowerCase()}`)).slice(0, 32)}@${SYNTH_DOMAIN}`;
}

const codeHash = (appId: string, email: string, code: string) =>
  hmacHex(RESET_PEPPER, `${appId}|${email}|${code}`);

async function eligibleApplication(appId: string, origin: string | null): Promise<boolean> {
  if (!UUID_RE.test(appId) || !origin) return false;
  const { data: project, error } = await svc.from("projects").select("id,preview_ref").eq("id", appId).maybeSingle();
  if (error || !project) return false;
  if (projectPreviewOriginIsEligible(origin, appId)) return true;
  if (originIsEligible(origin, { previewRef: project.preview_ref })) return true;
  const { data: site } = await svc.from("published_sites").select("url,slug,unpublished_at")
    .eq("project_id", appId).maybeSingle();
  if (originIsEligible(origin, { site })) return true;
  let host = "";
  try { host = new URL(origin).hostname; } catch { return false; }
  const { data: domain } = await svc.from("custom_domains").select("domain,verified_at")
    .eq("project_id", appId).eq("domain", host).maybeSingle();
  return originIsEligible(origin, { domain });
}

function callerIp(req: Request): string {
  return (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";
}

// Count rows of `kind` for this key in the last hour, pruning that key's stale (>24h) rows first.
async function eventCount(kind: string, key: string): Promise<number> {
  const dayAgo = new Date(Date.now() - 24 * 3600e3).toISOString();
  await svc.from("app_auth_events").delete().eq("kind", kind).eq("key", key).lt("created_at", dayAgo);
  const hourAgo = new Date(Date.now() - 3600e3).toISOString();
  const { count } = await svc
    .from("app_auth_events").select("id", { count: "exact", head: true })
    .eq("kind", kind).eq("key", key).gte("created_at", hourAgo);
  return count ?? 0;
}

async function logEvent(kind: string, key: string, appId: string) {
  await svc.from("app_auth_events").insert({ kind, key, app_id: appId }).then(() => {}, () => {});
}

// Trusted notification writer. Runs with the service role, so it can create notifications the
// end user must NOT be able to forge for themselves — a welcome, and the security alert that
// tells them their password changed when it was not them who changed it. Client-side writes
// go through RLS (owner = auth.uid()) and can only ever notify the signed-in user.
// Never allowed to fail the event that produced it.
async function notifyAppUser(appId: string, owner: string, source: string, title: string, body: string, data: Record<string, unknown> = {}) {
  try {
    await svc.from("app_notifications").insert({ owner, app_id: appId, title, body, data, source });
  } catch (error) {
    console.error("[app-auth] notification failed:", (error as Error)?.message);
  }
}

async function sendResetEmail(to: string, code: string, appId: string): Promise<boolean> {
  // Friendlier subject line when the app has a name (appId is the project id).
  const { data: proj } = await svc.from("projects").select("name").eq("id", appId).maybeSingle();
  const appName = proj?.name || "your app";
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${RESEND_API_KEY}` },
    body: JSON.stringify({
      from: RESEND_FROM,
      to: [to],
      subject: `${code} is your password reset code`,
      text:
        `Your password reset code for ${appName} is: ${code}\n\n` +
        `It expires in ${RESET_TTL_MIN} minutes. If you didn't ask for this, you can ignore this email.\n\n` +
        `— sent by Thrallo on behalf of ${appName}`,
    }),
  }).catch(() => null);
  if (!res?.ok) {
    console.error(`resend send failed: ${res ? `${res.status} ${await res.text().catch(() => "")}` : "network error"}`);
    return false;
  }
  return true;
}

Deno.serve(async (req: Request) => {
  const origin = requestOrigin(req.headers.get("origin"));
  const reply = (status: number, responseBody: unknown) => json(status, responseBody, origin);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
  if (req.method !== "POST") return reply(405, { error: "POST only" });

  let body: { action?: string; appId?: string; email?: string; password?: string; code?: string; newPassword?: string };
  try { body = await req.json(); } catch { return reply(400, { error: "invalid JSON" }); }
  const action = String(body.action || "");
  const appId = String(body.appId || "").trim();
  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");
  const ip = callerIp(req);
  const platformCaller = PLATFORM_IPS.includes(ip);

  if (!["signup", "signin", "reset", "reset-confirm"].includes(action)) {
    return reply(400, { error: "action must be signup, signin, reset or reset-confirm" });
  }
  if (!UUID_RE.test(appId)) return reply(400, { error: "valid appId required" });
  if (!(await eligibleApplication(appId, origin))) return reply(403, { error: "This application is not eligible for authentication." });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return reply(400, { error: "valid email required" });

  // ── reset: email a one-time code. 200 no matter what — never reveal whether an account exists.
  if (action === "reset") {
    if (!RESEND_API_KEY || !RESET_PEPPER) return reply(503, { error: "Password reset isn't available yet for this app." });
    if (await eventCount("reset", ip) >= LIMIT_RESET_PER_IP_H) {
      return reply(429, { error: "Too many reset requests — try again later." });
    }
    const hourAgo = new Date(Date.now() - 3600e3).toISOString();
    const { count: recent } = await svc
      .from("app_password_resets").select("id", { count: "exact", head: true })
      .eq("app_id", appId).eq("email", email).gte("created_at", hourAgo);
    if ((recent ?? 0) >= LIMIT_RESET_PER_TARGET_H) {
      return reply(429, { error: "Too many reset requests — try again later." });
    }
    await logEvent("reset", ip, appId);

    const { data: target } = await svc
      .from("app_users").select("auth_user_id").eq("app_id", appId).eq("email", email).eq("status", "active").maybeSingle();
    if (target) {
      const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, "0");
      // A new request invalidates any outstanding unused codes for this account.
      await svc.from("app_password_resets").delete().eq("app_id", appId).eq("email", email).is("used_at", null);
      const { error: insErr } = await svc.from("app_password_resets").insert({
        app_id: appId, email, code_hash: await codeHash(appId, email, code),
        expires_at: new Date(Date.now() + RESET_TTL_MIN * 60e3).toISOString(),
      });
      if (!insErr) await sendResetEmail(email, code, appId);
    }
    return reply(200, { ok: true });
  }

  // ── reset-confirm: verify the code, set the new password, sign in.
  if (action === "reset-confirm") {
    const code = String(body.code || "").trim();
    const newPassword = String(body.newPassword || "");
    if (!/^\d{6}$/.test(code)) return reply(400, { error: "Invalid or expired code." });
    if (newPassword.length < 8) return reply(400, { error: "password must be at least 8 characters" });

    const { data: row } = await svc
      .from("app_password_resets").select("id, code_hash, attempts, expires_at")
      .eq("app_id", appId).eq("email", email).is("used_at", null)
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    const expired = !row || new Date(row.expires_at) < new Date() || row.attempts >= RESET_MAX_ATTEMPTS;
    if (expired) return reply(400, { error: "Invalid or expired code." });

    const matches = row.code_hash === (await codeHash(appId, email, code));
    const claimedAt = new Date().toISOString();
    // Compare-and-set makes attempt consumption atomic. A correct code is marked used in the
    // SAME write before changing the password, so parallel confirmations have exactly one winner.
    const { data: claimed } = await svc.from("app_password_resets")
      .update({ attempts: row.attempts + 1, ...(matches ? { used_at: claimedAt } : {}) })
      .eq("id", row.id).eq("attempts", row.attempts).is("used_at", null)
      .select("id").maybeSingle();
    if (!claimed || !matches) {
      return reply(400, { error: "Invalid or expired code." });
    }

    const { data: target } = await svc
      .from("app_users").select("auth_user_id").eq("app_id", appId).eq("email", email).eq("status", "active").maybeSingle();
    if (!target) return reply(400, { error: "Invalid or expired code." });

    const { error: updErr } = await svc.auth.admin.updateUserById(target.auth_user_id, { password: newPassword });
    if (updErr) return reply(500, { error: `reset failed: ${updErr.message}` });
    // Real event integration 2: the notification a user must not be able to write for
    // themselves — it is how they find out about a change they did not make.
    await notifyAppUser(appId, target.auth_user_id, "password_changed", "Your password was changed",
      "If this wasn't you, reset your password again immediately and contact the app owner.",
      { kind: "security", at: new Date().toISOString() });

    const anon = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
    const { data: signed, error: signErr } = await anon.auth.signInWithPassword({
      email: await syntheticEmail(appId, email), password: newPassword,
    });
    if (signErr || !signed.session) return reply(500, { error: "Password was reset — sign in with your new password." });
    return reply(200, {
      user: { id: signed.user.id, email },
      session: { access_token: signed.session.access_token, refresh_token: signed.session.refresh_token },
    });
  }

  if (password.length < 8) return reply(400, { error: "password must be at least 8 characters" });

  const synth = await syntheticEmail(appId, email);
  const { data: existing, error: lookupErr } = await svc
    .from("app_users").select("id, auth_user_id, status").eq("app_id", appId).eq("email", email).maybeSingle();
  if (lookupErr) return reply(500, { error: `lookup failed: ${lookupErr.message}` });

  if (action === "signup" && !existing) {
    // Abuse guards: a promo spike is fine; a signup script is not. The platform's own
    // egress (preview verification) skips ONLY the per-IP cap; every other guard applies.
    if (!platformCaller && await eventCount("signup", ip) >= LIMIT_SIGNUP_PER_IP_H) {
      return reply(429, { error: "Too many signups from this network — try again later." });
    }
    const hourAgo = new Date(Date.now() - 3600e3).toISOString();
    const { count: appRecent } = await svc
      .from("app_users").select("id", { count: "exact", head: true })
      .eq("app_id", appId).gte("created_at", hourAgo);
    if ((appRecent ?? 0) >= LIMIT_SIGNUP_PER_APP_H) {
      return reply(429, { error: "This app is getting a lot of signups right now — try again in a bit." });
    }

    // createUser with ONE retry on transient auth-schema errors. Losing a parallel race
    // ("already registered") is NOT an error — the winner made exactly the user we wanted;
    // the shared sign-in below resolves the session.
    let created: { user: { id: string } } | null = null;
    let createErr: { message: string } | null = null;
    for (let attempt = 0; attempt < 2 && !created; attempt += 1) {
      const res = await svc.auth.admin.createUser({
        email: synth,
        password,
        email_confirm: true, // app end-users are confirmed by construction; reset is the code flow above
        user_metadata: { app_id: appId, app_email: email },
      });
      created = res.data?.user ? (res.data as { user: { id: string } }) : null;
      createErr = res.error;
      if (createErr && /already.*(regist|exist)/i.test(createErr.message)) { createErr = null; break; }
      if (createErr && attempt === 0) await new Promise((r) => setTimeout(r, 400));
    }
    if (createErr) return reply(500, { error: `signup failed: ${createErr.message}` });

    if (created) {
      const { error: mapErr } = await svc.from("app_users").insert({
        app_id: appId, email, auth_user_id: created.user.id,
      });
      if (mapErr && !/duplicate|unique|conflict|23505/i.test(mapErr.message)) {
        // A real mapping failure: roll back the auth user so a retry works.
        await svc.auth.admin.deleteUser(created.user.id).catch(() => {});
        return reply(500, { error: `signup failed: ${mapErr.message}` });
      }
      // A duplicate mapping row = we lost the race after user creation; the winner's rows
      // stand and the sign-in below resolves the session either way.
      await logEvent("signup", ip, appId);
      // Real event integration 1: the first thing a new end user sees in the app's notification
      // surface, and proof the surface works from the moment they arrive.
      await notifyAppUser(appId, created.user.id, "app_welcome", "Welcome",
        "Your account is ready. This is where you'll see updates.", { kind: "welcome" });
    }
  } else if (action === "signup" && existing) {
    // A visitor retrying their OWN signup (the browser's saved identity) is a sign-in, not
    // an error; a DIFFERENT password for an existing account still gets the explicit 409.
    const probe = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
    const { error: probeErr } = await probe.auth.signInWithPassword({ email: synth, password });
    if (probeErr) return reply(409, { error: "An account with this email already exists for this app — sign in instead." });
  } else if (!existing) {
    return reply(401, { error: "Invalid email or password." });
  } else if (existing.status !== "active") {
    return reply(403, { error: "This account has been disabled by the app owner." });
  }

  // Both paths end in a REAL password sign-in against the synthetic address -> native session.
  const anon = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
  const { data: signed, error: signErr } = await anon.auth.signInWithPassword({ email: synth, password });
  if (signErr || !signed.session) return reply(401, { error: "Invalid email or password." });

  return reply(200, {
    user: { id: signed.user.id, email }, // the REAL email, not the synthetic one
    session: {
      access_token: signed.session.access_token,
      refresh_token: signed.session.refresh_token,
    },
  });
});
