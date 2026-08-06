// WP-15 (V2-25) — the dual-run COMPARATOR. Zero model credits: it reads finished diag
// runs (a v1 baseline and a v2 run per pair) and writes the archived comparison the
// rollout decision requires. Running NEW paired builds stays with the gated runner
// scripts; this tool never spends.
//
//   node ops/bv2-dual-run.mjs                          # compare the known measured pairs
//   node ops/bv2-dual-run.mjs --pairs '[{"label":"x","v1":"<diagId>","v2":"<diagId>"}]'
//
// Output: docs/dualrun/report-<date>.md (committed by hand after review).

import { writeFileSync, mkdirSync } from "node:fs";
import { serviceClient } from "../shell/server/lib/supabase.mjs";

const client = serviceClient();

// The measured pairs so far (see docs/BUILDER-V2-HEADTOHEAD.md for the narrative).
const DEFAULT_PAIRS = [
  { label: "booking (Berry Brook, stored prompt)", v1: "689e49e1-bfac-4633-916c-70c2bcbbc5cc", v2: "b4d2b704-2246-4545-b574-269f6ffeb098" },
  { label: "simple landing+contact (Harbor & Sage)", v1: null, v2: "143b0d95-e1b8-4c41-acc5-5b18992efe8f" },
];

const arg = process.argv.indexOf("--pairs");
const pairs = arg > -1 ? JSON.parse(process.argv[arg + 1]) : DEFAULT_PAIRS;

async function runFacts(runId) {
  if (!runId) return null;
  const { data: run } = await client.from("diag_runs")
    .select("id, kind, status, model, totals, duration_ms, repair_rounds").eq("id", runId).maybeSingle();
  if (!run) return { id: runId, missing: true };
  const { data: verifySteps } = await client.from("diag_steps")
    .select("label").eq("run_id", runId).eq("kind", "verification").order("seq");
  const lastVerify = verifySteps?.length ? verifySteps[verifySteps.length - 1].label : null;
  const journeyStats = lastVerify
    ? { pass: (lastVerify.match(/=pass/g) || []).length, fail: (lastVerify.match(/=fail/g) || []).length }
    : null;
  return {
    id: runId, kind: run.kind, status: run.status, model: run.model,
    credits: Number(run.totals?.cost || 0),
    tokens: Number(run.totals?.totalTokens || 0),
    minutes: run.duration_ms ? +(run.duration_ms / 60000).toFixed(1) : null,
    repairRounds: run.repair_rounds || 0,
    journeys: journeyStats,
  };
}

const rows = [];
for (const pair of pairs) {
  rows.push({ label: pair.label, v1: await runFacts(pair.v1), v2: await runFacts(pair.v2) });
}

const fmt = (f) => (f == null ? "—"
  : f.missing ? `${f.id.slice(0, 8)} (missing)`
  : `${f.credits.toFixed(2)} cr · ${f.status} · ${f.minutes ?? "?"}m · ${f.journeys ? `${f.journeys.pass}✓/${f.journeys.fail}✗ journey steps` : "no journey record"}`);

const lines = [
  `# Builder v1 vs v2 — dual-run comparison (${new Date().toISOString().slice(0, 10)})`,
  "",
  "| pair | v1 | v2 | cost ratio |",
  "|---|---|---|---|",
];
for (const row of rows) {
  const ratio = row.v1 && row.v2 && !row.v1.missing && !row.v2.missing && row.v2.credits > 0
    ? `${(row.v1.credits / row.v2.credits).toFixed(1)}×` : "—";
  lines.push(`| ${row.label} | ${fmt(row.v1)} | ${fmt(row.v2)} | ${ratio} |`);
}
lines.push("", "Full narrative + failure-class inventory: docs/BUILDER-V2-HEADTOHEAD.md.", "");

const out = lines.join("\n");
console.log(out);
mkdirSync("docs/dualrun", { recursive: true });
const file = `docs/dualrun/report-${new Date().toISOString().slice(0, 10)}.md`;
writeFileSync(file, out);
console.log(`written: ${file}`);
