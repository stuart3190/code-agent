import { execFileSync } from "node:child_process";
import os from "node:os";
import { loadEnv } from "../shell/server/lib/env.mjs";
import { serviceClient } from "../shell/server/lib/supabase.mjs";
import { drainIdleWorker } from "./lib/drainIdleWorker.mjs";

loadEnv();
const client = serviceClient();
const unwrap = ({ data, error }) => { if (error) throw new Error(error.message); return data; };
const currentPid = () => Number(execFileSync("systemctl", ["show", "thrallo-build-worker", "--property=MainPID", "--value"], { encoding: "utf8" }).trim());
const registry = {
  async list() { return unwrap(await client.from("build_worker_nodes")
    .select("worker_id,state,current_job_id,heartbeat_at,metadata").in("state", ["active", "paused", "draining"])); },
  async drain(id) { unwrap(await client.from("build_worker_nodes").update({ state: "draining" })
    .eq("worker_id", id).eq("state", "active").is("current_job_id", null)); },
  async get(id) { return unwrap(await client.from("build_worker_nodes").select("state,current_job_id,heartbeat_at")
    .eq("worker_id", id).single()); },
  async resume(id) { unwrap(await client.from("build_worker_nodes").update({ state: "active" })
    .eq("worker_id", id).eq("state", "draining")); },
};
console.log(JSON.stringify(await drainIdleWorker({ registry, pid: currentPid(), hostname: os.hostname(), currentPid,
  stop: () => execFileSync("systemctl", ["stop", "thrallo-build-worker"]),
})));
