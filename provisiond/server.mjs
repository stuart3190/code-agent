// provisiond — the preview provisioning service. Runs ON the VPS, binds 127.0.0.1 only; the shell
// (and the prover) reach it through an SSH tunnel. It is the ONLY thing that touches Docker.
//
// Routes (bearer-authed except /health):
//   GET  /health                              -> { ok, capacity, running }
//   POST /provision { projectId, tree }       -> { id, url, mode:"vps" }
//   POST /update    { projectId, changedFiles}-> { id, url, changed, mode:"vps" }
//   POST /stop      { projectId }             -> { stopped }
//   GET  /get?projectId=...                   -> { id, url, mode } | null
//
// CP-1 scope: remote provision + dynamic tree injection over plain HTTP via nip.io. No TLS, no
// HMR assertion, no reaper (CP-2/CP-3). The response shape mirrors the shell seam (start/update/
// stop/get -> {url,id,mode}); provisiond's own HTTP verbs stay internal (plan gap #1).

import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import {
  ensureCaddy, createContainer, cpInto, connectCaddy, startContainer,
  destroy, isRunning, containerExists, listPreviewContainers,
} from "./docker.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// --- tiny .env loader (no deps); real env wins, same custody model as the shell -----------------
async function loadEnv() {
  const p = path.join(HERE, ".env");
  if (!existsSync(p)) return;
  const text = await readFile(p, "utf8");
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[k] === undefined) process.env[k] = v;
  }
}
await loadEnv();

const PORT = Number(process.env.PROVISIOND_PORT || 8790);
const TOKEN = process.env.PROVISIOND_TOKEN || "";
const SUFFIX = process.env.PREVIEW_PUBLIC_SUFFIX || "33c388bd.nip.io";
const SCHEME = process.env.PREVIEW_SCHEME || "http";
const HTTPS = SCHEME === "https";
// Caddy front config derives from the scheme: plain :80 (stock caddy) vs :443 TLS (custom caddy with
// the Cloudflare DNS plugin, DNS-01 token from env). The TLS front also publishes :80 for http->https.
const CADDY_CFG = {
  caddyfilePath: path.join(HERE, HTTPS ? "Caddyfile.tls" : "Caddyfile"),
  image: process.env.CADDY_IMAGE || (HTTPS ? "buildr-caddy:latest" : "caddy:2-alpine"),
  publish: HTTPS ? ["443:443", "80:80"] : ["80:80"],
  env: HTTPS && process.env.CLOUDFLARE_API_TOKEN ? { CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN } : {},
  scheme: SCHEME,
};
const AVAILABLE_MB = Number(process.env.AVAILABLE_MB || 6500);
const PER_CONTAINER_MB = 118; // RUNTIME.md measured idle RSS

if (!TOKEN) { console.error("[provisiond] refusing to start: PROVISIOND_TOKEN is empty"); process.exit(1); }

// projectId (often a UUID) -> DNS-safe, docker-safe, lowercase label. NB: strip ALL non-alphanumeric
// (incl. hyphens) — nip.io mis-parses dash groups in a UUID as a dash-format IP (proven: a hyphenated
// UUID label resolved to the wrong host). A single alphanumeric token falls through to the hex suffix.
function labelFor(projectId) {
  const slug = String(projectId).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 48);
  return `p${slug || "x"}`;
}
const urlFor = (label) => `${SCHEME}://${label}.${SUFFIX}/`;
const hostFor = (label) => `${label}.${SUFFIX}`;

// Poll the full path through Caddy (with the project's Host header) until Vite answers 200. In https
// mode this hits :443 with SNI = the label host (cert won't match 127.0.0.1, so rejectUnauthorized off)
// — polling :80 would only see Caddy's http->https redirect, not the 200.
function waitReady(label, timeoutMs = 120_000) {
  const host = hostFor(label);
  const deadline = Date.now() + timeoutMs;
  const mod = HTTPS ? https : http;
  const opts = { host: "127.0.0.1", port: HTTPS ? 443 : 80, path: "/", headers: { Host: host }, timeout: 5000 };
  if (HTTPS) { opts.servername = host; opts.rejectUnauthorized = false; }
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = mod.get(opts, (res) => {
        res.resume();
        if (res.statusCode === 200) return resolve(true);
        retry();
      });
      req.on("error", retry);
      req.on("timeout", () => { req.destroy(); retry(); });
    };
    const retry = () => { if (Date.now() > deadline) reject(new Error(`preview ${label} not ready in ${timeoutMs}ms`)); else setTimeout(tick, 800); };
    tick();
  });
}

// Materialize the tree to a temp dir, then docker cp it into the container's /app.
// vite.config.js is OMITTED — the entrypoint writes the authoritative one from env.
async function injectTree(label, tree) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "provisiond-"));
  try {
    for (const [rel, contents] of Object.entries(tree)) {
      if (rel === "vite.config.js") continue;
      const full = path.join(dir, rel);
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, contents, "utf8");
    }
    await cpInto(label, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function provision(projectId, tree) {
  const label = labelFor(projectId);
  await ensureCaddy(CADDY_CFG);
  if (await containerExists(label)) await destroy(label); // CP-1: recreate fresh (CP-3 = true restart)
  await createContainer(label, {
    VITE_HOST: hostFor(label),
    VITE_CLIENT_PORT: SCHEME === "https" ? 443 : 80,
    VITE_HMR_PROTOCOL: SCHEME === "https" ? "wss" : "ws",
  });
  await injectTree(label, tree);
  await connectCaddy(label);
  await startContainer(label);
  await waitReady(label);
  return { id: label, url: urlFor(label), mode: "vps" };
}

async function update(projectId, changedFiles) {
  const label = labelFor(projectId);
  if (!(await isRunning(label))) return provision(projectId, changedFiles); // seam: update falls back to start
  await injectTree(label, changedFiles || {});
  return { id: label, url: urlFor(label), changed: Object.keys(changedFiles || {}), mode: "vps" };
}

async function stop(projectId) {
  const label = labelFor(projectId);
  const stopped = await destroy(label);
  return { stopped };
}

async function get(projectId) {
  const label = labelFor(projectId);
  return (await isRunning(label)) ? { id: label, url: urlFor(label), mode: "vps" } : null;
}

// --- http plumbing ------------------------------------------------------------------------------
const send = (res, code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
const readJson = (req) => new Promise((resolve) => {
  const chunks = []; req.on("data", (c) => chunks.push(c));
  req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); } catch { resolve({}); } });
  req.on("error", () => resolve({}));
});
const authed = (req) => (req.headers.authorization || "") === `Bearer ${TOKEN}`;

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://x");
    const p = url.pathname;

    if (p === "/health") {
      const running = await listPreviewContainers();
      return send(res, 200, { ok: true, capacity: Math.floor(AVAILABLE_MB / PER_CONTAINER_MB), running: running.length });
    }
    if (!authed(req)) return send(res, 401, { error: "unauthorized" });

    if (p === "/provision" && req.method === "POST") {
      const { projectId, tree } = await readJson(req);
      if (!projectId || !tree || typeof tree !== "object") return send(res, 400, { error: "projectId and tree required" });
      return send(res, 200, await provision(projectId, tree));
    }
    if (p === "/update" && req.method === "POST") {
      const { projectId, changedFiles } = await readJson(req);
      if (!projectId) return send(res, 400, { error: "projectId required" });
      return send(res, 200, await update(projectId, changedFiles));
    }
    if (p === "/stop" && req.method === "POST") {
      const { projectId } = await readJson(req);
      if (!projectId) return send(res, 400, { error: "projectId required" });
      return send(res, 200, await stop(projectId));
    }
    if (p === "/get" && req.method === "GET") {
      const projectId = url.searchParams.get("projectId");
      if (!projectId) return send(res, 400, { error: "projectId required" });
      return send(res, 200, (await get(projectId)) || { result: null });
    }
    return send(res, 404, { error: `no route ${req.method} ${p}` });
  } catch (e) {
    return send(res, 500, { error: e.message });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[provisiond] listening on 127.0.0.1:${PORT} · suffix ${SUFFIX} · scheme ${SCHEME}`);
});
