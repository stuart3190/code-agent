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

const SSH_ARGS = ["-i", SSH_KEY, "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new"];
const sshExec = (cmd) => execFileSync("ssh", [...SSH_ARGS, SSH_HOST, cmd], { encoding: "utf8" }).trim();

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

async function api(method, route, body) {
  const res = await fetch(`${BASE}${route}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
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
const projectId = crypto.randomUUID();

async function main() {
  console.log(`\n${B}=== prove-provisiond (CP-1: remote provision + tree injection, plain HTTP) ===${X}`);
  info(`ssh ${SSH_HOST} · remote :${REMOTE_PORT} -> local :${LOCAL_PORT} · project ${projectId}`);

  section("0. Open SSH control-plane tunnel");
  tunnel = spawn("ssh", [...SSH_ARGS, "-o", "ExitOnForwardFailure=yes", "-N",
    "-L", `${LOCAL_PORT}:127.0.0.1:${REMOTE_PORT}`, SSH_HOST], { stdio: "ignore" });
  tunnel.on("exit", (code) => { if (code) console.error(`ssh tunnel exited ${code}`); });
  await waitTunnel();
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

  section("3. CLEANUP");
  const stop = await api("POST", "/stop", { projectId });
  if (stop.status === 200 && stop.json?.stopped === true) ok("stop -> { stopped: true }");
  else bad(`stop unexpected: status=${stop.status} body=${stop.text}`);

  await sleep(500);
  const dps2 = sshExec(`docker ps -a --format '{{.Names}}'`);
  if (!dps2.split("\n").includes(label)) ok(`container ${label} removed (docker ps -a clean)`);
  else bad(`container ${label} still present after stop`);
}

main()
  .catch((e) => { console.error(`\n${R}prove-provisiond error:${X} ${e.message}`); failed++; })
  .finally(async () => {
    try { await api("POST", "/stop", { projectId }); } catch {}   // best-effort teardown
    try { if (tunnel && !tunnel.killed) tunnel.kill("SIGTERM"); } catch {}
    console.log(`\n${B}${failed === 0 ? G + "ALL GREEN" : R + "FAILED"}${X}  ${passed} passed, ${failed} failed\n`);
    setTimeout(() => process.exit(failed === 0 ? 0 : 1), 150); // let the ssh child handle close on Windows
  });
