#!/usr/bin/env node
// PR-01 baseline capture. Default mode is local and network-free. The only database reads require
// both an explicit command-line switch and a dedicated approval environment gate.

import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SAFETY_FLAG_KEYS,
  collectLocalRemediationBaseline,
} from "./lib/remediationBaseline.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const liveRead = args.has("--live-read");
let flags = null;

if (liveRead) {
  if (process.env.THRALLO_BASELINE_READ_APPROVED !== "1") {
    console.error("Refusing live read: set THRALLO_BASELINE_READ_APPROVED=1 only for an approved read-only capture.");
    process.exit(2);
  }
  const { serviceClient } = await import("../shell/server/lib/supabase.mjs");
  const { data, error } = await serviceClient().from("bv2_feature_flags")
    .select("key,value").in("key", SAFETY_FLAG_KEYS);
  if (error) throw new Error(`baseline flag read failed: ${error.message}`);
  flags = new Map((data || []).map((row) => [row.key, row.value]));
}

const report = collectLocalRemediationBaseline(repoRoot, { env: process.env, flags });
const output = args.has("--full") ? report : {
  ...report,
  migrations: {
    count: report.migrations.count,
    manifestHash: report.migrations.manifestHash,
    duplicateVersions: report.migrations.duplicateVersions,
  },
};
console.log(JSON.stringify(output, null, 2));

if (!report.git.matchesOriginMain || !report.git.matchesAuditedCommit) process.exitCode = 1;
if (liveRead && !report.safety.safe) process.exitCode = 1;
