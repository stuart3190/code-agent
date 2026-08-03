// Migration drift: reconcile the LIVE database against what the repository says exists.
//
// This is the half of backup coverage that CI structurally cannot do. `backup-coverage.test.mjs`
// reads `supabase/migrations/` and checks every table a migration creates is backed up — which is
// blind by construction to a table that was applied straight to production and never written to a
// migration. Six tables (analytics_events, analytics_daily, analytics_salts, project_logs,
// health_checks, health_status) reached production that way and were absent from every snapshot.
// The guard's own comment delegated this check to "the scheduled migration-drift ops check";
// that check did not exist. This is it.
//
//   node ops/migration-drift.mjs           human-readable report
//   node ops/migration-drift.mjs --json    machine-readable
//
// Exits non-zero on drift so the timer surfaces it. It never writes anything.

import { readdir, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { loadEnv } from "../shell/server/lib/env.mjs";
import { CA_TABLES } from "./backup-thrallo.mjs";

loadEnv();

const JSON_OUT = process.argv.includes("--json");
const migrationsDir = new URL("../supabase/migrations/", import.meta.url);

// Supabase's own bookkeeping and PostGIS-style extension tables are not ours to migrate or back up.
const NOT_OURS = new Set(["schema_migrations", "supabase_migrations"]);

async function tablesFromMigrations() {
  const tables = new Set();
  for (const name of await readdir(migrationsDir)) {
    if (!name.endsWith(".sql")) continue;
    const sql = await readFile(new URL(name, migrationsDir), "utf8");
    const code = sql.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
    for (const match of code.matchAll(/create table (?:if not exists )?public\.(\w+)/gi)) {
      tables.add(match[1]);
    }
  }
  return tables;
}

async function liveTables(svc) {
  // information_schema is not exposed through PostgREST, so this goes through a plain SQL call.
  const { data, error } = await svc.rpc("thrallo_public_tables");
  if (!error && Array.isArray(data)) return new Set(data.map((r) => r.table_name || r));
  // No helper function deployed: fall back to probing each table the repo knows about, plus the
  // backup list. This cannot discover a table nobody has mentioned anywhere, which is why the
  // RPC is preferred — but it still catches the case that actually bit us, because such a table
  // is always referenced by the code that created it.
  return null;
}

/**
 * The comparison itself, pure so it can be tested without a database.
 *
 * Two independent failures, because they have different consequences: a table with no migration
 * means the database cannot be rebuilt, and a table not backed up means its data is lost on
 * restore. A table can be either, or both — which is what happened.
 */
export function findDrift({ live, migrated, backedUp }) {
  const problems = [];
  for (const table of live) {
    if (NOT_OURS.has(table)) continue;
    if (!migrated.has(table)) {
      problems.push(`${table}: exists in production with NO migration — the database cannot be rebuilt from the repo`);
    }
    if (!backedUp.has(table)) {
      problems.push(`${table}: exists in production and is NOT backed up`);
    }
  }
  return problems;
}

function report(lines, ok) {
  if (JSON_OUT) console.log(JSON.stringify(lines, null, 2));
  else {
    for (const line of lines.problems) console.log(`  DRIFT  ${line}`);
    console.log("");
    console.log(ok ? "No migration drift." : `${lines.problems.length} drift problem(s).`);
  }
  process.exitCode = ok ? 0 : 1;
}

async function main() {
  const URL_ = process.env.SUPABASE_URL;
  const SVC = process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!URL_ || !SVC) {
    console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE are required.");
    process.exitCode = 1;
    return;
  }
  const svc = createClient(URL_, SVC, { auth: { persistSession: false, autoRefreshToken: false } });

  const migrated = await tablesFromMigrations();
  const backedUp = new Set(CA_TABLES);
  const problems = [];

  const live = await liveTables(svc);
  if (live) {
    problems.push(...findDrift({ live, migrated, backedUp }));
  } else {
    problems.push("could not enumerate live tables (thrallo_public_tables RPC missing) — deploy it, or this check only verifies reachability below");
  }

  // Whether or not enumeration worked, every table we claim to back up must actually be readable.
  // A backup listing a table that does not exist fails the nightly job at 3am instead of here.
  for (const table of CA_TABLES) {
    const { error } = await svc.from(table).select("*", { count: "exact", head: true }).limit(1);
    if (error) problems.push(`${table}: listed in CA_TABLES but not readable in production (${error.message})`);
  }

  report({ checked: CA_TABLES.length, live: live ? live.size : null, problems }, problems.length === 0);
}

// Only when run directly. Importing this module for `findDrift` must not execute the check —
// otherwise a test that imports it inherits its exit code, which is how this file passed with
// shell/.env present and failed without it.
const runDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (runDirectly) {
  main().catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
