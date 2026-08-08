import { readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { loadEnv } from "../shell/server/lib/env.mjs";
import { readDeploymentIdentity } from "../shell/server/lib/deploymentIdentity.mjs";

loadEnv();
const now = Date.now();
const hours = (iso) => (now - Date.parse(iso)) / 3_600_000;
export function evaluateDrSignals(input) {
  const alerts = [];
  if (!input.backupCompletedAt || hours(input.backupCompletedAt) > 26) alerts.push("backup is older than 26 hours");
  if (!input.restoreDrillAt || (now - Date.parse(input.restoreDrillAt)) / 86_400_000 > 31) alerts.push("isolated restore drill is older than 31 days");
  if (input.queueAgeMinutes > 10) alerts.push(`oldest queued build is ${input.queueAgeMinutes} minutes old`);
  if (input.workerHeartbeatMinutes > 3) alerts.push(`worker heartbeat is ${input.workerHeartbeatMinutes} minutes old`);
  if (input.reconciliationBacklog > 0) alerts.push(`${input.reconciliationBacklog} publishing intents need reconciliation`);
  if (input.recentBuildFailures > 0) alerts.push(`${input.recentBuildFailures} build jobs failed in the last 15 minutes`);
  if (input.recentVerificationFailures > 0) alerts.push(`${input.recentVerificationFailures} verification runs failed in the last 15 minutes`);
  if (input.postgrestHealthy !== true) alerts.push("PostgREST read probe failed");
  if (input.deploymentIdentityMatches !== true) alerts.push("running deployment identity differs from expected manifest");
  if (input.storageGrowthPercent > 25) alerts.push(`storage grew ${input.storageGrowthPercent}% since the previous backup`);
  return alerts;
}

async function recentManifests(root) {
  const dirs = (await readdir(root, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("thrallo-")).map((entry) => entry.name).sort();
  const manifests = [];
  for (const name of dirs.reverse()) {
    const file = path.join(root, name, "manifest.json");
    const value = JSON.parse(await readFile(file, "utf8").catch(() => "null"));
    if (value?.finishedAt || value?.completedAt) manifests.push(value);
    if (manifests.length === 2) break;
  }
  return manifests;
}

async function main() {
  const backupRoot = path.resolve(process.env.THRALLO_BACKUP_DIR || path.join(os.homedir(), "thrallo-backups"));
  const [latest, previous] = await recentManifests(backupRoot);
  const restoreEvidence = process.env.THRALLO_LAST_RESTORE_EVIDENCE;
  const restoreDrillAt = restoreEvidence && (await stat(restoreEvidence).catch(() => null))?.mtime.toISOString();
  const url = process.env.SUPABASE_URL; const key = process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_SERVICE_ROLE_KEY;
  const db = url && key ? createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } }) : null;
  let postgrestHealthy = false; let queueAgeMinutes = 0; let workerHeartbeatMinutes = Infinity;
  let reconciliationBacklog = 0; let recentBuildFailures = 0; let recentVerificationFailures = 0;
  if (db) {
    const read = await db.from("projects").select("id", { head: true, count: "exact" }); postgrestHealthy = !read.error;
    const queued = await db.from("build_work_jobs").select("created_at").eq("state", "queued").order("created_at").limit(1);
    if (queued.data?.[0]) queueAgeMinutes = Math.max(0, (now - Date.parse(queued.data[0].created_at)) / 60_000);
    const worker = await db.from("build_worker_nodes").select("heartbeat_at").order("heartbeat_at", { ascending: false }).limit(1);
    if (worker.data?.[0]) workerHeartbeatMinutes = Math.max(0, (now - Date.parse(worker.data[0].heartbeat_at)) / 60_000);
    const fiveMinutesAgo = new Date(now - 5 * 60_000).toISOString();
    const fifteenMinutesAgo = new Date(now - 15 * 60_000).toISOString();
    const intents = await db.from("publish_activation_intents").select("id", { count: "exact", head: true })
      .in("state", ["requested", "pointer_switched", "reconciling"]).lt("updated_at", fiveMinutesAgo);
    reconciliationBacklog = intents.count || 0;
    const failedJobs = await db.from("build_work_jobs").select("id", { count: "exact", head: true })
      .eq("state", "failed").gte("finished_at", fifteenMinutesAgo);
    recentBuildFailures = failedJobs.count || 0;
    const failedVerification = await db.from("diag_steps").select("id", { count: "exact", head: true })
      .eq("status", "failed").eq("kind", "verification").gte("created_at", fifteenMinutesAgo);
    recentVerificationFailures = failedVerification.count || 0;
  }
  let deploymentIdentityMatches = false;
  try {
    const identity = await readDeploymentIdentity();
    deploymentIdentityMatches = !process.env.THRALLO_EXPECTED_DEPLOYMENT_SHA
      || identity.manifestSha256 === process.env.THRALLO_EXPECTED_DEPLOYMENT_SHA;
  } catch { deploymentIdentityMatches = false; }
  const latestBytes = Number(latest?.bytes || 0); const previousBytes = Number(previous?.bytes || 0);
  const storageGrowthPercent = previousBytes > 0 ? ((latestBytes - previousBytes) / previousBytes) * 100 : 0;
  const input = { backupCompletedAt: latest?.finishedAt || latest?.completedAt, restoreDrillAt, queueAgeMinutes, workerHeartbeatMinutes,
    reconciliationBacklog, recentBuildFailures, recentVerificationFailures, postgrestHealthy,
    deploymentIdentityMatches, storageGrowthPercent };
  const alerts = evaluateDrSignals(input); const output = { ok: alerts.length === 0, at: new Date(now).toISOString(), input, alerts };
  console.log(JSON.stringify(output));
  if (alerts.length && process.argv.includes("--notify") && process.env.THRALLO_OPS_ALERT_WEBHOOK) {
    await fetch(process.env.THRALLO_OPS_ALERT_WEBHOOK, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ service: "thrallo-dr", ...output }) });
  }
  if (alerts.length) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
