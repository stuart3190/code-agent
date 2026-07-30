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
import { mkdtemp, mkdir, writeFile, rm, readFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import {
  ensureCaddy, createContainer, cpInto, connectCaddy, startContainer, stopContainer,
  destroy, containerState, listPreviewContainers, removeDanglingNets, caddyLogs, PUBLISH_ROOT,
  containerExists,
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
const CAP = Number(process.env.PREVIEW_CAP || Math.floor(AVAILABLE_MB / PER_CONTAINER_MB)); // RAM-bound (~55)
const REAP_IDLE_MS = Number(process.env.REAP_IDLE_MS || 10 * 60 * 1000);   // billing model: ~10 min idle
const REAP_INTERVAL_MS = Number(process.env.REAP_INTERVAL_MS || 60 * 1000);

if (!TOKEN) { console.error("[provisiond] refusing to start: PROVISIOND_TOKEN is empty"); process.exit(1); }

// Activity tracking for the reaper: last provisiond-side touch (provision/update/get) per label, merged
// with the latest Caddy access-log request time per host (so an actively-browsed preview isn't reaped).
const touched = new Map();
const touch = (label) => touched.set(label, Date.now());
const labelFromHost = (h) => String(h || "").split(".")[0];

async function caddyActivity(sinceSec) {
  const raw = await caddyLogs(sinceSec);
  const map = new Map();
  for (const line of (raw ? raw.split("\n") : [])) {
    if (!line.includes('"request"')) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
    const host = j?.request?.host, ts = j?.ts;
    if (!host || !ts) continue;
    const label = labelFromHost(host), ms = ts * 1000;
    if (!(map.get(label) >= ms)) map.set(label, ms);
  }
  return map;
}

// Stop running previews whose last activity (touch OR access log) exceeds idleMs. docker stop frees the
// full RSS (RUNTIME.md); the container is kept for a fast cold-start. Returns the reaped labels.
async function reapOnce(idleMs = REAP_IDLE_MS) {
  const running = await listPreviewContainers();
  if (!running.length) return [];
  const act = await caddyActivity(Math.ceil(idleMs / 1000) + 60);
  const now = Date.now();
  const reaped = [];
  for (const label of running) {
    const last = Math.max(touched.get(label) || 0, act.get(label) || 0);
    if (last && now - last > idleMs) { await stopContainer(label); reaped.push(label); }
  }
  return reaped;
}

// Refuse past the RAM-bound cap. A label already running (re-provision/wake) doesn't add a slot.
async function enforceCapacity(label) {
  const running = await listPreviewContainers();
  if (running.includes(label)) return;
  if (running.length >= CAP) { const e = new Error(`capacity reached (${running.length}/${CAP} previews running)`); e.code = "capacity"; throw e; }
}

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

const envFor = (label) => ({
  VITE_HOST: hostFor(label),
  VITE_CLIENT_PORT: HTTPS ? 443 : 80,
  VITE_HMR_PROTOCOL: HTTPS ? "wss" : "ws",
});

// Idempotent: absent -> create+inject; stopped -> cold-start (refresh tree, `docker start`); running ->
// refresh tree (HMR). No destroy-on-provision (CP-1's behaviour) — the reaper leaves stopped containers
// for a fast wake. The capacity guard bites only when a NEW slot would be consumed.
async function provision(projectId, tree) {
  const label = labelFor(projectId);
  await ensureCaddy(CADDY_CFG);
  const state = await containerState(label);
  if (state === "absent") {
    await enforceCapacity(label);
    await createContainer(label, envFor(label));
    await injectTree(label, tree);
  } else if (state !== "running") { // stopped/exited -> cold start
    await enforceCapacity(label);
    await injectTree(label, tree);
  } else {                          // already running -> refresh (HMR)
    await injectTree(label, tree);
  }
  await connectCaddy(label);        // idempotent; re-links this net after a Caddy recreate
  if ((await containerState(label)) !== "running") await startContainer(label);
  touch(label);
  await waitReady(label);
  return { id: label, url: urlFor(label), mode: "vps" };
}

async function update(projectId, changedFiles) {
  const label = labelFor(projectId);
  if ((await containerState(label)) !== "running") return provision(projectId, changedFiles); // wake if reaped
  await injectTree(label, changedFiles || {});
  touch(label);
  return { id: label, url: urlFor(label), changed: Object.keys(changedFiles || {}), mode: "vps" };
}

async function stop(projectId) {
  const label = labelFor(projectId);
  const stopped = await destroy(label); // seam stop = full teardown (vs the reaper's keep-stopped)
  touched.delete(label);
  return { stopped };
}

async function get(projectId) {
  const label = labelFor(projectId);
  if ((await containerState(label)) === "running") { touch(label); return { id: label, url: urlFor(label), mode: "vps" }; }
  return null;
}

// ── F7 publish: static site hosting ─────────────────────────────────────────────────────────────
// files = { relPath: base64Contents } of a BUILT dist (binary-safe). Written atomically
// (tmp dir -> rename) under PUBLISH_ROOT/<label>; Caddy serves it read-only on <label>.<APP_SUFFIX>.
// Republish overwrites the same label. Static = no container, no reaper, no capacity slot.
const APP_SUFFIX = process.env.PUBLISH_PUBLIC_SUFFIX || "app.buildr101.com";
const PUBLISH_MAX_BYTES = Number(process.env.PUBLISH_MAX_BYTES || 25 * 1024 * 1024);

// Site-name slugs: real DNS labels under *.app.buildr101.com — dashes are FINE here (the
// dash-free rule is a nip.io preview quirk only). Ownership/uniqueness is the SHELL's job
// (published_sites table); provisiond just validates shape and refuses reserved names.
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$/;
const RESERVED_SLUGS = new Set(["www", "api", "app", "apps", "preview", "admin", "mail", "buildr", "buildr101", "shell", "static", "assets"]);
function labelForPublish(projectId, slug) {
  if (slug !== undefined && slug !== null && slug !== "") {
    const s = String(slug).toLowerCase();
    if (!SLUG_RE.test(s) || RESERVED_SLUGS.has(s)) { const e = new Error(`invalid site name: ${s}`); e.code = "bad_slug"; throw e; }
    return s;
  }
  return labelFor(projectId);
}

async function publishSite(projectId, files, slug) {
  const label = labelForPublish(projectId, slug);
  await ensureCaddy(CADDY_CFG); // publish mount + *.app cert config live on the Caddy front
  const entries = Object.entries(files);
  let total = 0;
  const dir = path.join(PUBLISH_ROOT, label);
  const tmp = `${dir}.tmp`;
  await rm(tmp, { recursive: true, force: true });
  try {
    for (const [rel, b64] of entries) {
      const norm = path.normalize(String(rel));
      if (norm.startsWith("..") || path.isAbsolute(norm)) continue; // traversal guard
      const buf = Buffer.from(String(b64), "base64");
      total += buf.length;
      if (total > PUBLISH_MAX_BYTES) throw new Error(`publish exceeds ${PUBLISH_MAX_BYTES} bytes`);
      const full = path.join(tmp, norm);
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, buf);
    }
    await rm(dir, { recursive: true, force: true });
    await rename(tmp, dir);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  return { id: label, url: `https://${label}.${APP_SUFFIX}/`, mode: "published", files: entries.length, bytes: total };
}

// ── Custom domains ───────────────────────────────────────────────────────────────────────────
// A custom domain maps to a published site via a RELATIVE symlink under PUBLISH_ROOT/_domains
// (resolves inside Caddy's read-only /publish mount): /publish/_domains/<domain> -> ../<label>.
// Caddy's catch-all https:// site serves root /publish/_domains/{host}; its on-demand TLS asks
// the shell's /api/domain-check before issuing a cert, so only registered domains get certs.
const DOMAIN_RE = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

function domainPath(domain) {
  const d = String(domain).toLowerCase();
  if (!DOMAIN_RE.test(d) || d.endsWith(".buildr101.com") || d === "buildr101.com") {
    const e = new Error(`invalid domain: ${d}`); e.code = "bad_domain"; throw e;
  }
  return { d, link: path.join(PUBLISH_ROOT, "_domains", d) };
}

async function attachDomain(domain, label) {
  if (!SLUG_RE.test(String(label)) && !/^p[a-z0-9]+$/.test(String(label))) throw new Error(`invalid label: ${label}`);
  const { d, link } = domainPath(domain);
  await mkdir(path.join(PUBLISH_ROOT, "_domains"), { recursive: true });
  await rm(link, { force: true });
  const { symlink } = await import("node:fs/promises");
  await symlink(`../${label}`, link, "dir");
  return { domain: d, label };
}

async function detachDomain(domain) {
  const { d, link } = domainPath(domain);
  const existed = existsSync(link);
  await rm(link, { force: true });
  return { domain: d, detached: existed };
}

async function unpublishSite(projectId, slug) {
  const label = labelForPublish(projectId, slug);
  const dir = path.join(PUBLISH_ROOT, label);
  const existed = existsSync(dir);
  await rm(dir, { recursive: true, force: true });
  return { id: label, unpublished: existed };
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
      return send(res, 200, { ok: true, capacity: CAP, running: running.length, reapIdleMs: REAP_IDLE_MS });
    }
    if (!authed(req)) return send(res, 401, { error: "unauthorized" });

    if (p === "/reap" && req.method === "POST") {
      const { idleMs } = await readJson(req);
      const reaped = await reapOnce(typeof idleMs === "number" ? idleMs : REAP_IDLE_MS);
      return send(res, 200, { reaped });
    }

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
    if (p === "/publish" && req.method === "POST") {
      const { projectId, files, slug } = await readJson(req);
      if (!projectId || !files || typeof files !== "object") return send(res, 400, { error: "projectId and files required" });
      return send(res, 200, await publishSite(projectId, files, slug));
    }
    if (p === "/unpublish" && req.method === "POST") {
      const { projectId, slug } = await readJson(req);
      if (!projectId) return send(res, 400, { error: "projectId required" });
      return send(res, 200, await unpublishSite(projectId, slug));
    }
    if (p === "/domain-attach" && req.method === "POST") {
      const { domain, label } = await readJson(req);
      if (!domain || !label) return send(res, 400, { error: "domain and label required" });
      return send(res, 200, await attachDomain(domain, label));
    }
    if (p === "/domain-detach" && req.method === "POST") {
      const { domain } = await readJson(req);
      if (!domain) return send(res, 400, { error: "domain required" });
      return send(res, 200, await detachDomain(domain));
    }
    // On-demand-TLS support: does this label correspond to a real preview container or published
    // site? The shell's /api/domain-check asks before Caddy is allowed to mint a certificate —
    // without this, any stranger connecting to the VPS with an invented SNI could burn through
    // the CA rate limit for the preview suffix.
    if (p === "/exists" && req.method === "GET") {
      const label = String(url.searchParams.get("label") || "").toLowerCase();
      if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(label)) return send(res, 200, { exists: false });
      const exists = (await containerExists(label)) || existsSync(path.join(PUBLISH_ROOT, label));
      return send(res, 200, { exists });
    }
    if (p === "/get" && req.method === "GET") {
      const projectId = url.searchParams.get("projectId");
      if (!projectId) return send(res, 400, { error: "projectId required" });
      return send(res, 200, (await get(projectId)) || { result: null });
    }
    return send(res, 404, { error: `no route ${req.method} ${p}` });
  } catch (e) {
    return send(res, e.code === "capacity" ? 503 : 500, { error: e.message, code: e.code });
  }
});

server.listen(PORT, "127.0.0.1", async () => {
  console.log(`[provisiond] listening on 127.0.0.1:${PORT} · suffix ${SUFFIX} · scheme ${SCHEME}`);
  try {
    const removed = await removeDanglingNets();                 // orphan cleanup
    // Re-raise the Caddy front after a VPS reboot: the container doesn't auto-restart and its old
    // preview-net attachments may have just been removed above, so docker start would fail anyway —
    // ensureCaddy rm -f's the dead one and runs a fresh front (certs persist in buildr-caddy-data).
    // Without this, a reboot leaves :443 down until the next provision/publish — which can't arrive,
    // because those requests come through Caddy.
    await ensureCaddy(CADDY_CFG);
    const running = await listPreviewContainers();
    for (const l of running) touch(l);                          // adopt survivors so they aren't reaped at once
    console.log(`[provisiond] boot: cap ${CAP} · adopted ${running.length} running preview(s) · removed ${removed.length} dangling net(s) · caddy up · reap idle ${REAP_IDLE_MS}ms`);
  } catch (e) {
    console.error("[provisiond] boot cleanup error:", e.message);
  }
  setInterval(() => { reapOnce().catch((e) => console.error("[reaper]", e.message)); }, REAP_INTERVAL_MS);
});
