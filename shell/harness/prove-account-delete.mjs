// Headless live proof of ACCOUNT DELETION + the public legal pages (launch audit item 2).
// Mirrors prove-shell.mjs discipline: opt-in, creds-required, real Supabase round-trips, denial =
// pass. No Codex/Anthropic spend — projects are seeded rows, not generated apps.
//
//   LEGAL     /terms /privacy /refunds serve 200 HTML logged-out; the built bundle contains the docs
//   SETUP     user A (probe) with a project row, ledger credits, and a stored BYOK key;
//             user B (bystander) with a project row
//   GUARD     POST /api/account/delete without confirm:true -> 400; unauthenticated -> 401
//   DELETE    with confirm:true -> 200, reports 1 project cascaded
//   ERASED    A's projects / credit_ledger / customers / byok_keys rows all gone; auth user gone;
//             A's old access token now 401s
//   BYSTANDER user B's project row + auth user untouched (the cascade scoped to A only)
//
// Run: (fill shell/.env or export the vars)  node shell/harness/prove-account-delete.mjs

import { spawn } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { createSupabaseBackend } from "../../src/scaffolds/reactVite/lib/backend/supabaseBackend.js";
import { createLedger } from "../../src/billing/ledger.mjs";
import { loadEnv } from "../server/lib/env.mjs";

loadEnv();
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, "..", "server", "index.mjs");
const DIST_ASSETS = path.join(HERE, "..", "web", "dist", "assets");

const SUPA_URL = process.env.SUPABASE_URL;
const ANON = process.env.SUPABASE_ANON_KEY;
const SVC = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE;
const PORT = Number(process.env.PROVE_PORT || 8793);
const BASE = `http://localhost:${PORT}`;

const G = "\x1b[32m", R = "\x1b[31m", D = "\x1b[2m", B = "\x1b[1m", X = "\x1b[0m";
let passes = 0, fails = 0;
const ok = (m) => { passes++; console.log(`  ${G}PASS${X}  ${m}`); };
const bad = (m) => { fails++; console.log(`  ${R}FAIL${X}  ${m}`); };
const section = (t) => console.log(`\n${B}--- ${t} ---${X}`);
const info = (m) => console.log(`  ${D}→ ${m}${X}`);
const check = (cond, m) => (cond ? ok(m) : bad(m));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!SUPA_URL || !ANON || !SVC) {
  console.log(`${D}SKIPPED — set SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY (shell/.env).${X}`);
  process.exit(0);
}

const userBackend = () => createSupabaseBackend({ url: SUPA_URL, anonKey: ANON });
const tokenOf = async (be) => (await be._client.auth.getSession()).data.session?.access_token;
const svc = createClient(SUPA_URL, SVC, { auth: { persistSession: false, autoRefreshToken: false } });
const ledger = createLedger(svc);

async function waitHealth(deadlineMs = 30000) {
  const end = Date.now() + deadlineMs;
  while (Date.now() < end) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return r.json(); } catch {}
    await sleep(500);
  }
  throw new Error("server did not become healthy");
}

const countRows = async (table, col, val) => {
  const { count, error } = await svc.from(table).select("*", { count: "exact", head: true }).eq(col, val);
  if (error) throw new Error(`${table}: ${error.message}`);
  return count ?? 0;
};

async function makeUser(tag) {
  const email = `acct.probe.${tag}.${Date.now()}@gmail.com`;
  const password = `Pw!${Math.random().toString(36).slice(2)}Aa1`;
  const be = userBackend();
  const user = await be.auth.signUp({ email, password });
  let token = await tokenOf(be);
  if (!token) { await be.auth.signIn({ email, password }); token = await tokenOf(be); }
  return { id: user.id, token };
}

async function main() {
  info(`server ${BASE} · supabase ${new URL(SUPA_URL).host}`);
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, SHELL_PORT: String(PORT), SHELL_HOST: "", PREVIEW_MODE: "vps-stub" },
    stdio: ["ignore", "inherit", "inherit"],
  });
  let a = null, b = null;
  try {
    await waitHealth();
    ok("server healthy");

    // ── LEGAL — public pages, logged out ─────────────────────────────────────────────────────────
    section("LEGAL — /terms /privacy /refunds are public");
    for (const p of ["/terms", "/privacy", "/refunds"]) {
      const r = await fetch(`${BASE}${p}`);
      check(r.ok && (r.headers.get("content-type") || "").includes("text/html"), `${p} -> 200 text/html (no auth)`);
    }
    // The SPA shell is empty HTML — assert the built bundle actually carries the documents.
    const assets = await readdir(DIST_ASSETS);
    const js = assets.filter((f) => f.endsWith(".js"));
    let bundle = "";
    for (const f of js) bundle += await readFile(path.join(DIST_ASSETS, f), "utf8");
    for (const marker of ["Terms of Service", "Privacy Policy", "Refund Policy", "support@buildr101.com", "Cooling-off"]) {
      check(bundle.includes(marker), `built bundle contains “${marker}”`);
    }

    // ── SETUP ────────────────────────────────────────────────────────────────────────────────────
    section("SETUP — user A (project + credits + BYOK key) and bystander B (project)");
    a = await makeUser("a");
    b = await makeUser("b");
    check(!!a.token && !!b.token, `two live sessions (A ${a.id.slice(0, 8)}…, B ${b.id.slice(0, 8)}…)`);

    const ins = await svc.from("projects").insert([
      { owner: a.id, name: "doomed app", tree: { "src/App.jsx": "export default () => null" }, history: [] },
      { owner: b.id, name: "bystander app", tree: { "src/App.jsx": "export default () => null" }, history: [] },
    ]).select("id, owner");
    check(!ins.error && ins.data?.length === 2, `seeded one project row each${ins.error ? " · " + ins.error.message : ""}`);

    await ledger.grant({ owner: a.id, credits: 10, bucket: "topup", kind: "grant", ref: `acct-probe:${Date.now()}` });
    check((await countRows("credit_ledger", "owner", a.id)) >= 1, "A has ledger rows");

    const byokSave = await fetch(`${BASE}/api/settings/byok`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${a.token}` },
      body: JSON.stringify({ key: "sk-ant-dummy-account-delete-probe-000000000000" }),
    });
    check(byokSave.ok, "A stored a BYOK key (dummy)");

    // ── GUARD ────────────────────────────────────────────────────────────────────────────────────
    section("GUARD — deletion requires auth + explicit confirm");
    const noAuth = await fetch(`${BASE}/api/account/delete`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirm: true }),
    });
    check(noAuth.status === 401, `unauthenticated -> 401 (got ${noAuth.status})`);
    const noConfirm = await fetch(`${BASE}/api/account/delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${a.token}` },
      body: JSON.stringify({}),
    });
    check(noConfirm.status === 400, `missing confirm:true -> 400 (got ${noConfirm.status})`);
    check((await countRows("projects", "owner", a.id)) === 1, "guarded calls deleted nothing");

    // ── DELETE ───────────────────────────────────────────────────────────────────────────────────
    section("DELETE — the real thing");
    const del = await fetch(`${BASE}/api/account/delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${a.token}` },
      body: JSON.stringify({ confirm: true }),
    });
    const out = await del.json().catch(() => ({}));
    check(del.ok && out.deleted === true, `delete -> 200 deleted:true${out.error ? " · " + out.error : ""}`);
    check(out.projects === 1, `cascaded ${out.projects} project (expected 1)`);

    // ── ERASED ───────────────────────────────────────────────────────────────────────────────────
    section("ERASED — nothing of A survives");
    check((await countRows("projects", "owner", a.id)) === 0, "projects rows gone");
    check((await countRows("credit_ledger", "owner", a.id)) === 0, "credit_ledger rows gone");
    check((await countRows("customers", "owner", a.id)) === 0, "customers rows gone");
    check((await countRows("byok_keys", "owner", a.id)) === 0, "byok_keys row gone");
    const { data: gone } = await svc.auth.admin.getUserById(a.id).catch(() => ({ data: null }));
    check(!gone?.user, "auth user gone");
    const dead = await fetch(`${BASE}/api/billing/balance`, { headers: { Authorization: `Bearer ${a.token}` } });
    check(dead.status === 401, `A's old token now 401s (got ${dead.status})`);

    // ── BYSTANDER ────────────────────────────────────────────────────────────────────────────────
    section("BYSTANDER — user B untouched");
    check((await countRows("projects", "owner", b.id)) === 1, "B's project row intact");
    const { data: bUser } = await svc.auth.admin.getUserById(b.id);
    check(!!bUser?.user, "B's auth user intact");
  } catch (e) {
    bad(`threw: ${e.message}`);
  } finally {
    // Cleanup the bystander probe (A cleans itself up — that's the feature).
    if (b?.id) {
      await svc.from("projects").delete().eq("owner", b.id);
      await svc.auth.admin.deleteUser(b.id).catch(() => {});
    }
    child.kill();
  }

  console.log(`\n${B}${fails === 0 ? G : R}${passes} passed, ${fails} failed${X}`);
  process.exit(fails === 0 ? 0 : 1);
}

main();
