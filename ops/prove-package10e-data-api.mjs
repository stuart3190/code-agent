#!/usr/bin/env node

// Sustained, read-only-or-rejected Data API proof for Package 10E infrastructure recovery.

import { createClient } from "@supabase/supabase-js";

const projectRef = "zczgvcsokfafuyognvwx";
const cycles = Number.parseInt(process.argv[2] || "1", 10);
const delayMs = Number.parseInt(process.argv[3] || "0", 10);
if (!Number.isInteger(cycles) || cycles < 1 || cycles > 600) throw new Error("cycles must be 1..600");
if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 60_000) throw new Error("delay must be 0..60000ms");
if (!String(process.env.SUPABASE_URL || "").includes(projectRef)) throw new Error("wrong Supabase project");
if (!String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").startsWith("sb_secret_")) throw new Error("secret API key required");

const client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});
const fixed = {
  owner: "10e00000-0000-4000-8000-000000000001",
  project: "10e10000-0000-4000-8000-000000000001",
  build: "10e30000-0000-4000-8000-000000000001",
  publicBuild: "10e20000-0000-4000-8000-000000000001",
  workerJob: "10e70000-0000-4000-8000-000000000001",
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const durations = [];
let errors = 0;
let poolTimeouts = 0;

function poolFailure(error) {
  const message = String(error?.message || "");
  return /Timed out acquiring connection|upstream request timeout|504/i.test(message);
}

async function timed(name, operation, { expectedError = null } = {}) {
  const started = performance.now();
  const result = await operation();
  const ms = Number((performance.now() - started).toFixed(2));
  durations.push(ms);
  if (poolFailure(result.error)) poolTimeouts += 1;
  const accepted = expectedError ? Boolean(result.error && expectedError(result.error)) : !result.error;
  if (!accepted) errors += 1;
  return { name, ms, ok: accepted, errorCode: result.error?.code || null,
    poolTimeout: poolFailure(result.error) };
}

for (let cycle = 1; cycle <= cycles; cycle += 1) {
  const probes = [];
  const first = await timed("simple_table_select", () => client.from("projects").select("id,owner").limit(1));
  probes.push(first);
  const ownerResult = await client.from("projects").select("owner").limit(1).maybeSingle();
  const owner = ownerResult.data?.owner || fixed.owner;
  probes.push(await timed("owner_scoped_select", () => client.from("projects").select("id").eq("owner", owner).limit(1)));
  probes.push(await timed("runtime_lookup", () => client.from("build_jobs").select("id,status,pipeline_version").limit(1)));
  probes.push(await timed("v2_retry_rpc_validation", () => client.rpc("prepare_bv2_pipeline_retry", {
    p_owner: fixed.owner, p_public_build_id: fixed.publicBuild, p_work_job_id: fixed.workerJob,
  }), { expectedError: (error) => error.code === "42501" }));
  probes.push(await timed("reservation_rpc_validation", () => client.rpc("reserve_bv2_model_call", {
    p_owner: fixed.owner, p_project_id: fixed.project, p_build_id: fixed.build,
    p_call_key: "package10e-stability-no-write", p_step: "probe", p_provider: "synthetic",
    p_model: "none", p_billing_lane: "byok_api", p_reserved_credits: 0,
    p_ceiling_credits: 1, p_account_available_credits: null,
    p_metadata: { package10eStabilityProbe: true, expectedRejected: true },
  }), { expectedError: (error) => error.code === "42501" }));
  console.log(JSON.stringify({ at: new Date().toISOString(), cycle, probes }));
  if (cycle < cycles && delayMs) await sleep(delayMs);
}

const sorted = [...durations].sort((a, b) => a - b);
const percentile = (p) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))] || 0;
const summary = {
  at: new Date().toISOString(), cycles, requests: durations.length,
  errors, poolTimeouts, latencyMs: { min: sorted[0] || 0, p50: percentile(0.50), p95: percentile(0.95), max: sorted.at(-1) || 0 },
};
console.log(JSON.stringify({ summary }));
if (errors || poolTimeouts) process.exitCode = 1;
