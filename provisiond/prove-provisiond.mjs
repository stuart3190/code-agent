// prove-provisiond.mjs — the live proof, run from the EPYC box over the SSH tunnel. Styled on
// spike/runtime-spike.mjs (PASS/FAIL per assertion). CP-1 slice: REMOTE PROVISION -> PUBLIC SERVE
// -> CLEANUP. Later checkpoints extend this same harness (HMR WIRE, REAPER, ISOLATION).
//
// Run:  PROVISIOND_TOKEN=... node provisiond/prove-provisiond.mjs
// Env:  PROVISIOND_TOKEN (required), PROVISIOND_PORT (8790), PROVISIOND_LOCAL_PORT (8799),
//       PROVISIOND_SSH_KEY, PROVISIOND_SSH_HOST (ubuntu@51.195.136.189)

import { spawn, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { REACT_VITE } from "../src/scaffolds/reactVite.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");

const TOKEN = process.env.PROVISIOND_TOKEN;
const REMOTE_PORT = Number(process.env.PROVISIOND_PORT || 8790);
const LOCAL_PORT = Number(process.env.PROVISIOND_LOCAL_PORT || 18790);
const SSH_KEY = process.env.PROVISIOND_SSH_KEY || "C:/Users/Administrator/.ssh/id_ed25519";
const SSH_HOST = process.env.PROVISIOND_SSH_HOST || "ubuntu@51.195.136.189";
const BASE = `http://127.0.0.1:${LOCAL_PORT}`;

const G = "\x1b[32m", R = "\x1b[31m", B = "\x1b[1m", D = "\x1b[2m", X = "\x1b[0m";
let passed = 0, failed = 0;
const ok = (m) => { console.log(`  ${G}PASS${X}  ${m}`); passed++; };
const bad = (m) => { console.log(`  ${R}FAIL${X}  ${m}`); failed++; };
const section = (t) => console.log(`\n${B}--- ${t} ---${X}`);
const info = (m) => console.log(`  ${D}→${X} ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!TOKEN) { console.error("PROVISIOND_TOKEN is required"); process.exit(2); }

const SSH_ARGS = ["-i", SSH_KEY, "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new",
  "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=4"]; // keep the -L tunnel alive through
  // the isolation section's long burst of synchronous `docker exec` ssh calls (which block the loop).
const sshExec = (cmd) => execFileSync("ssh", [...SSH_ARGS, SSH_HOST, cmd], { encoding: "utf8" }).trim();
// Like sshExec but NON-throwing: returns combined stdout+stderr even when the remote command exits
// non-zero. Used by the isolation assertions, which deliberately run commands EXPECTED to fail
// (ls a missing path, wget an unreachable host) and inspect the error text. Remote commands append
// `2>&1` so stderr lands on stdout regardless of exit path.
const sshOut = (cmd) => {
  try { return execFileSync("ssh", [...SSH_ARGS, SSH_HOST, cmd], { encoding: "utf8" }); }
  catch (e) { return `${e.stdout || ""}${e.stderr || ""}`; }
};
const oneLine = (s) => String(s).replace(/\s+/g, " ").trim().slice(0, 100);
const UNREACHABLE = /unreachable|can't connect|connection refused|refused|timed out|timeout|bad address|no route/i;

// Headless WebSocket-upgrade client (mirrors spike/runtime-spike.mjs testHMR 7b). Proves the Vite HMR
// ws handshake survives the Caddy proxy hop: expects 101 + the vite-hmr subprotocol echoed back.
// Scheme-agnostic off the preview URL: http->ws on :80, https->wss on :443 (real LE cert, verified).
function wsUpgrade(urlStr, { timeoutMs = 10_000 } = {}) {
  const u = new URL(urlStr);
  const isTls = u.protocol === "https:";
  const mod = isTls ? https : http;
  const port = u.port || (isTls ? 443 : 80);
  return new Promise((resolve) => {
    const opts = {
      host: u.hostname, port, path: "/", method: "GET",
      headers: {
        Host: u.hostname, Connection: "Upgrade", Upgrade: "websocket",
        "Sec-WebSocket-Key": crypto.randomBytes(16).toString("base64"),
        "Sec-WebSocket-Version": "13", "Sec-WebSocket-Protocol": "vite-hmr",
      },
    };
    if (isTls) opts.servername = u.hostname; // real LE cert; verify normally
    const req = mod.request(opts);
    const t = setTimeout(() => { req.destroy(); resolve({ ok: false, detail: "timeout" }); }, timeoutMs);
    req.on("upgrade", (res, socket) => {
      clearTimeout(t);
      const proto = res.headers["sec-websocket-protocol"];
      try { socket.destroy(); } catch {}
      resolve({ ok: res.statusCode === 101, status: res.statusCode, proto });
    });
    req.on("response", (res) => { clearTimeout(t); res.resume(); resolve({ ok: false, status: res.statusCode, detail: "no-upgrade" }); });
    req.on("error", (e) => { clearTimeout(t); resolve({ ok: false, detail: e.message }); });
    req.end();
  });
}

async function api(method, route, body, _retried = false) {
  try {
    const res = await fetch(`${BASE}${route}`, {
      method,
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { status: res.status, json, text };
  } catch (e) {
    // The single long-lived -L tunnel occasionally drops one request right after the isolation
    // section's synchronous `docker exec` burst (it self-heals immediately). Retry once after a beat.
    if (_retried) throw e;
    await sleep(800);
    return api(method, route, body, true);
  }
}

async function waitTunnel(timeoutMs = 20_000) {
  // Validate the tunnel reaches PROVISIOND specifically — a foreign local listener on the tunnel
  // port would also answer 200, so check for provisiond's health shape (has `capacity`).
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) {
        const j = await res.json().catch(() => ({}));
        if (typeof j.capacity === "number") return true;
        throw new Error(`port ${LOCAL_PORT} answered but is not provisiond (got ${JSON.stringify(j).slice(0, 80)}) — is it free?`);
      }
    } catch (e) {
      if (String(e.message).includes("not provisiond")) throw e;
    }
    await sleep(600);
  }
  throw new Error("tunnel/provisiond /health never came up");
}

function buildTodoTree() {
  const todo = readFileSync(path.join(ROOT, "harness/cases/trees/todo.App.jsx"), "utf8");
  return { ...REACT_VITE, "src/App.jsx": todo };
}

let tunnel = null;
let victimId = null; // second preview used by the isolation proof; cleaned up in finally if it leaks
const projectId = crypto.randomUUID();

async function openTunnel() {
  tunnel = spawn("ssh", [...SSH_ARGS, "-o", "ExitOnForwardFailure=yes", "-N",
    "-L", `${LOCAL_PORT}:127.0.0.1:${REMOTE_PORT}`, SSH_HOST], { stdio: "ignore" });
  tunnel.on("exit", (code) => { if (code) console.error(`ssh tunnel exited ${code}`); });
  await waitTunnel();
}

// Capacity guard proof (opt-in: provisiond must be launched with PREVIEW_CAP=1). Provision A -> ok,
// provision B -> 503 capacity, then tear A down.
async function capacityProof() {
  console.log(`\n${B}=== prove-provisiond (CP-3 capacity: PREVIEW_CAP=1) ===${X}`);
  section("0. Tunnel");
  await openTunnel(); ok("tunnel up");
  const h = await (await fetch(`${BASE}/health`)).json();
  if (h.capacity === 1) ok(`/health capacity=1 (override active)`); else bad(`expected capacity=1, got ${h.capacity}`);
  const a = crypto.randomUUID(), b = crypto.randomUUID();
  section("1. Fill the single slot");
  const ra = await api("POST", "/provision", { projectId: a, tree: buildTodoTree() });
  if (ra.status === 200) ok(`provision A -> 200 (${ra.json?.id})`); else bad(`provision A failed: ${ra.text}`);
  section("2. Next provision is refused at capacity");
  const rb = await api("POST", "/provision", { projectId: b, tree: buildTodoTree() });
  if (rb.status === 503 && rb.json?.code === "capacity") ok(`provision B -> 503 capacity (${rb.json.error})`);
  else bad(`expected 503 capacity, got status=${rb.status} body=${rb.text}`);
  section("3. Teardown");
  await api("POST", "/stop", { projectId: a });
  await api("POST", "/stop", { projectId: b });
  ok("cap-test projects torn down");
}

async function main() {
  console.log(`\n${B}=== prove-provisiond (CP-1: remote provision + tree injection, plain HTTP) ===${X}`);
  info(`ssh ${SSH_HOST} · remote :${REMOTE_PORT} -> local :${LOCAL_PORT} · project ${projectId}`);

  section("0. Open SSH control-plane tunnel");
  await openTunnel();
  ok("tunnel up, provisiond /health reachable");

  section("1. REMOTE PROVISION");
  const prov = await api("POST", "/provision", { projectId, tree: buildTodoTree() });
  const p = prov.json || {};
  if (prov.status === 200 && p.mode === "vps" && /^p[a-z0-9]+$/.test(p.id || "") && /^https?:\/\/p[a-z0-9]+\.[a-z0-9.]+\/$/.test(p.url || "")) {
    ok(`provision -> 200 { id:${p.id}, url:${p.url}, mode:vps }`);
  } else {
    bad(`provision unexpected: status=${prov.status} body=${prov.text}`);
    throw new Error("cannot continue without a provision result");
  }
  const label = p.id, url = p.url;

  const dps = sshExec(`docker ps --format '{{.Names}}'`);
  if (dps.split("\n").includes(label)) ok(`docker ps (over ssh) shows ${label} running`);
  else bad(`container ${label} not in docker ps: ${dps.replace(/\n/g, ", ")}`);

  section("2. PUBLIC SERVE (off-box, public subdomain)");
  const root = await fetch(url).then(async (r) => ({ s: r.status, b: await r.text() })).catch((e) => ({ s: 0, b: String(e) }));
  if (root.s === 200 && root.b.includes("Generated App") && root.b.includes('id="root"')) ok(`GET ${url} -> 200 serving the app shell (index.html)`);
  else bad(`GET ${url} -> status=${root.s}, body head: ${root.b.slice(0, 120)}`);

  const appUrl = `${url}src/App.jsx`;
  const app = await fetch(appUrl).then(async (r) => ({ s: r.status, b: await r.text() })).catch((e) => ({ s: 0, b: String(e) }));
  if (app.s === 200 && app.b.includes("Stay on top of your day")) ok(`GET ${appUrl} -> 200, injected todo tree is live (Vite-transformed)`);
  else bad(`GET ${appUrl} -> status=${app.s}, body head: ${app.b.slice(0, 120)}`);

  const scheme = new URL(url).protocol.replace(":", "");
  section(`2a. HMR WS HANDSHAKE (${scheme === "https" ? "wss/TLS" : "ws"} through Caddy)`);
  const ws = await wsUpgrade(url);
  if (ws.ok && ws.proto === "vite-hmr") ok(`WS upgrade via Caddy -> 101, sec-websocket-protocol: ${ws.proto} (survives the ${scheme} proxy hop)`);
  else bad(`WS upgrade failed: ${JSON.stringify(ws)}`);

  section("2b. HMR UPDATE OVER THE WIRE (docker cp -> Vite HMR)");
  const marker = `// hmr-wire-${Date.now()}`;
  const edited = buildTodoTree()["src/App.jsx"] + "\n" + marker;
  const upd = await api("POST", "/update", { projectId, changedFiles: { "src/App.jsx": edited } });
  if (upd.status === 200) ok(`update -> 200 (changed ${JSON.stringify(upd.json?.changed || [])})`);
  else bad(`update failed: status=${upd.status} ${upd.text}`);
  await sleep(3500);
  const vlog = sshExec(`docker logs ${label} --since 8s 2>&1 | tail -20`);
  if (/hmr update|page reload/i.test(vlog)) ok("Vite emitted an HMR update after the docker-cp change (container log confirms)");
  else bad(`no HMR update in Vite log after update. tail: ${vlog.split("\n").slice(-4).join(" | ")}`);

  section("2c. ISOLATION (CP-4): five spike assertions + Host-pivot closed");
  // Stand up a SECOND live preview B (the pivot victim) with a unique marker embedded in its source,
  // so a successful cross-project reach would be detectable as B's marker leaking into A's fetch.
  const bId = crypto.randomUUID();
  victimId = bId;
  const pivotMarker = `pivot-victim-${crypto.randomBytes(4).toString("hex")}`;
  const bTree = buildTodoTree();
  // Embed the marker as an EXPORTED string literal (not a comment — Vite/esbuild strips comments in
  // the dev transform) so it survives into B's served /src/App.jsx and a cross-project reach would leak it.
  bTree["src/App.jsx"] = bTree["src/App.jsx"] + `\nexport const PIVOT_MARKER = "${pivotMarker}";\n`;
  const bProv = await api("POST", "/provision", { projectId: bId, tree: bTree });
  const bLabel = bProv.json?.id;
  const bHost = bProv.json?.url ? new URL(bProv.json.url).host : null;
  if (bProv.status === 200 && bLabel && bHost) ok(`second preview B provisioned (${bLabel} @ ${bHost})`);
  else { bad(`B provision failed: status=${bProv.status} ${bProv.text}`); throw new Error("cannot run isolation proof without preview B"); }

  // Positive control: B serves its own marker over the PUBLIC path — proves Caddy->container still
  // works after the listener bind (so a failed pivot below is isolation, not a broken proxy).
  const bApp = await fetch(`${bProv.json.url}src/App.jsx`).then(async (r) => ({ s: r.status, b: await r.text() })).catch((e) => ({ s: 0, b: String(e) }));
  if (bApp.s === 200 && bApp.b.includes(pivotMarker)) ok(`control: B's own marker served via its public URL (Caddy->container intact under the bind)`);
  else bad(`control: B's marker not served publicly (status=${bApp.s}) — proxy may be broken by the bind`);

  const A = label; // A's container label (from section 1)
  // 1. Host filesystem invisible (no bind-mount of the host).
  const fs = sshOut(`docker exec ${A} ls /home/ubuntu 2>&1`);
  if (/no such file/i.test(fs)) ok(`[1/5] host FS invisible: ls /home/ubuntu -> "${oneLine(fs)}"`);
  else bad(`[1/5] host FS reachable?! ls /home/ubuntu -> ${oneLine(fs)}`);
  // 2. No internet egress (container is on an --internal net).
  const egress = sshOut(`docker exec ${A} wget -T 4 -qO- http://1.1.1.1/ 2>&1`);
  if (UNREACHABLE.test(egress)) ok(`[2/5] no egress: wget 1.1.1.1 -> "${oneLine(egress)}"`);
  else bad(`[2/5] egress not blocked: wget 1.1.1.1 -> ${oneLine(egress)}`);
  // 3. Cannot reach a peer container (separate --internal nets). Try B's actual container IP directly.
  const bip = sshOut(`docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' ${bLabel} 2>&1`).trim();
  const peer = sshOut(`docker exec ${A} wget -T 4 -qO- http://${bip}:5173/ 2>&1`);
  if (UNREACHABLE.test(peer) && !peer.includes(pivotMarker)) ok(`[3/5] no peer reach: A -> B(${bip}):5173 -> "${oneLine(peer)}"`);
  else bad(`[3/5] peer reachable?! A -> B(${bip}):5173 -> ${oneLine(peer)}`);
  // 4. Non-root.
  const idout = sshOut(`docker exec ${A} id 2>&1`);
  if (/uid=1000\(node\)/.test(idout)) ok(`[4/5] non-root: id -> "${oneLine(idout)}"`);
  else bad(`[4/5] not running as node:1000: id -> ${oneLine(idout)}`);
  // 5. Zero capability bounding set.
  const cap = sshOut(`docker exec ${A} grep CapBnd /proc/self/status 2>&1`);
  if (/CapBnd:\s*0+\b/.test(cap) && /CapBnd:\s*0000000000000000/.test(cap)) ok(`[5/5] CapBnd=0: "${oneLine(cap)}"`);
  else bad(`[5/5] non-zero capability bound: ${oneLine(cap)}`);

  // 6. Host-pivot CLOSED (the gap this checkpoint targets). Caddy is connected to A's net for the
  // return path and resolves by name there, but its listener is bound away from the internal-net IP,
  // so A forging B's Host to Caddy cannot reach B: expect a connection error, and NEVER B's marker.
  const pivot = sshOut(`docker exec ${A} wget -T 5 -qO- --header 'Host: ${bHost}' http://buildr-caddy/src/App.jsx 2>&1`);
  if (!pivot.includes(pivotMarker) && UNREACHABLE.test(pivot)) ok(`Host-pivot CLOSED: A forging Host:${bHost} -> Caddy cannot reach B -> "${oneLine(pivot)}"`);
  else bad(`Host-pivot OPEN or inconclusive (marker leaked=${pivot.includes(pivotMarker)}): ${oneLine(pivot)}`);

  section("2d. ISOLATION teardown (B)");
  const bstop = await api("POST", "/stop", { projectId: bId });
  if (bstop.status === 200 && bstop.json?.stopped === true) ok(`preview B torn down`);
  else bad(`B teardown unexpected: status=${bstop.status} ${bstop.text}`);

  section("3. LIFECYCLE (CP-3): reaper -> RAM reclaim -> cold-start");
  const rid = crypto.randomUUID();
  const rprov = await api("POST", "/provision", { projectId: rid, tree: buildTodoTree() });
  const rlabel = rprov.json?.id;
  if (rprov.status === 200 && rlabel) ok(`provisioned reaper-test container ${rlabel}`);
  else bad(`reaper-test provision failed: ${rprov.text}`);
  await sleep(3500); // let it go idle (no traffic)
  const reap = await api("POST", "/reap", { idleMs: 2000 });
  if (reap.status === 200 && (reap.json?.reaped || []).includes(rlabel)) ok(`reaper stopped idle container (reaped: ${JSON.stringify(reap.json.reaped)})`);
  else bad(`reaper did not stop ${rlabel}: ${reap.text}`);
  const rstate = sshExec(`docker inspect -f '{{.State.Status}}' ${rlabel} 2>&1`).trim();
  const statsNames = sshExec("docker stats --no-stream --format '{{.Name}}' 2>&1").split("\n").map((s) => s.trim());
  if (rstate === "exited" && !statsNames.includes(rlabel)) ok(`RAM reclaimed: ${rlabel} state=exited, absent from docker stats`);
  else bad(`expected exited + no stats; state=${rstate}, in-stats=${statsNames.includes(rlabel)}`);
  const t0 = Date.now();
  const rwake = await api("POST", "/provision", { projectId: rid, tree: buildTodoTree() });
  const coldMs = Date.now() - t0;
  const rstate2 = sshExec(`docker inspect -f '{{.State.Status}}' ${rlabel} 2>&1`).trim();
  if (rwake.status === 200 && rstate2 === "running") ok(`cold-start: back to running in ~${coldMs}ms (${rwake.json?.url})`);
  else bad(`cold-start failed: status=${rwake.status}, state=${rstate2}`);
  const rserve = await fetch(rwake.json?.url).then((r) => r.status).catch(() => 0);
  if (rserve === 200) ok("cold-started preview serves 200"); else bad(`cold-started preview did not serve 200 (got ${rserve})`);
  await api("POST", "/stop", { projectId: rid });
  ok("reaper-test project torn down");

  section("4. CLEANUP");
  const stop = await api("POST", "/stop", { projectId });
  if (stop.status === 200 && stop.json?.stopped === true) ok("stop -> { stopped: true }");
  else bad(`stop unexpected: status=${stop.status} body=${stop.text}`);

  await sleep(500);
  const dps2 = sshExec(`docker ps -a --format '{{.Names}}'`);
  if (!dps2.split("\n").includes(label)) ok(`container ${label} removed (docker ps -a clean)`);
  else bad(`container ${label} still present after stop`);
}

const RUN = process.argv.includes("--capacity") ? capacityProof : main;
RUN()
  .catch((e) => { console.error(`\n${R}prove-provisiond error:${X} ${e.message}`); failed++; })
  .finally(async () => {
    try { await api("POST", "/stop", { projectId }); } catch {}   // best-effort teardown
    try { if (victimId) await api("POST", "/stop", { projectId: victimId }); } catch {} // isolation victim B
    try { if (tunnel && !tunnel.killed) tunnel.kill("SIGTERM"); } catch {}
    console.log(`\n${B}${failed === 0 ? G + "ALL GREEN" : R + "FAILED"}${X}  ${passed} passed, ${failed} failed\n`);
    setTimeout(() => process.exit(failed === 0 ? 0 : 1), 150); // let the ssh child handle close on Windows
  });
