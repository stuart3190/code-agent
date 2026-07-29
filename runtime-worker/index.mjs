import { loadEnv } from "../shell/server/lib/env.mjs";
import { serviceClient } from "../shell/server/lib/supabase.mjs";
import { enqueueDueSchedules, pollProviderJobs, processRuntimeTask } from "../shell/server/lib/capabilityRuntime.mjs";

loadEnv();
const client = serviceClient();
const API_CONCURRENCY = Math.max(1, Math.min(8, Number(process.env.RUNTIME_API_CONCURRENCY || 4)));
const MEDIA_CONCURRENCY = Math.max(1, Math.min(2, Number(process.env.RUNTIME_MEDIA_CONCURRENCY || 1)));
let active = 0;
let mediaActive = 0;
const mediaWaiters = [];
let stopping = false;
let ticking = false;

async function mediaSlot(task) {
  const { data: job } = await client.from("app_jobs").select("project_actions(provider)").eq("id", task.input?.job_id).maybeSingle();
  if (!["media", "document"].includes(job?.project_actions?.provider)) return () => {};
  if (mediaActive >= MEDIA_CONCURRENCY) await new Promise((resolve) => mediaWaiters.push(resolve));
  mediaActive += 1;
  return () => { mediaActive -= 1; mediaWaiters.shift()?.(); };
}

async function claimTasks() {
  if (stopping || active >= API_CONCURRENCY) return;
  const { data: tasks, error } = await client.rpc("claim_runtime_tasks", { p_limit: API_CONCURRENCY - active });
  if (error) throw new Error(`runtime queue: ${error.message}`);
  for (const task of tasks || []) {
    active += 1;
    mediaSlot(task).then(async (release) => {
      try { return await processRuntimeTask(task, client); }
      finally { release(); }
    }).then(async (output) => {
      await client.from("background_tasks").update({ status: "succeeded", output, error: null,
        finished_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", task.id);
    }).catch(async (error) => {
      await client.from("background_tasks").update({ status: "failed", error: String(error?.message || error).slice(0, 500),
        finished_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", task.id);
    }).finally(() => { active -= 1; });
  }
}

async function tick() {
  if (ticking || stopping) return;
  ticking = true;
  try { await Promise.all([claimTasks(), pollProviderJobs(client), enqueueDueSchedules(client)]); }
  finally { ticking = false; }
}

console.log(`[runtime-worker] started · concurrency ${API_CONCURRENCY}`);
tick().catch((error) => console.error(`[runtime-worker] ${error.message}`));
const timer = setInterval(() => tick().catch((error) => console.error(`[runtime-worker] ${error.message}`)), 5_000);

function shutdown(signal) {
  if (stopping) return;
  stopping = true; clearInterval(timer);
  console.log(`[runtime-worker] ${signal} · waiting for ${active} active job(s)`);
  const wait = setInterval(() => { if (!active) { clearInterval(wait); process.exit(0); } }, 250);
  setTimeout(() => process.exit(1), 30_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
