// Thin wrapper over the docker CLI. Reuses the runtime-spike's EXACT hardening flags and network
// topology (spike/runtime-spike.mjs + baseline/RUNTIME.md §2). Runs ON the VPS as user `ubuntu`
// (in the docker group). No shell interpolation: every arg is passed as an execFile argv element.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
const execFileP = promisify(execFile);

export const PROXY_NET = "buildr-proxy-net";     // non-internal: lets Caddy's -p 80:80 bind
export const CADDY_NAME = "buildr-caddy";
// Published static sites live here on the host; mounted read-only into Caddy at /publish
// (Caddyfile.tls serves *.app.buildr101.com from /publish/<label>).
export const PUBLISH_ROOT = process.env.PUBLISH_DIR || path.join(os.homedir(), "publish");
export const CADDY_IMAGE = "caddy:2-alpine";
export const BASE_IMAGE = "buildr-preview-base:latest";

// CP-4 isolation: the proxy net has a FIXED subnet so Caddy can claim a known static IP, and its
// listener binds to that IP ONLY (see Caddyfile* `bind`). Caddy is also `network connect`'d to every
// per-project --internal net (for OUTBOUND reverse_proxy to Vite), but it does NOT listen there — so
// an app container cannot connect to Caddy over its own net and pivot to a sibling via a forged Host
// header. Chosen values sit outside Docker's default 172.16/12 address pool to avoid collision.
export const PROXY_SUBNET = "10.83.7.0/24";
export const PROXY_GATEWAY = "10.83.7.1";
export const CADDY_PROXY_IP = "10.83.7.2";       // must match the `bind` line in Caddyfile + Caddyfile.tls

// The shared TLS front retains certificates and active ACME state for every live preview host.
// Production measured 710 MiB anonymous RSS immediately before a 768 MiB cgroup OOM severed an
// in-flight verifier connection. One GiB is the next bounded container tier (about 31% headroom),
// not an unbounded host allocation; memory-swap remains equal so the proxy cannot spill to swap.
export function caddyRuntimeArgs(env = process.env) {
  const memory = String(env.CADDY_MEMORY_LIMIT || "1g").trim().toLowerCase();
  if (!/^\d+(?:\.\d+)?[kmgt]?b?$/.test(memory)) {
    throw new Error("CADDY_MEMORY_LIMIT must be a Docker memory value such as 1024m or 1g");
  }
  return ["--memory", memory, "--memory-swap", memory, "--restart", "unless-stopped"];
}

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
  if (existing === PROXY_NET) {
    // Verify it carries our fixed subnet. A legacy dynamic-subnet proxy net (pre-CP-4) can't host a
    // static Caddy --ip, so recreate it. Caddy is the only member we own — remove it first (it is
    // re-created + reconnected to the project nets on the next provision).
    const subnet = await docker(["network", "inspect", "-f", "{{range .IPAM.Config}}{{.Subnet}}{{end}}", PROXY_NET], { ok: true });
    if (subnet === PROXY_SUBNET) return;
    await docker(["rm", "-f", CADDY_NAME], { ok: true });
    await docker(["network", "rm", PROXY_NET], { ok: true });
  }
  await docker(["network", "create", "--driver", "bridge", "--subnet", PROXY_SUBNET, "--gateway", PROXY_GATEWAY, PROXY_NET]);
}

export async function ensureInternalNet(label) {
  const n = netName(label);
  const existing = await docker(["network", "ls", "--filter", `name=^${n}$`, "--format", "{{.Name}}"]);
  if (existing !== n) await docker(["network", "create", "--internal", "--driver", "bridge", "--label", "buildr.preview=1", n]);
  return n;
}

// Idempotently ensure the shared Caddy front proxy matches the desired scheme. Tagged with a
// `buildr.scheme` label so a running front is kept as-is UNLESS the scheme changed (http<->https),
// in which case it is recreated (e.g. the CP-1 :80 plain front -> the CP-2 :443 TLS front).
//   opts: { caddyfilePath, image, publish: ["80:80"|"443:443",...], env: {CLOUDFLARE_API_TOKEN}, scheme }
export async function ensureCaddy(opts) {
  const { caddyfilePath, image = CADDY_IMAGE, publish = ["80:80"], env = {}, scheme = "http" } = opts;
  await ensureProxyNet();
  const running = await docker(["ps", "--filter", `name=^${CADDY_NAME}$`, "--format", "{{.Names}}"]);
  if (running === CADDY_NAME) {
    const cur = await docker(["inspect", "-f", '{{ index .Config.Labels "buildr.scheme" }}', CADDY_NAME], { ok: true });
    if (cur === scheme) {
      // Resource updates are live and do not restart Caddy. Reconcile here because three
      // provisioner services share this front and whichever starts first may have created it.
      await docker(["update", ...caddyRuntimeArgs(), CADDY_NAME]);
      return;
    }
  }
  await docker(["rm", "-f", CADDY_NAME], { ok: true });
  // Static --ip on the proxy net so the Caddyfile can `bind` its listener to this address only.
  const args = ["run", "-d", "--name", CADDY_NAME, "--label", `buildr.scheme=${scheme}`,
    "--network", PROXY_NET, "--ip", CADDY_PROXY_IP, ...caddyRuntimeArgs()];
  for (const p of publish) args.push("-p", p);
  for (const [k, v] of Object.entries(env)) args.push("-e", `${k}=${v}`);
  // Persist Caddy's /data (issued certs + ACME account) across recreations so we don't re-issue the
  // wildcard on every restart (slow + Let's Encrypt rate limits).
  args.push("-v", "buildr-caddy-data:/data", "-v", `${caddyfilePath}:/etc/caddy/Caddyfile:ro`);
  // Published static sites (read-only; the dir must exist before mounting).
  args.push("-v", `${PUBLISH_ROOT}:/publish:ro`, image);
  await docker(args);
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
// Labelled buildr.preview=1 so the reaper/capacity/boot-cleanup can enumerate previews reliably.
export async function createContainer(label, env) {
  const net = await ensureInternalNet(label);
  const args = ["create", "--name", label, "--label", "buildr.preview=1", "--network", net, ...HARDENING];
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

// Caddy's stdout (JSON access log) for the last `sinceSec` seconds — the reaper's activity signal.
export async function caddyLogs(sinceSec = 900) {
  return docker(["logs", CADDY_NAME, "--since", `${sinceSec}s`], { ok: true });
}

export async function startContainer(label) {
  await docker(["start", label]);
}

// Reaper stop: free the container's RAM but KEEP it (stopped) so a cold-start is a fast `docker start`
// with the injected tree + network attachment intact. -t 3 = quick SIGTERM->SIGKILL.
export async function stopContainer(label) {
  const out = await docker(["stop", "-t", "3", label], { ok: true });
  return out === label;
}

// "running" | "exited" | "absent"
export async function containerState(label) {
  const out = await docker(["inspect", "-f", "{{.State.Status}}", label], { ok: true });
  return out || "absent";
}

// Full teardown of one project: disconnect Caddy, remove the container, remove the net.
export async function destroy(label) {
  await docker(["network", "disconnect", netName(label), CADDY_NAME], { ok: true });
  const removed = await docker(["rm", "-f", label], { ok: true });
  await docker(["network", "rm", netName(label)], { ok: true });
  return removed === label;
}

// Preview containers by label. { all:true } includes stopped ones.
export async function listPreviewContainers({ all = false } = {}) {
  const args = ["ps", ...(all ? ["-a"] : []), "--filter", "label=buildr.preview=1", "--format", "{{.Names}}"];
  const out = await docker(args);
  return out ? out.split("\n").filter(Boolean) : [];
}

export function stoppedPreviewLabelsToPrune(entries = [], { olderThanMs, retain, now }) {
  const stopped = [...entries].sort((left, right) => right.finishedMs - left.finishedMs);
  return stopped.filter((entry, index) => {
    const expired = entry.finishedMs === 0 || now - entry.finishedMs > olderThanMs;
    return expired || index >= Math.max(0, retain);
  }).map((entry) => entry.label);
}

// Docker reports a freshly created container as `created` until `docker start` completes. The
// periodic capacity sweep can overlap that short provisioning window, so only a genuinely stopped
// (`exited`) preview belongs in the retention cache. Treating every non-running state as stopped
// lets the sweep delete a new container while its provision request is still starting it.
export const isPrunableStoppedPreviewState = (state) => state === "exited";

/**
 * Bound the stopped-preview cache so per-project bridge networks cannot exhaust Docker's address
 * pools. Running previews are never touched. Older entries are disposable source/dependency caches
 * and can be recreated by the normal provision path.
 */
export async function pruneStoppedPreviews({ olderThanMs = 6 * 60 * 60_000, retain = 8,
  now = Date.now() } = {}) {
  const labels = await listPreviewContainers({ all: true });
  const stopped = [];
  for (const label of labels) {
    const raw = await docker(["inspect", "-f", "{{.State.Status}}\t{{.State.FinishedAt}}", label], { ok: true });
    const [state, finishedAt] = raw.split("\t");
    if (!isPrunableStoppedPreviewState(state)) continue;
    const finishedMs = Date.parse(finishedAt);
    stopped.push({ label, finishedMs: Number.isFinite(finishedMs) ? finishedMs : 0 });
  }
  const targets = stoppedPreviewLabelsToPrune(stopped, { olderThanMs, retain, now });
  const removed = [];
  for (const label of targets) {
    if (await destroy(label)) removed.push(label);
  }
  return removed;
}

// Boot/maintenance orphan cleanup. Caddy may still be the sole endpoint after a provision or
// preflight crashes; that proxy-only endpoint must not keep the subnet allocated forever.
export async function removeDanglingNets() {
  const nets = await docker(["network", "ls", "--filter", "label=buildr.preview=1", "--format", "{{.Name}}"]);
  const previewContainers = new Set(await listPreviewContainers({ all: true }));
  const removed = [];
  for (const n of (nets ? nets.split("\n").filter(Boolean) : [])) {
    const expectedContainer = n.endsWith("-net") ? n.slice(0, -4) : null;
    if (expectedContainer && previewContainers.has(expectedContainer)) continue;
    const raw = await docker(["network", "inspect", n], { ok: true });
    let containers = [];
    try {
      const inspected = JSON.parse(raw);
      containers = Object.values(inspected?.[0]?.Containers || {}).map((entry) => entry?.Name).filter(Boolean);
    } catch { continue; }
    if (containers.some((name) => name !== CADDY_NAME)) continue;
    if (containers.includes(CADDY_NAME)) {
      await docker(["network", "disconnect", "-f", n, CADDY_NAME], { ok: true });
    }
    await docker(["network", "rm", n], { ok: true });
    removed.push(n);
  }
  return removed;
}
