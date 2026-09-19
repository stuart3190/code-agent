#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import { loadEnv } from "../shell/server/lib/env.mjs";

loadEnv();
if (process.env.PACKAGE12_HTTP_RATE_PROOF !== "1") throw new Error("set PACKAGE12_HTTP_RATE_PROOF=1");
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error("Supabase service configuration is required");
const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const subject = crypto.randomUUID();
const token = `${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify({ sub: subject })).toString("base64url")}.proof`;
const actorKey = crypto.createHash("sha256").update(`account:${subject}`).digest("hex");
const networkKey = crypto.createHash("sha256").update("network:127.0.0.1").digest("hex");
const ports = [18888, 18889];
const children = new Map();

function start(port) {
  const child = spawn(process.execPath, ["shell/server/index.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      SHELL_HOST: "127.0.0.1", SHELL_PORT: String(port),
      CODE_AGENT_WORKER: "off", THRALLO_BUILD_WORKER_ENABLED: "0",
      THRALLO_ATOMIC_PUBLISH_ENABLED: "0",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let errors = ""; child.stderr.on("data", (chunk) => { errors += chunk.toString(); });
  children.set(port, { child, errors: () => errors });
  return child;
}

async function stop(port) {
  const entry = children.get(port); if (!entry) return;
  entry.child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => entry.child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (entry.child.exitCode === null) entry.child.kill("SIGKILL");
  children.delete(port);
}

async function waitHealthy(port) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return; } catch { /* retry */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`scoped shell ${port} did not become healthy: ${children.get(port)?.errors() || "no stderr"}`);
}

async function beacon(port) {
  return fetch(`http://127.0.0.1:${port}/api/analytics/collect`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "text/plain", Origin: "https://unregistered.app.thrallo.com" },
    body: JSON.stringify({ appId: "unregistered", kind: "pageview", path: "/" }),
  });
}

try {
  await db.from("http_rate_limit_buckets").delete().in("key_hash", [actorKey, networkKey])
    .in("route_class", ["public_analytics", "public_analytics_network"]);
  for (const port of ports) { start(port); await waitHealthy(port); }
  const statuses = [];
  for (let index = 0; index < 120; index += 1) statuses.push((await beacon(ports[index % 2])).status);
  assert.ok(statuses.every((status) => status === 403), `pre-limit statuses differ: ${[...new Set(statuses)]}`);
  assert.equal((await beacon(ports[0])).status, 429, "the 121st request must be limited across both instances");
  await stop(ports[1]); start(ports[1]); await waitHealthy(ports[1]);
  assert.equal((await beacon(ports[1])).status, 429, "restarting an instance must not reset the shared limit");
  const { data, error } = await db.from("http_rate_limit_buckets")
    .select("route_class,request_count").in("key_hash", [actorKey, networkKey]);
  if (error) throw error;
  assert.equal(data.find((row) => row.route_class === "public_analytics")?.request_count, 122);
  console.log(JSON.stringify({ ok: true, instances: 2, requestsBeforeLimit: 120, restartSafe: true,
    actorCount: 122, networkCount: data.find((row) => row.route_class === "public_analytics_network")?.request_count }));
} finally {
  await Promise.all([...children.keys()].map(stop));
  await db.from("http_rate_limit_buckets").delete().in("key_hash", [actorKey, networkKey])
    .in("route_class", ["public_analytics", "public_analytics_network"]);
}
