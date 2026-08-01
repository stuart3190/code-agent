// Production feature health: which shipped features have NEVER actually run?
//
// The 2026-08-01 audit found three features that were merged, deployed, tested and documented —
// and had never executed once in production: build_checkpoints had 0 rows, ai_requests.byok had
// 0 true rows, and build_jobs.stop_reason was entirely null. Tests proved the code worked;
// nothing proved the code had ever been reached.
//
// This is the cheap standing answer to that class. It asks the database, per feature, "when did
// this last actually happen?" — so a feature that quietly never runs is visible rather than
// assumed healthy.
//
//   node scripts/feature-health.mjs            human-readable table
//   node scripts/feature-health.mjs --json     machine-readable
//   node scripts/feature-health.mjs --strict   exit 1 if any feature has never executed
//
// Run on the VPS, where the service-role credentials live.

import { serviceClient } from "../shell/server/lib/supabase.mjs";
import { loadEnv } from "../shell/server/lib/env.mjs";

loadEnv();

// Each entry names a SHIPPED capability and the observable trace it leaves when it runs.
// `where` narrows to rows that prove the specific feature, not merely the table's existence.
const FEATURES = [
  { feature: "app builds", table: "build_jobs", column: "created_at" },
  { feature: "build diagnostics", table: "diag_runs", column: "started_at" },
  { feature: "per-request AI accounting", table: "ai_requests", column: "created_at" },
  { feature: "repair checkpoints", table: "build_checkpoints", column: "created_at" },
  { feature: "end-state classification", table: "build_jobs", column: "updated_at", where: (q) => q.not("stop_reason", "is", null) },
  { feature: "build cancellation", table: "build_jobs", column: "updated_at", where: (q) => q.eq("stop_reason", "cancelled") },
  { feature: "BYOK usage accounting", table: "ai_requests", column: "created_at", where: (q) => q.eq("byok", true) },
  { feature: "outcome learning signals", table: "build_signals", column: "created_at" },
  { feature: "error-shield incidents", table: "diag_incidents", column: "created_at" },
  { feature: "QA / responsive sweeps", table: "qa_runs", column: "created_at" },
  { feature: "per-app notifications", table: "app_notifications", column: "created_at" },
  { feature: "generated-app end users", table: "app_users", column: "created_at" },
  { feature: "generated-app data", table: "entities", column: "created_at" },
  { feature: "published sites", table: "published_sites", column: "created_at" },
  { feature: "conversations", table: "ca_conversations", column: "created_at" },
  { feature: "repository runs", table: "ca_runs", column: "created_at" },
  { feature: "automations", table: "ca_automations", column: "created_at" },
  { feature: "API tokens", table: "ca_api_tokens", column: "last_used_at" },
  { feature: "model routing attempts", table: "ca_model_attempts", column: "created_at" },
  { feature: "product memory", table: "ca_products", column: "created_at" },
];

const json = process.argv.includes("--json");
const strict = process.argv.includes("--strict");
const db = serviceClient();

const rows = [];
for (const spec of FEATURES) {
  let query = db.from(spec.table).select(spec.column).order(spec.column, { ascending: false }).limit(1);
  if (spec.where) query = spec.where(query);
  const { data, error } = await query;
  if (error) {
    rows.push({ ...spec, status: "unknown", detail: error.message });
    continue;
  }
  const last = data?.[0]?.[spec.column] || null;
  const ageDays = last ? (Date.now() - new Date(last).getTime()) / 86_400_000 : null;
  rows.push({
    feature: spec.feature,
    table: spec.table,
    lastSeen: last,
    ageDays: ageDays === null ? null : Number(ageDays.toFixed(1)),
    status: last === null ? "never executed" : ageDays > 30 ? "dormant" : "healthy",
  });
}

if (json) {
  console.log(JSON.stringify({ generatedAt: new Date().toISOString(), features: rows }, null, 2));
} else {
  const width = Math.max(...rows.map((r) => r.feature.length));
  for (const row of rows) {
    const mark = { healthy: "ok      ", dormant: "DORMANT ", "never executed": "NEVER   ", unknown: "unknown " }[row.status];
    const when = row.lastSeen ? `${row.ageDays}d ago` : "—";
    console.log(`${mark} ${row.feature.padEnd(width)}  ${when}${row.detail ? `  (${row.detail})` : ""}`);
  }
  const never = rows.filter((r) => r.status === "never executed");
  const dormant = rows.filter((r) => r.status === "dormant");
  console.log(`\n${rows.length - never.length - dormant.length} healthy · ${dormant.length} dormant · ${never.length} never executed`);
  if (never.length) {
    console.log("\nNEVER EXECUTED — shipped, but nothing in production has reached it:");
    for (const row of never) console.log(`  - ${row.feature} (${row.table})`);
  }
}

if (strict && rows.some((r) => r.status === "never executed")) process.exitCode = 1;
