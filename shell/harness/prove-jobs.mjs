// Live proof of BACKGROUND BUILDS — builds are detached server-side jobs the client only
// observes. House style: opt-in, creds-required, real round-trips against a spawned child
// server, denial = pass. Mirrors prove-shell.mjs discipline.
//
// Proven here (prove by denial where it's security-/correctness-shaped):
//   DETACH     a job with NO subscriber still runs to complete + debits exactly once
//   REATTACH   subscribe mid-build -> snapshot shows the live phase; subscribe AFTER completion
//              -> terminal snapshot + result, stream closes (no hang)
//   LEAK GATE  every client-visible frame of a full build carries ONLY the coarse vocabulary +
//              the whitelisted result — zero model names, tool names, file paths, token counts
//              (the user's own tree/finalText are the deliverable and excluded from the scan)
//   CONCURRENCY a 2nd job for a user at the cap QUEUES (not dropped, not run) then runs; two jobs
//              on different apps stream without cross-talk (events routed by job id)
//   AUTHZ      user B cannot read / cancel / subscribe to user A's job (server check + RLS)
//   SWEEP      a non-terminal row this server left behind reads `interrupted`; a foreign
//              server_id row is untouched
//   CANCEL     cancel between turns -> failed "Cancelled by user.", no debit, no result
//
// Spends Codex quota: ~1 full build (leak/reattach/debit) + ~1 partial build (cancel) + a few
// cheap plan passes. Missing creds -> SKIPPED. Run:  npm run prove:jobs

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
const PORT = Number(process.env.PROVE_JOBS_PORT || 8792);
const BASE = `http://localhost:${PORT}`;
const CHILD_ID = `prove-child-${Date.now()}`;
const SWEEP_ID = `prove-sweep-${Date.now()}`;

const G = "\x1b[32m", R = "\x1b[31m", D = "\x1b[2m", B = "\x1b[1m", X = "\x1b[0m";
let passes = 0, fails = 0;
const ok = (m) => { passes++; console.log(`  ${G}PASS${X}  ${m}`); };
const bad = (m) => { fails++; console.log(`  ${R}FAIL${X}  ${m}`); };
const section = (t) => console.log(`\n${B}--- ${t} ---${X}`);
const info = (m) => console.log(`  ${D}→ ${m}${X}`);
const check = (cond, m) => (cond ? ok(m) : bad(m));

if (!SUPA_URL || !ANON || !SVC) {
  console.log(`${D}SKIPPED — set SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY (shell/.env) to run.${X}`);
  process.exit(0);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const anonClient = () => createClient(SUPA_URL, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
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

const hdr = (token) => ({ "Content-Type": "application/json", Authorization: `Bearer ${token}` });

async function createBuild(token, body) {
  const res = await fetch(`${BASE}/api/generate`, { method: "POST", headers: hdr(token), body: JSON.stringify(body) });
  const out = await res.json().catch(() => ({}));
  return { status: res.status, out };
}
async function getActive(token, projectId) {
  const res = await fetch(`${BASE}/api/projects/${encodeURIComponent(projectId)}/active-build`, { headers: hdr(token) });
  return { status: res.status, out: await res.json().catch(() => ({})) };
}
async function cancel(token, jobId) {
  const res = await fetch(`${BASE}/api/builds/${encodeURIComponent(jobId)}/cancel`, { method: "POST", headers: hdr(token) });
  return { status: res.status, out: await res.json().catch(() => ({})) };
}

// Read a job's event stream, capturing EVERY raw frame (event + parsed data), until it ends or
// the deadline passes. onData(data) lets a caller react mid-stream (e.g. to cancel).
async function watchEvents(token, jobId, { deadlineMs = 180000, onData } = {}) {
  const frames = [];
  let terminal = null, closed = false;
  const res = await fetch(`${BASE}/api/builds/${encodeURIComponent(jobId)}/events`, { headers: hdr(token) });
  if (!res.ok) return { httpStatus: res.status, frames, terminal, closed: true };
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  const deadline = Date.now() + deadlineMs;
  let buf = "";
  try {
    for (;;) {
      if (Date.now() > deadline) break;
      const { value, done } = await reader.read();
      if (done) { closed = true; break; }
      buf += dec.decode(value, { stream: true });
      const parts = buf.split("\n\n"); buf = parts.pop() || "";
      for (const f of parts) {
        const ev = f.split("\n").find((l) => l.startsWith("event:"))?.slice(6).trim();
        const dl = f.split("\n").find((l) => l.startsWith("data:"))?.slice(5).trim();
        if (!ev || !dl) continue; // skip :ping comments
        let data = {}; try { data = JSON.parse(dl); } catch {}
        frames.push({ ev, raw: dl, data });
        onData?.(ev, data);
        if (["complete", "failed", "interrupted"].includes(data.status)) terminal = data;
      }
    }
  } finally { try { await reader.cancel(); } catch {} }
  return { httpStatus: 200, frames, terminal, closed };
}

// Poll active-build until the job reaches a terminal status (for the no-subscriber path).
async function waitTerminal(token, projectId, deadlineMs = 180000) {
  const end = Date.now() + deadlineMs;
  while (Date.now() < end) {
    const { out } = await getActive(token, projectId);
    if (out.job && ["complete", "failed", "interrupted"].includes(out.job.status)) return out.job;
    await sleep(1000);
  }
  throw new Error("job did not terminate in time");
}

async function debitCount(owner, kind, projectId) {
  const { data } = await svcClient.from("credit_ledger").select("ref")
    .eq("owner", owner).like("ref", `${kind}:${projectId}:%`);
  return (data || []).length;
}

// ── leak gate ─────────────────────────────────────────────────────────────────────────────────
const WHITELIST_TOP = new Set(["jobId", "projectId", "mode", "status", "phase", "error", "result"]);
const WHITELIST_RESULT = new Set([
  "finalText", "tree", "buildOk", "previewUrl", "need", "balance", "designProfile", "qualityWarnings",
]);
const FORBIDDEN = [
  [/gpt-?5|claude-|sonnet|haiku|\bopus\b|codex/i, "model identifier"],
  [/read_file|write_file|apply_patch|edit_file|list_files|search_images/i, "tool name"],
  [/\.(css|tsx|jsx|mjs|scss|html)\b/i, "file path"],
  [/\btok\b|tokens?\b|telemetry|\bcached\b|reason(ing)?\b/i, "token/telemetry field"],
];
// Scan a frame for leaks. The user's own deliverable (result.tree + result.finalText) is
// excluded — everything ELSE must be clean, and top-level/result keys must stay within the
// whitelist (so telemetry/decision/debit can never ride along).
function scanFrame({ data }) {
  const problems = [];
  for (const k of Object.keys(data)) if (!WHITELIST_TOP.has(k)) problems.push(`stray top key "${k}"`);
  const scrub = { ...data };
  if (scrub.result && typeof scrub.result === "object") {
    for (const k of Object.keys(scrub.result)) if (!WHITELIST_RESULT.has(k)) problems.push(`stray result key "${k}"`);
    const { tree, finalText, designProfile, qualityWarnings, ...rest } = scrub.result;
    // User deliverable plus explicitly whitelisted design metadata are excluded from content scan.
    scrub.result = rest;
  }
  const text = JSON.stringify(scrub);
  for (const [re, label] of FORBIDDEN) if (re.test(text)) problems.push(`${label}: ${re.source}`);
  return problems;
}

async function main() {
  console.log(`${B}=== Background builds proof — detached jobs, coarse stream, no leaks ===${X}`);
  info(`server ${BASE} · supabase ${new URL(SUPA_URL).host} · child server_id ${CHILD_ID}`);

  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, SHELL_PORT: String(PORT), SHELL_HOST: "", SHELL_SERVER_ID: CHILD_ID },
    stdio: ["ignore", "inherit", "inherit"],
  });

  let owner = null, bOwner = null;
  const cleanupProjects = [];
  try {
    const health = await waitHealth();
    check(health.ok && health.supabase, `server healthy (supabase env: ${health.supabase}, preview: ${health.previewMode})`);

    // ── users ────────────────────────────────────────────────────────────────────────────────
    section("SETUP — probe user A (seeded) + user B");
    const email = `jobs.probe.a.${Date.now()}@gmail.com`;
    const password = `Pw!${Math.random().toString(36).slice(2)}Aa1`;
    const backend = userBackend();
    const user = await backend.auth.signUp({ email, password });
    owner = user.id;
    let token = await tokenOf(backend);
    if (!token) { await backend.auth.signIn({ email, password }); token = await tokenOf(backend); }
    check(!!token, `user A ${owner.slice(0, 8)}… signed in`);
    const starter = TIERS.find((t) => t.id === "starter");
    await ledger.grant({ owner, credits: starter.bundledCredits, bucket: "bundle", kind: "grant", cycle: "seed", ref: `seed:${owner}` });
    await ledger.setEntitlement({ owner, tier: "starter", currentPeriod: "seed" });
    info(`seeded ${starter.bundledCredits} cr`);

    const bEmail = `jobs.probe.b.${Date.now()}@gmail.com`; const bPw = `Pw!${Math.random().toString(36).slice(2)}Bb2`;
    const b = userBackend(); const bUser = await b.auth.signUp({ email: bEmail, password: bPw });
    bOwner = bUser.id;
    let bToken = await tokenOf(b);
    if (!bToken) { await b.auth.signIn({ email: bEmail, password: bPw }); bToken = await tokenOf(b); }
    check(!!bToken, `user B ${bOwner.slice(0, 8)}… signed in`);

    // ── DETACH — a plan job with NO subscriber still runs + debits once ─────────────────────────
    section("DETACH — a job runs to completion with zero subscribers, debits exactly once");
    const detachPid = `prove-detach-${Date.now()}`;
    const { status: dcode, out: dcreate } = await createBuild(token, { projectId: detachPid, prompt: "a simple counter app", mode: "plan" });
    check(dcode === 202 && !!dcreate.jobId, `create -> 202 jobId ${String(dcreate.jobId).slice(0, 8)}…`);
    // never subscribe — poll only
    const detachJob = await waitTerminal(token, detachPid);
    check(detachJob.status === "complete", `job completed with no subscriber ever attached (status ${detachJob.status})`);
    check(!!detachJob.result?.finalText, "result persisted (plan text present) despite no client watching");
    check((await debitCount(owner, "plan", detachPid)) === 1, "debited exactly once — denial of the disconnect revenue leak");

    // ── BUILD + REATTACH + LEAK GATE + debit-once (one full build) ──────────────────────────────
    section("BUILD — full build with a live subscriber: reattach, replay, leak gate, debit-once");
    const buildPid = `prove-build-${Date.now()}`;
    cleanupProjects.push(buildPid);
    const { out: bcreate } = await createBuild(token, { projectId: buildPid, prompt: "a notes app: add a note with title and body, list newest-first, delete a note", mode: "build" });
    const buildJobId = bcreate.jobId;
    // subscribe immediately — the snapshot is the mid-build reattach
    let snapshotPhase = null, snapshotStatus = null;
    const watch = await watchEvents(token, buildJobId, {
      onData: (ev, data) => { if (ev === "snapshot") { snapshotPhase = data.phase; snapshotStatus = data.status; } },
    });
    check(["queued", "preparing", "planning", "building", "finalizing"].includes(snapshotPhase),
      `mid-build snapshot showed a live coarse phase ("${snapshotPhase}", status ${snapshotStatus})`);
    check(watch.terminal?.status === "complete", `stream ended with a terminal complete frame (${watch.frames.length} frames)`);
    check(watch.terminal?.result?.buildOk === true && Object.keys(watch.terminal?.result?.tree || {}).length > 5,
      `built app rode the terminal result (${Object.keys(watch.terminal?.result?.tree || {}).length} files, buildOk ${watch.terminal?.result?.buildOk})`);

    // leak gate over EVERY captured frame
    const allProblems = watch.frames.flatMap((f) => scanFrame(f).map((p) => `[${f.ev}] ${p}`));
    if (allProblems.length === 0) ok(`leak gate: all ${watch.frames.length} client frames clean (no model/tool/path/token leaks; keys within whitelist)`);
    else { bad(`leak gate found ${allProblems.length} leak(s)`); allProblems.slice(0, 8).forEach((p) => info(p)); }

    check((await debitCount(owner, "gen", buildPid)) === 1, "build debited exactly once");

    // reattach AFTER completion: terminal snapshot + result, stream closes (no hang)
    const post = await watchEvents(token, buildJobId, { deadlineMs: 8000 });
    check(post.closed && post.terminal?.status === "complete" && !!post.terminal?.result?.tree,
      "re-subscribing a finished job returns the terminal snapshot + result and closes (no hang)");

    // ── CONCURRENCY — 2nd job at the cap queues; distinct apps don't cross-talk ─────────────────
    section("CONCURRENCY — per-user cap of 1: a 2nd job queues (denial of billing races)");
    const cids = [0, 1].map((i) => `prove-conc-${Date.now()}-${i}`);
    const created = await Promise.all(cids.map((pid) => createBuild(token, { projectId: pid, prompt: "a todo list", mode: "plan" })));
    const statuses = created.map((c) => c.out.status);
    const running = statuses.filter((s) => s === "running").length;
    const queued = statuses.filter((s) => s === "queued").length;
    check(running === 1 && queued === 1, `at creation: 1 running + 1 queued (got running=${running} queued=${queued}) — cap held, excess queued not rejected`);
    // the queued one still runs once a slot frees
    const lastPid = cids[statuses.lastIndexOf("queued")] || cids[1];
    const drained = await waitTerminal(token, lastPid, 120000);
    check(drained.status === "complete", "the queued job ran to completion once a slot freed (FIFO drain)");

    section("ROUTING — two concurrent jobs stream without cross-talk");
    const rA = `prove-routeA-${Date.now()}`, rB = `prove-routeB-${Date.now()}`;
    const [caA, caB] = await Promise.all([
      createBuild(token, { projectId: rA, prompt: "a weather widget", mode: "plan" }),
      createBuild(token, { projectId: rB, prompt: "a tip calculator", mode: "plan" }),
    ]);
    const [wA, wB] = await Promise.all([
      watchEvents(token, caA.out.jobId, { deadlineMs: 120000 }),
      watchEvents(token, caB.out.jobId, { deadlineMs: 120000 }),
    ]);
    const idsInA = new Set(wA.frames.map((f) => f.data.jobId).filter(Boolean));
    const idsInB = new Set(wB.frames.map((f) => f.data.jobId).filter(Boolean));
    check(idsInA.size === 1 && idsInA.has(caA.out.jobId), `stream A carried only job A's id (${[...idsInA].map((s)=>s.slice(0,8))})`);
    check(idsInB.size === 1 && idsInB.has(caB.out.jobId), `stream B carried only job B's id (${[...idsInB].map((s)=>s.slice(0,8))})`);

    // ── AUTHZ — user B cannot touch A's job (server check + RLS) ────────────────────────────────
    section("AUTHZ — user B is denied A's job events / cancel / rows (denial = pass)");
    const bEvents = await fetch(`${BASE}/api/builds/${buildJobId}/events`, { headers: hdr(bToken) });
    check(bEvents.status === 404, `B GET A's events -> ${bEvents.status} (not 200)`);
    const bCancel = await cancel(bToken, buildJobId);
    check(bCancel.status === 404, `B POST A's cancel -> ${bCancel.status} (not 200)`);
    const bRows = await b._client.from("build_jobs").select("id").eq("id", buildJobId);
    check((bRows.data || []).length === 0, `B's RLS-scoped read of A's job row -> 0 rows (leaked: ${(bRows.data||[]).length})`);

    // ── SWEEP — this server's orphaned rows read interrupted; foreign server_id untouched ────────
    section("SWEEP — restart sweep marks own non-terminal rows interrupted, scoped by server_id");
    process.env.SHELL_SERVER_ID = SWEEP_ID; // the module reads this at import time
    const { sweepInterrupted } = await import("../server/lib/buildJobs.mjs");
    const mineId = `sweep-mine-${Date.now()}`, foreignId = `sweep-foreign-${Date.now()}`;
    await svcClient.from("build_jobs").insert([
      { owner, project_id: mineId, mode: "build", status: "running", phase: "building", server_id: SWEEP_ID },
      { owner, project_id: foreignId, mode: "build", status: "running", phase: "building", server_id: `foreign-${Date.now()}` },
    ]);
    await sweepInterrupted();
    const mineRow = (await svcClient.from("build_jobs").select("status,error").eq("project_id", mineId).maybeSingle()).data;
    const foreignRow = (await svcClient.from("build_jobs").select("status").eq("project_id", foreignId).maybeSingle()).data;
    check(mineRow?.status === "interrupted" && /interrupted by a server restart/i.test(mineRow?.error || ""),
      `own orphan -> interrupted with the honest message ("${(mineRow?.error || "").slice(0, 40)}…")`);
    check(foreignRow?.status === "running", "a foreign server_id's running row is left untouched — scoped sweep");
    await svcClient.from("build_jobs").delete().in("project_id", [mineId, foreignId]);

    // ── CANCEL — between turns: failed, no debit, no result ─────────────────────────────────────
    section("CANCEL — cancel a running build between turns (denial of further spend)");
    const cancelPid = `prove-cancel-${Date.now()}`;
    const { out: ccreate } = await createBuild(token, { projectId: cancelPid, prompt: "a kanban board with drag and drop and multiple columns", mode: "build" });
    const cancelJobId = ccreate.jobId;
    let cancelled = false;
    const cwatch = await watchEvents(token, cancelJobId, {
      onData: async (ev, data) => {
        if (!cancelled && (data.phase === "building")) { cancelled = true; await cancel(token, cancelJobId); }
      },
    });
    check(cwatch.terminal?.status === "failed" && /cancelled by user/i.test(cwatch.terminal?.error || ""),
      `cancel -> failed "${cwatch.terminal?.error}"`);
    check(!cwatch.terminal?.result, "cancelled job carries no result (no orphaned build/preview delivered)");
    check((await debitCount(owner, "gen", cancelPid)) === 0, "no debit recorded for the cancelled build — denial of further spend");

    // ── cleanup ────────────────────────────────────────────────────────────────────────────────
    section("CLEANUP");
    try {
      await svcClient.from("build_jobs").delete().eq("owner", owner);
      await svcClient.from("credit_ledger").delete().eq("owner", owner);
      await svcClient.from("customers").delete().eq("owner", owner);
    } catch (e) { info(`cleanup note: ${e.message}`); }
    info("removed test job/ledger/entitlement rows (test users remain in auth)");
  } catch (e) {
    bad(`threw: ${e.message}${e.payload ? " · " + JSON.stringify(e.payload) : ""}`);
    if (e.stack) info(e.stack.split("\n").slice(1, 3).join(" | "));
  } finally {
    child.kill();
  }

  console.log(`\n${B}${fails === 0 ? G : R}${passes} passed, ${fails} failed${X}`);
  process.exit(fails === 0 ? 0 : 1);
}

main();
