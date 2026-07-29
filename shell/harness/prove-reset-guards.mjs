// Headless live proof of the app-auth PASSWORD RESET flow + the launch abuse guards (2026-07-15).
// Mirrors prove-shell.mjs discipline: opt-in, creds-required, real round-trips against the DEPLOYED
// app-auth Edge Function and live DB. No Codex/Anthropic spend. Denial = pass.
//
// Works BEFORE the Resend key exists: the send path is asserted as 503-or-200 (recorded), and the
// confirm path is proven by seeding a known code row directly (hash computed locally — same
// sha256(appId|email|code) the function uses), so email delivery is the ONLY link not exercised.
//
//   RESET     signup probe app user via the scaffold SDK -> resetPassword() 503 (no key) or 200
//             seeded code: wrong guess -> 400 + attempts bump · right code -> 200, session installed,
//             used_at stamped, old password 401s, new password signs in
//   ATTEMPTS  5 wrong guesses kill the code — the correct one then 400s
//   SIGNUP    31st signup/hour for one app -> 429 (rows seeded, not scripted)
//   CAP       11th project row for a free account -> PROJECT_CAP · paid tier lifts it to 100
//
// Run: (fill shell/.env or export the vars)  node shell/harness/prove-reset-guards.mjs

import { createClient } from "@supabase/supabase-js";
import { createHash, randomUUID } from "node:crypto";
import { createSupabaseBackend } from "../../src/scaffolds/reactVite/lib/backend/supabaseBackend.js";
import { loadEnv } from "../server/lib/env.mjs";

loadEnv();

const SUPA_URL = process.env.SUPABASE_URL;
const ANON = process.env.SUPABASE_ANON_KEY;
const SVC = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE;
const AUTH_URL = process.env.APP_AUTH_URL || (SUPA_URL ? `${SUPA_URL}/functions/v1/app-auth` : null);

const G = "\x1b[32m", R = "\x1b[31m", D = "\x1b[2m", B = "\x1b[1m", X = "\x1b[0m";
let passes = 0, fails = 0;
const ok = (m) => { passes++; console.log(`  ${G}PASS${X}  ${m}`); };
const bad = (m) => { fails++; console.log(`  ${R}FAIL${X}  ${m}`); };
const section = (t) => console.log(`\n${B}--- ${t} ---${X}`);
const info = (m) => console.log(`  ${D}→ ${m}${X}`);
const check = (cond, m) => (cond ? ok(m) : bad(m));

if (!SUPA_URL || !ANON || !SVC) {
  console.log(`${D}SKIPPED — set SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY (shell/.env).${X}`);
  process.exit(0);
}

const svc = createClient(SUPA_URL, SVC, { auth: { persistSession: false, autoRefreshToken: false } });
const sha256 = (s) => createHash("sha256").update(s).digest("hex");

// Raw function call (for status-code assertions the SDK intentionally hides).
async function rawAuth(payload) {
  const r = await fetch(AUTH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ANON}`, apikey: ANON },
    body: JSON.stringify(payload),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

// Seed a reset code row exactly as the function writes it (used_at null, 15-min expiry).
async function seedCode(appId, email, code) {
  await svc.from("app_password_resets").delete().eq("app_id", appId).eq("email", email).is("used_at", null);
  const { error } = await svc.from("app_password_resets").insert({
    app_id: appId, email, code_hash: sha256(`${appId}|${email}|${code}`),
    expires_at: new Date(Date.now() + 15 * 60e3).toISOString(),
  });
  if (error) throw new Error(`seedCode: ${error.message}`);
}

const latestRow = async (appId, email) => {
  const { data } = await svc
    .from("app_password_resets").select("id, attempts, used_at")
    .eq("app_id", appId).eq("email", email)
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  return data;
};

async function main() {
  info(`function ${AUTH_URL} · supabase ${new URL(SUPA_URL).host}`);
  const appId = `probe-reset-${Date.now()}`;
  const email = `reset.probe.${Date.now()}@gmail.com`;
  const pw1 = `Pw!${Math.random().toString(36).slice(2)}Aa1`;
  const pw2 = `Nw!${Math.random().toString(36).slice(2)}Bb2`;
  const capOwnerIds = [];
  let capUser = null;

  try {
    // ── RESET — request + confirm through the scaffold SDK ──────────────────────────────────────
    section("RESET — code flow end-to-end (seeded code; email send is the only unproven link)");
    const be = createSupabaseBackend({ url: SUPA_URL, anonKey: ANON, appId, authUrl: AUTH_URL });
    const user = await be.auth.signUp({ email, password: pw1 });
    check(!!user?.id && user.email === email, "probe app user signed up via SDK (real email surfaced)");

    const reqReset = await rawAuth({ action: "reset", appId, email });
    const keyLive = reqReset.status === 200;
    check([200, 503].includes(reqReset.status),
      `resetPassword -> ${reqReset.status} (${keyLive ? "RESEND KEY LIVE — code emailed" : "503 until RESEND_API_KEY is set"})`);

    const unknownReset = await rawAuth({ action: "reset", appId, email: `nobody.${Date.now()}@gmail.com` });
    check(unknownReset.status === reqReset.status,
      "unknown email answers identically to a real one (no account enumeration)");

    if (!keyLive) await seedCode(appId, email, "123456"); // otherwise the emailed code's row is live
    else await seedCode(appId, email, "123456");          // deterministic code for the assertions below

    const wrong = await rawAuth({ action: "reset-confirm", appId, email, code: "000000", newPassword: pw2 });
    check(wrong.status === 400, "wrong code -> 400");
    const afterWrong = await latestRow(appId, email);
    check(afterWrong?.attempts === 1, "wrong guess burned an attempt (attempts = 1)");

    const confirmed = await be.auth.confirmReset({ email, code: "123456", newPassword: pw2 });
    check(confirmed?.id === user.id, "confirmReset -> password set AND signed in as the same user");
    const afterUse = await latestRow(appId, email);
    check(!!afterUse?.used_at, "code row stamped used_at (single-use)");

    const replay = await rawAuth({ action: "reset-confirm", appId, email, code: "123456", newPassword: pw2 });
    check(replay.status === 400, "replaying the used code -> 400");

    const oldPw = await rawAuth({ action: "signin", appId, email, password: pw1 });
    check(oldPw.status === 401, "old password no longer signs in");
    const newPw = await rawAuth({ action: "signin", appId, email, password: pw2 });
    check(newPw.status === 200, "new password signs in");

    // ── ATTEMPTS — five wrong guesses kill the code ─────────────────────────────────────────────
    section("ATTEMPTS — brute-force cap");
    await seedCode(appId, email, "654321");
    for (let i = 0; i < 5; i++) await rawAuth({ action: "reset-confirm", appId, email, code: "111111", newPassword: pw2 });
    const dead = await rawAuth({ action: "reset-confirm", appId, email, code: "654321", newPassword: pw2 });
    check(dead.status === 400, "correct code rejected after 5 wrong guesses");

    // ── SIGNUP — per-app rate limit (rows seeded, not 30 live signups) ──────────────────────────
    section("SIGNUP — per-app hourly limit");
    const floodApp = `probe-flood-${Date.now()}`;
    const seedUsers = Array.from({ length: 30 }, (_, i) => ({
      app_id: floodApp, email: `seed${i}.${Date.now()}@gmail.com`, auth_user_id: randomUUID(),
    }));
    const { error: floodErr } = await svc.from("app_users").insert(seedUsers);
    if (floodErr) throw new Error(`flood seed: ${floodErr.message}`);
    const flooded = await rawAuth({ action: "signup", appId: floodApp, email: `late.${Date.now()}@gmail.com`, password: pw1 });
    check(flooded.status === 429, `31st signup in the hour for one app -> 429 (got ${flooded.status})`);
    await svc.from("app_users").delete().eq("app_id", floodApp);

    // ── CAP — project trigger: 10 free / 100 paid ───────────────────────────────────────────────
    section("CAP — per-account project trigger");
    const capEmail = `cap.probe.${Date.now()}@gmail.com`;
    const { data: capCreated, error: capErr } = await svc.auth.admin.createUser({
      email: capEmail, password: pw1, email_confirm: true,
    });
    if (capErr) throw new Error(`cap user: ${capErr.message}`);
    capUser = capCreated.user;
    const rows = Array.from({ length: 10 }, (_, i) => ({ owner: capUser.id, name: `cap probe ${i}` }));
    const { data: seeded, error: seedErr } = await svc.from("projects").insert(rows).select("id");
    if (seedErr) throw new Error(`cap seed: ${seedErr.message}`);
    capOwnerIds.push(...seeded.map((r) => r.id));
    check(seeded.length === 10, "10 project rows inserted for a free account");

    const { error: eleventh } = await svc.from("projects").insert({ owner: capUser.id, name: "cap probe 11" });
    check(!!eleventh && /PROJECT_CAP/.test(eleventh.message), `11th project blocked by trigger (${eleventh?.message?.slice(0, 60)}…)`);

    await svc.from("customers").upsert({ owner: capUser.id, tier: "pro" });
    const { data: paidRow, error: paidErr } = await svc.from("projects").insert({ owner: capUser.id, name: "cap probe paid" }).select("id");
    check(!paidErr && paidRow?.length === 1, "same insert succeeds once the account has a paid tier");
    if (paidRow?.[0]?.id) capOwnerIds.push(paidRow[0].id);
  } catch (e) {
    bad(`unhandled: ${e.message}`);
  } finally {
    // ── cleanup: probe app users (auth + mapping), reset rows, events, cap user + rows ──────────
    const { data: appUsers } = await svc.from("app_users").select("auth_user_id").eq("app_id", appId);
    for (const u of appUsers || []) await svc.auth.admin.deleteUser(u.auth_user_id).catch(() => {});
    await svc.from("app_users").delete().eq("app_id", appId);
    await svc.from("app_password_resets").delete().eq("app_id", appId);
    await svc.from("app_auth_events").delete().like("app_id", "probe-%");
    if (capOwnerIds.length) await svc.from("projects").delete().in("id", capOwnerIds);
    if (capUser) {
      await svc.from("customers").delete().eq("owner", capUser.id);
      await svc.auth.admin.deleteUser(capUser.id).catch(() => {});
    }
    info("cleanup done");
  }

  console.log(`\n${B}${passes} passed, ${fails} failed${X}`);
  process.exit(fails ? 1 : 0);
}

main();
