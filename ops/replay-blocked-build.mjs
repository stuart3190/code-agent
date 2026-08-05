// Zero-credit replay of blocked build 94ad0b0f (run cf130c23, project 970f8f27).
//
// Takes the EXACT stored tree the build was blocked with, applies the deterministic persistence
// repair (no model, no reservation, no credit), rebuilds it, serves the build locally, and drives
// the contract's journeys with the real journey verifier against the real backend.
//
// READ-ONLY against production state: the repaired tree lives only in a scratch workspace — the
// project row, diagnostics, and accounting are asserted UNCHANGED at the end.
//
//   node ops/replay-blocked-build.mjs

import http from "node:http";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { serviceClient } from "../shell/server/lib/supabase.mjs";
import { honestyScan } from "../shell/server/lib/appBuild/honestyScan.mjs";
import { transformPersistence, transformSummary, usesBrowserStorage } from "../shell/server/lib/appBuild/persistenceTransform.mjs";
import { verifyJourneys, journeySummary } from "../shell/server/lib/appBuild/journeyVerifier.mjs";
import { withRuntimeEnv } from "../shell/server/lib/runtimeEnv.mjs";
import { ensureDeps, buildTree, workDirFor } from "../harness/workspace.mjs";

const RUN_ID = "94ad0b0f-8576-4f5b-bfab-85c76d39c1e5";
const PROJECT_ID = "970f8f27-19db-4023-a25a-4efc268e5768";
const OWNER = "7fc93b1e-7dc6-48c0-ae05-38ce4ee3050f";
const CASE = "replay-94ad0b0f";
const PORT = 4599;

const db = serviceClient();
const fail = (msg) => { console.error(`\nREPLAY FAILED — ${msg}`); process.exit(1); };

if (process.env.THRALLO_MANAGED_SETTLEMENT_PAUSED !== "1") fail("managed settlement pause is not armed");

// ── the exact blocked state ───────────────────────────────────────────────────────────────────
const { data: run } = await db.from("diag_runs").select("contract,totals,repair_rounds,status").eq("id", RUN_ID).maybeSingle();
const { data: project } = await db.from("projects").select("tree").eq("id", PROJECT_ID).maybeSingle();
if (!run?.contract || !project?.tree) fail("stored contract or tree unavailable");
const costBefore = Number(run.totals?.cost || 0);
const { count: requestsBefore } = await db.from("ai_requests").select("id", { count: "exact", head: true }).eq("owner", OWNER);
const { count: managedBefore } = await db.from("ca_usage_records").select("id", { count: "exact", head: true }).eq("owner", OWNER).eq("billing_source", "managed");

console.log(`Blocked build ${RUN_ID.slice(0, 8)}: status=${run.status}, cost=${costBefore.toFixed(2)}, contract journeys=${(run.contract.journeys || []).length}`);

// ── honesty findings, before ──────────────────────────────────────────────────────────────────
const before = honestyScan(project.tree, { contract: run.contract });
const beforeHard = before.findings.filter((f) => f.id === "fake_persistence");
const beforeSession = before.warnings.filter((w) => w.id === "session_credentials");
console.log(`\nfindings recorded in the run: 4 hard (the shipped classifier of that day)`);
console.log(`findings under the corrected classifier: ${beforeHard.length} hard + ${beforeSession.length} session-credential warning(s)`);
for (const f of beforeHard) console.log(`  HARD ${f.file}:${f.line}`);
for (const w of beforeSession) console.log(`  warn ${w.file}:${w.line} (session credentials)`);
if (beforeHard.length + beforeSession.length !== 4) fail("the four recorded findings did not reproduce");
if (beforeHard.length !== 2) fail("expected exactly the two newsletter lines to remain hard findings");

// ── deterministic repair: no model, no reservation, no credit ─────────────────────────────────
const fixed = transformPersistence(project.tree, { findings: before.findings, contract: run.contract });
console.log(`\ndeterministic repair: ${transformSummary(fixed)}`);
if (fixed.declined.length) fail(`transform declined: ${JSON.stringify(fixed.declined)}`);

const after = honestyScan(fixed.tree, { contract: run.contract });
console.log(`findings after: ${after.findings.length} hard (${after.ok ? "scan OK" : "scan still failing"})`);
if (!after.ok || after.findings.length !== 0) fail("hard findings did not reach zero");
for (const [file, source] of Object.entries(fixed.tree)) {
  // Same scope as the honesty scan: app source only. src/lib/backend/ is the shipped SDK (its
  // auth session storage is the platform's, not the app's), and visitorSession.js is the
  // classified session-credential cache.
  if (!/^src\//.test(file) || file.startsWith("src/lib/backend/") || file === "src/data/visitorSession.js") continue;
  if (usesBrowserStorage(source)) fail(`${file} still touches browser storage`);
  if (/\bindexedDB\b/.test(source)) fail(`${file} uses indexedDB persistence`);
}
console.log("no localStorage/sessionStorage/IndexedDB business persistence remains");

// ── the repaired tree still compiles ──────────────────────────────────────────────────────────
await ensureDeps(() => {});
const build = await buildTree(withRuntimeEnv(fixed.tree, PROJECT_ID), CASE, console.log);
if (!build.ok) fail(`vite build failed:\n${build.stderr.split("\n").slice(-12).join("\n")}`);
console.log("\ncompile: PASS (vite production build)");

// ── serve the build and drive the contract journeys ───────────────────────────────────────────
const dist = path.join(workDirFor(CASE), "dist");
if (!existsSync(path.join(dist, "index.html"))) fail("dist/index.html missing after build");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".woff2": "font/woff2" };
const server = http.createServer((req, res) => {
  const clean = decodeURIComponent(new URL(req.url, "http://x").pathname);
  let file = path.join(dist, clean);
  if (!file.startsWith(dist) || !existsSync(file) || statSync(file).isDirectory()) file = path.join(dist, "index.html");
  res.setHeader("Content-Type", MIME[path.extname(file)] || "application/octet-stream");
  res.end(readFileSync(file));
});
await new Promise((resolve) => server.listen(PORT, "127.0.0.1", resolve));

console.log(`\nserving on 127.0.0.1:${PORT} — driving all ${run.contract.journeys.length} contract journeys…`);
const verdict = await verifyJourneys({ previewUrl: `http://127.0.0.1:${PORT}/`, contract: run.contract });
server.close();

console.log(`\njourneys: ${journeySummary(verdict)}`);
for (const j of verdict.journeys || []) {
  console.log(`\n  [${j.status.toUpperCase()}] ${j.title} (${j.priority || "supporting"})`);
  for (const s of j.steps || []) {
    if (s.status !== "pass") console.log(`      ${s.status}: ${s.action} — ${String(s.detail || "").slice(0, 160)}`);
  }
}
if (verdict.consoleErrors?.length) console.log(`\nconsole errors:\n  ${verdict.consoleErrors.join("\n  ")}`);
if (verdict.failedRequests?.length) console.log(`failed requests:\n  ${verdict.failedRequests.join("\n  ")}`);

// ── accounting unchanged: this replay spent nothing and reserved nothing ──────────────────────
const { data: runAfter } = await db.from("diag_runs").select("totals").eq("id", RUN_ID).maybeSingle();
const { count: requestsAfter } = await db.from("ai_requests").select("id", { count: "exact", head: true }).eq("owner", OWNER);
const { count: managedAfter } = await db.from("ca_usage_records").select("id", { count: "exact", head: true }).eq("owner", OWNER).eq("billing_source", "managed");
const costAfter = Number(runAfter.totals?.cost || 0);

console.log("\n──────────────────────────────────────────────────");
console.log(`accounting  ${costBefore.toFixed(2)} → ${costAfter.toFixed(2)} credits (must be identical)`);
console.log(`ai_requests ${requestsBefore} → ${requestsAfter} · managed usage rows ${managedBefore} → ${managedAfter}`);
console.log(`pause       ${process.env.THRALLO_MANAGED_SETTLEMENT_PAUSED === "1" ? "armed" : "NOT ARMED"}`);
if (costAfter !== costBefore || requestsAfter !== requestsBefore || managedAfter !== managedBefore) {
  fail("accounting moved during a replay that must be free");
}

const primaryGreen = verdict.primaryStatus && verdict.primaryStatus !== "fail";
const blocking = (verdict.failures || []).length;
console.log("──────────────────────────────────────────────────");
console.log(`\nRESULT: deterministic repair ${after.ok ? "CLEAN" : "failed"} at 0.00 credits · compile PASS · primary journey ${verdict.primaryStatus} · ${blocking} journey(s) still failing`);
console.log(primaryGreen && blocking === 0
  ? "The blocked build would now reach preview_ready with no model repair at all."
  : "A model repair round would still be needed for the remaining journey failures — the persistence defect itself is gone.");
process.exit(0);
