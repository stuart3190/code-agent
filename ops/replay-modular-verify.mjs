// Zero-model-credit replay: the existing modular build (project 5c658a89, run 689e49e1…) rebuilt,
// served, and driven with the RECALIBRATED journey verifier — plus a live execution check that
// lifecycle classification now resolves the Codex owner correctly and the in-job ceiling arms.
//
// No model is invoked anywhere: the verifier is Playwright, the rebuild is vite, and the
// classification probe reads the credential store. Accounting is asserted unchanged at the end.
//
//   node ops/replay-modular-verify.mjs

import http from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { serviceClient } from "../shell/server/lib/supabase.mjs";
import { createLifecycle, byokJobCeiling } from "../shell/server/lib/appBuild/appBuildService.mjs";
import { honestyScan } from "../shell/server/lib/appBuild/honestyScan.mjs";
import { modularityCheck, modularitySummary } from "../shell/server/lib/appBuild/modularity.mjs";
import { verifyJourneys, journeySummary } from "../shell/server/lib/appBuild/journeyVerifier.mjs";
import { withRuntimeEnv } from "../shell/server/lib/runtimeEnv.mjs";
import { ensureDeps, buildTree, workDirFor } from "../harness/workspace.mjs";

const OWNER = "7fc93b1e-7dc6-48c0-ae05-38ce4ee3050f";
const PROJECT_ID = "5c658a89-ab93-4903-b58e-7251960e676b";
const CASE = "replay-modular-689e49e1";
const PORT = 4601;

const db = serviceClient();
const fail = (msg) => { console.error(`\nREPLAY FAILED — ${msg}`); process.exit(1); };
if (process.env.THRALLO_MANAGED_SETTLEMENT_PAUSED !== "1") fail("managed settlement pause is not armed");

// ── 1. the classification fix, executed against the real store ────────────────────────────────
const lifecycle = await createLifecycle({
  owner: OWNER, projectId: PROJECT_ID,
  diag: { id: "00000000-0000-4000-8000-00000000d1a9", totals: { cost: 0 }, contract: null, step: () => {}, finish: () => {} },
  originalInput: { mode: "build", prompt: "probe" }, mode: "build",
});
console.log(`classification: provider=${lifecycle.activeProvider} · managed=${lifecycle.managed} · in-job ceiling=${byokJobCeiling(lifecycle)}`);
if (lifecycle.managed !== false) fail("the Codex owner still classifies managed");
if (byokJobCeiling(lifecycle) !== 25) fail("the in-job ceiling did not arm at 25");

// ── 2. the stored modular build ───────────────────────────────────────────────────────────────
const { data: run } = await db.from("diag_runs").select("id,contract,totals").eq("owner", OWNER)
  .gte("created_at", "2026-08-05T17:38:00Z").order("created_at").limit(1).maybeSingle();
const { data: project } = await db.from("projects").select("tree").eq("id", PROJECT_ID).maybeSingle();
if (!run?.contract || !project?.tree) fail("stored contract or tree unavailable");
const costBefore = Number(run.totals?.cost || 0);
const { count: requestsBefore } = await db.from("ai_requests").select("id", { count: "exact", head: true }).eq("owner", OWNER);

const honesty = honestyScan(project.tree, { contract: run.contract });
const modular = modularityCheck(project.tree, { contract: run.contract });
console.log(`honesty: ${honesty.findings.length} blocking finding(s) · modularity: ${modular.ok ? modularitySummary(modular) : modular.problems.join(" | ")}`);
if (honesty.findings.length) fail("honesty findings appeared in the stored tree");
if (!modular.ok) fail("the stored tree violates modularity");

// ── 3. rebuild, serve, drive with the recalibrated verifier ───────────────────────────────────
await ensureDeps(() => {});
const build = await buildTree(withRuntimeEnv(project.tree, PROJECT_ID), CASE, console.log);
if (!build.ok) fail(`vite build failed:\n${build.stderr.split("\n").slice(-10).join("\n")}`);
console.log("compile: PASS");

const dist = path.join(workDirFor(CASE), "dist");
if (!existsSync(path.join(dist, "index.html"))) fail("dist/index.html missing");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".woff2": "font/woff2" };
const server = http.createServer((req, res) => {
  const clean = decodeURIComponent(new URL(req.url, "http://x").pathname);
  let file = path.join(dist, clean);
  if (!file.startsWith(dist) || !existsSync(file) || statSync(file).isDirectory()) file = path.join(dist, "index.html");
  res.setHeader("Content-Type", MIME[path.extname(file)] || "application/octet-stream");
  res.end(readFileSync(file));
});
await new Promise((resolve) => server.listen(PORT, "127.0.0.1", resolve));

console.log(`\nserving on 127.0.0.1:${PORT} — driving all ${run.contract.journeys.length} contract journeys with the recalibrated verifier…`);
const verdict = await verifyJourneys({ previewUrl: `http://127.0.0.1:${PORT}/`, contract: run.contract });
server.close();

console.log(`\njourneys: ${journeySummary(verdict)}`);
for (const j of verdict.journeys || []) {
  console.log(`\n  [${j.status.toUpperCase()}] ${j.title} (${j.priority || "supporting"})`);
  for (const s of j.steps || []) {
    if (s.status !== "pass") console.log(`      ${s.status}: ${s.action} — ${String(s.detail || "").slice(0, 160)}`);
    else if (/selection|reflects/.test(String(s.detail || ""))) console.log(`      pass: ${s.action} — ${String(s.detail).slice(0, 140)}`);
  }
}
if (verdict.consoleErrors?.length) console.log(`\nconsole errors:\n  ${verdict.consoleErrors.join("\n  ")}`);
if (verdict.failedRequests?.length) console.log(`failed requests:\n  ${verdict.failedRequests.join("\n  ")}`);

// ── 4. nothing was spent ──────────────────────────────────────────────────────────────────────
const { data: runAfter } = await db.from("diag_runs").select("totals").eq("id", run.id).maybeSingle();
const { count: requestsAfter } = await db.from("ai_requests").select("id", { count: "exact", head: true }).eq("owner", OWNER);
console.log("\n──────────────────────────────────────────────────");
console.log(`accounting  ${costBefore.toFixed(2)} → ${Number(runAfter.totals?.cost || 0).toFixed(2)} credits · ai_requests ${requestsBefore} → ${requestsAfter}`);
if (Number(runAfter.totals?.cost || 0) !== costBefore || requestsAfter !== requestsBefore) fail("accounting moved during a free replay");

const blocking = (verdict.failures || []).length;
const primaryGreen = verdict.primaryStatus && verdict.primaryStatus !== "fail";
console.log(`RESULT: primary ${verdict.primaryStatus} · ${blocking} journey(s) failing · ${(verdict.journeys || []).filter((j) => j.status === "pass").length} passing`);
console.log(primaryGreen && blocking === 0
  ? "The existing modular build QUALIFIES AS GREEN under the recalibrated verifier — no model repair needed."
  : "Remaining failures above — the build does not yet qualify as green.");
process.exit(0);
