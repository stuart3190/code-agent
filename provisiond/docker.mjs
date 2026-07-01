// Thin wrapper over the docker CLI. Reuses the runtime-spike's EXACT hardening flags and network
// topology (spike/runtime-spike.mjs + baseline/RUNTIME.md §2). Runs ON the VPS as user `ubuntu`
// (in the docker group). No shell interpolation: every arg is passed as an execFile argv element.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileP = promisify(execFile);

export const PROXY_NET = "buildr-proxy-net";     // non-internal: lets Caddy's -p 80:80 bind
export const CADDY_NAME = "buildr-caddy";
export const CADDY_IMAGE = "caddy:2-alpine";
export const BASE_IMAGE = "buildr-preview-base:latest";

// Per-container isolation hardening — copied verbatim from the proven spike.
const HARDENING = [
  "--cap-drop", "ALL",
  "--security-opt", "no-new-privileges",
  "--user", "node",
  "--memory", "512m", "--memory-swap", "512m",
  "--cpus", "1.0",
  "--pids-limit", "200",
  "--tmpfs", "/tmp:size=256m",
];

async function docker(args, { ok = false } = {}) {
  try {
    const { stdout } = await execFileP("docker", args, { maxBuffer: 16 * 1024 * 1024 });
    return stdout.trim();
  } catch (e) {
    if (ok) return "";
    const msg = (e.stderr || e.message || "").toString().trim();
    throw new Error(`docker ${args.join(" ")} failed: ${msg}`);
  }
}

export const netName = (label) => `${label}-net`;

export async function ensureProxyNet() {
  const existing = await docker(["network", "ls", "--filter", `name=^${PROXY_NET}$`, "--format", "{{.Name}}"]);
  if (existing !== PROXY_NET) await docker(["network", "create", "--driver", "bridge", PROXY_NET]);
}

export async function ensureInternalNet(label) {
  const n = netName(label);
  const existing = await docker(["network", "ls", "--filter", `name=^${n}$`, "--format", "{{.Name}}"]);
  if (existing !== n) await docker(["network", "create", "--internal", "--driver", "bridge", n]);
  return n;
}

// Idempotently (re)start the shared Caddy front proxy on the proxy net, publishing :80.
export async function ensureCaddy(caddyfilePath) {
  await ensureProxyNet();
  const running = await docker(["ps", "--filter", `name=^${CADDY_NAME}$`, "--format", "{{.Names}}"]);
  if (running === CADDY_NAME) return;
  await docker(["rm", "-f", CADDY_NAME], { ok: true });
  await docker([
    "run", "-d", "--name", CADDY_NAME,
    "--network", PROXY_NET,
    "-p", "80:80",
    "-v", `${caddyfilePath}:/etc/caddy/Caddyfile:ro`,
    CADDY_IMAGE,
  ]);
}

export async function containerExists(label) {
  const out = await docker(["ps", "-a", "--filter", `name=^${label}$`, "--format", "{{.Names}}"]);
  return out === label;
}

export async function isRunning(label) {
  const out = await docker(["ps", "--filter", `name=^${label}$`, "--format", "{{.Names}}"]);
  return out === label;
}

// Create (not start) an app container on its own --internal net with the hardening flags + env.
export async function createContainer(label, env) {
  const net = await ensureInternalNet(label);
  const args = ["create", "--name", label, "--network", net, ...HARDENING];
  for (const [k, v] of Object.entries(env)) args.push("-e", `${k}=${v}`);
  args.push(BASE_IMAGE);
  await docker(args);
}

// Copy an on-disk tree dir INTO the created container's /app (source injection).
export async function cpInto(label, hostDir) {
  await docker(["cp", `${hostDir}/.`, `${label}:/app`]);
}

export async function connectCaddy(label) {
  await docker(["network", "connect", netName(label), CADDY_NAME], { ok: true });
}

export async function startContainer(label) {
  await docker(["start", label]);
}

// Full teardown of one project: disconnect Caddy, remove the container, remove the net.
export async function destroy(label) {
  await docker(["network", "disconnect", netName(label), CADDY_NAME], { ok: true });
  const removed = await docker(["rm", "-f", label], { ok: true });
  await docker(["network", "rm", netName(label)], { ok: true });
  return removed === label;
}

export async function listPreviewContainers() {
  const out = await docker(["ps", "--format", "{{.Names}}"]);
  return out ? out.split("\n").filter((n) => n && n !== CADDY_NAME) : [];
}
