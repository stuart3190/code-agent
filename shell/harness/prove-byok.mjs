// Headless live proof of BYOK — drives the browser's exact API calls server-side with a real Supabase
// session. Opt-in, creds-required (SKIPs otherwise), spends the user's OWN Anthropic quota (~$0.20).
//
//   SAVE      POST /api/settings/byok {key} -> asserts the RAW KEY IS NEVER IN THE RESPONSE (only a hint)
//   STATUS    GET  /api/settings/byok       -> masked hint + provider only; raw key never present
//   GENERATE  POST /api/generate (build) with a BYOK key set -> app BUILDS ON THE USER'S KEY, done.byok
//             is true, and the platform balance is UNCHANGED (no debit); raw key never leaks in any frame
//   CLEAR     DELETE /api/settings/byok      -> status set:false (reverts to the managed lane)
//
// Prereqs: run migrations/byok_keys.sql in Supabase; set BYOK_ENC_KEY (shell/.env) and ANTHROPIC_API_KEY
// (the key to store). Run:  ANTHROPIC_API_KEY=sk-ant-... node shell/harness/prove-byok.mjs

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { createSupabaseBackend } from "../../src/scaffolds/reactVite/lib/backend/supabaseBackend.js";
import { createLedger } from "../../src/billing/ledger.mjs";
import { TIERS } from "../../src/billing/costModel.mjs";
import { loadEnv } from "../server/lib/env.mjs";

loadEnv();
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, "..", "server", "index.mjs");

const SUPA_URL = process.env.SUPABASE_URL;
const ANON = process.env.SUPABASE_ANON_KEY;
const SVC = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE;
const ENC = process.env.BYOK_ENC_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const PORT = Number(process.env.PROVE_PORT || 8792);
const BASE = `http://localhost:${PORT}`;

const G = "\x1b[32m", R = "\x1b[31m", D = "\x1b[2m", B = "\x1b[1m", X = "\x1b[0m";
let passes = 0, fails = 0;
const ok = (m) => { passes++; console.log(`  ${G}PASS${X}  ${m}`); };
const bad = (m) => { fails++; console.log(`  ${R}FAIL${X}  ${m}`); };
const section = (t) => console.log(`\n${B}--- ${t} ---${X}`);
const info = (m) => console.log(`  ${D}→ ${m}${X}`);
const check = (cond, m) => (cond ? ok(m) : bad(m));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!SUPA_URL || !ANON || !SVC || !ENC || !ANTHROPIC_KEY) {
  console.log(`${D}SKIPPED — needs SUPABASE_URL/ANON/SERVICE_ROLE + BYOK_ENC_KEY + ANTHROPIC_API_KEY (the key to store).${X}`);
  process.exit(0);
}

const userBackend = () => createSupabaseBackend({ url: SUPA_URL, anonKey: ANON });
const tokenOf = async (be) => (await be._client.auth.getSession()).data.session?.access_token;
const svcClient = createClient(SUPA_URL, SVC, { auth: { persistSession: false, autoRefreshToken: false } });
const ledger = createLedger(svcClient);

async function waitHealth(deadlineMs = 30000) {
  const end = Date.now() + deadlineMs;
  while (Date.now() < end) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return r.json(); } catch {}
    await sleep(500);
  }
  throw new Error("server did not become healthy");
}

async function api(method, p, token, body) {
  const res = await fetch(`${BASE}${p}`, {
    method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = {}; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}

// POST /api/generate and drain the SSE stream, KEEPING the raw text so we can assert no key leak.
async function generate(token, body) {
  const res = await fetch(`${BASE}/api/generate`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) { const t = await res.text(); throw new Error(`generate ${res.status}: ${t}`); }
  const reader = res.body.getReader(); const dec = new TextDecoder();
  let raw = "", buf = "", done = null;
  for (;;) {
    const { value, done: d } = await reader.read(); if (d) break;
    const chunk = dec.decode(value, { stream: true }); raw += chunk; buf += chunk;
    const frames = buf.split("\n\n"); buf = frames.pop() || "";
    for (const f of frames) {
      const ev = f.split("\n").find((l) => l.startsWith("event:"))?.slice(6).trim();
      const dl = f.split("\n").find((l) => l.startsWith("data:"))?.slice(5).trim();
      if (ev === "done") done = JSON.parse(dl);
      if (ev === "error") throw new Error(JSON.parse(dl).message);
    }
  }
  return { done, raw };
}

async function main() {
  console.log(`${B}=== BYOK E2E proof — save (no echo) → masked status → BYOK build (no debit) → clear ===${X}`);
  info(`server ${BASE} · supabase ${new URL(SUPA_URL).host}`);

  // Fail early with a clear message if the table migration hasn't been run.
  const probe = await svcClient.from("byok_keys").select("owner").limit(1);
  if (probe.error) {
    console.log(`${R}Cannot run: ${probe.error.message}${X}\n${D}Run migrations/byok_keys.sql in the Supabase SQL editor first.${X}`);
    process.exit(1);
  }

  const child = spawn(process.execPath, [SERVER], { env: { ...process.env, SHELL_PORT: String(PORT) }, stdio: ["ignore", "inherit", "inherit"] });
  let owner = null;
  try {
    const health = await waitHealth();
    check(health.ok && health.byok === true, `server healthy (byok configured: ${health.byok})`);

    section("SIGNUP + SEED — a user WITH platform credits (to prove BYOK ignores them)");
    const email = `byok.probe.${Date.now()}@gmail.com`;
    const password = `Pw!${Math.random().toString(36).slice(2)}Aa1`;
    const backend = userBackend();
    const user = await backend.auth.signUp({ email, password });
    owner = user.id;
    let token = await tokenOf(backend);
    if (!token) { await backend.auth.signIn({ email, password }); token = await tokenOf(backend); }
    check(!!token, `signed up ${user.id.slice(0, 8)}… with a session`);
    const starter = TIERS.find((t) => t.id === "starter");
    await ledger.grant({ owner, credits: starter.bundledCredits, bucket: "bundle", kind: "grant", cycle: "seed", ref: `seed:${owner}` });
    const seeded = (await ledger.getBalance(owner)).total;
    check(seeded === starter.bundledCredits, `seeded ${seeded} platform credits`);

    section("SAVE — the raw key must NEVER be echoed back");
    const save = await api("POST", "/api/settings/byok", token, { key: ANTHROPIC_KEY });
    check(save.status === 200 && save.json.set === true, `saved (set=${save.json.set})`);
    check(!save.text.includes(ANTHROPIC_KEY), "SAVE response does not contain the raw key");
    check(typeof save.json.hint === "string" && !save.json.hint.includes(ANTHROPIC_KEY.slice(8, 20)), `response carries a masked hint only (${save.json.hint})`);

    section("STATUS — masked hint + provider only");
    const st = await api("GET", "/api/settings/byok", token);
    check(st.json.set === true && st.json.provider === "anthropic", `status set=${st.json.set} provider=${st.json.provider}`);
    check(!st.text.includes(ANTHROPIC_KEY), "STATUS response does not contain the raw key");

    section("GENERATE — builds on the USER'S key, NO platform debit, no key leak");
    const balBefore = (await ledger.getBalance(owner)).total;
    const { done, raw } = await generate(token, { prompt: "a simple counter app with an increment and reset button", mode: "build" });
    check(done?.byok === true, `done.byok = true (ran on the BYOK lane, model ${done?.decision?.model})`);
    check(done?.build?.ok === true, `app BUILDS on the user's key — ${Object.keys(done?.tree || {}).length} files`);
    check(done?.debit === null && done?.need === 0, "no debit recorded (debit=null, need=0)");
    const balAfter = (await ledger.getBalance(owner)).total;
    check(balAfter === balBefore, `platform balance UNCHANGED (${balBefore} → ${balAfter}) — BYOK didn't touch credits`);
    check(!raw.includes(ANTHROPIC_KEY), "the raw key never appears in ANY SSE frame");

    section("CLEAR — reverts to the managed lane");
    const del = await api("DELETE", "/api/settings/byok", token);
    check(del.status === 200 && del.json.set === false, `cleared (set=${del.json.set})`);
    const st2 = await api("GET", "/api/settings/byok", token);
    check(st2.json.set === false, "status now set:false");

    section("CLEANUP");
    try {
      await svcClient.from("byok_keys").delete().eq("owner", owner);
      await svcClient.from("credit_ledger").delete().eq("owner", owner);
      await svcClient.from("customers").delete().eq("owner", owner);
    } catch (e) { info(`cleanup note: ${e.message}`); }
    info("removed byok/ledger rows (test user remains in auth)");
  } catch (e) {
    bad(`threw: ${e.message}`);
  } finally {
    child.kill();
  }

  console.log(`\n${B}${fails === 0 ? G : R}${passes} passed, ${fails} failed${X}`);
  process.exit(fails === 0 ? 0 : 1);
}

main();
