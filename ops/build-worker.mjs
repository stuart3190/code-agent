#!/usr/bin/env node
import { loadEnv } from "../shell/server/lib/env.mjs";
import { serviceClient } from "../shell/server/lib/supabase.mjs";

loadEnv();
const db = serviceClient();
const [command = "list", arg] = process.argv.slice(2);
const print = (value) => console.log(JSON.stringify(value, null, 2));

if (command === "list") {
  const { data, error } = await db.from("build_work_jobs")
    .select("id,owner,project_id,build_id,job_type,state,priority,attempts,max_attempts,lease_owner,lease_expires_at,heartbeat_at,cancel_requested,created_at,started_at,finished_at,error_classification")
    .in("state", ["queued", "leased", "running", "cancel_requested", "expired"])
    .order("priority", { ascending: false }).order("created_at").limit(200);
  if (error) throw error; print(data || []);
} else if (command === "metrics") {
  const [{ data: queue, error }, { data: nodes, error: nodeError }] = await Promise.all([
    db.from("build_work_queue_metrics").select("*").single(),
    db.from("build_worker_nodes").select("worker_id,version,state,current_job_id,heartbeat_at,job_types,metadata").order("worker_id"),
  ]);
  if (error || nodeError) throw error || nodeError; print({ queue, nodes });
} else if (command === "stale") {
  const { data, error } = await db.from("build_work_jobs")
    .select("id,owner,project_id,job_type,state,lease_owner,lease_expires_at,heartbeat_at,attempts,max_attempts")
    .in("state", ["leased", "running", "cancel_requested"]).lt("lease_expires_at", new Date().toISOString())
    .order("lease_expires_at");
  if (error) throw error; print(data || []);
} else if (command === "cancel") {
  if (!arg) throw new Error("usage: node ops/build-worker.mjs cancel <job-id>");
  const { data: job } = await db.from("build_work_jobs").select("owner").eq("id", arg).maybeSingle();
  if (!job) throw new Error("job not found");
  const { data, error } = await db.rpc("build_work_request_cancel", { p_owner: job.owner, p_job_id: arg });
  if (error) throw error; print(data);
} else if (command === "retry") {
  if (!arg) throw new Error("usage: node ops/build-worker.mjs retry <job-id>");
  const { data, error } = await db.rpc("build_work_retry", { p_job_id: arg });
  if (error) throw error; print(data);
} else if (["pause", "drain", "resume"].includes(command)) {
  if (!arg) throw new Error(`usage: node ops/build-worker.mjs ${command} <worker-id>`);
  const state = command === "pause" ? "paused" : command === "drain" ? "draining" : "active";
  const { data, error } = await db.from("build_worker_nodes").update({ state }).eq("worker_id", arg).select("*").maybeSingle();
  if (error) throw error; if (!data) throw new Error("worker not found"); print(data);
} else {
  throw new Error("commands: list | metrics | stale | cancel <job> | retry <job> | pause|drain|resume <worker>");
}
