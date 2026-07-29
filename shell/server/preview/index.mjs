// The PREVIEW seam — the same shape a future VPS provisioner will satisfy, so the shell
// never learns which backing is live:
//
//   provider.start(projectId, tree)   -> { url, id, mode }     (idempotent: restarts if needed)
//   provider.update(projectId, tree)  -> { url, id, changed }  (writes changed files -> HMR)
//   provider.stop(projectId)          -> { stopped }
//   provider.get(projectId)           -> { url, mode } | null
//
// TWO implementations:
//   * localVite  (REAL, default on this VM): flushes the tree to shell/.previews/<id>, junctions in
//     the shared scaffold node_modules (the proven harness/.deps trick), and runs a real Vite dev
//     server on a free port. The iframe points straight at it, so preview + HMR are genuinely live —
//     minus the container isolation + subdomain the VPS adds. Iterate writes changed files -> Vite's
//     watcher HMR-updates the same server.
//   * vpsProvision (REAL, PREVIEW_MODE=vps): a thin HTTP client to provisiond over the SSH tunnel
//     (RUNTIME.md container + Caddy wildcard-TLS/HMR, live on the VPS). Serves previews at
//     https://<label>.preview.<suffix>/ with real isolation + TLS.
//   * vpsProvisionStub (PREVIEW_MODE=vps-stub): the original no-op boundary, kept selectable.
//     Returns url:null so the UI shows "VPS preview pending".
//
// Selected by PREVIEW_MODE env (default "local"; "vps" = real provisiond, "vps-stub" = no-op).

import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import http from "node:http";
import { REPO_ROOT } from "../lib/env.mjs";
import { ensureDeps } from "../../../harness/workspace.mjs";

const DEPS_NM = path.join(REPO_ROOT, "harness", ".deps", "node_modules");
const PREVIEW_ROOT = path.join(REPO_ROOT, "shell", ".previews");
const BASE_PORT = Number(process.env.PREVIEW_BASE_PORT || 5200);

function pollHttp(port, timeoutMs = 40_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get({ host: "127.0.0.1", port, path: "/", timeout: 3000 }, (res) => {
        res.resume();
        resolve(true);
      });
      req.on("error", () => {
        if (Date.now() > deadline) reject(new Error(`vite preview on :${port} did not come up`));
        else setTimeout(tick, 700);
      });
      req.on("timeout", () => { req.destroy(); });
    };
    tick();
  });
}

// ── localVite ────────────────────────────────────────────────────────────────────────────────
function createLocalVite() {
  const live = new Map();   // id -> { proc, port, dir, url, tree }
  let nextPort = BASE_PORT;
  const allocPort = () => nextPort++;

  async function writeTree(dir, tree, prev) {
    await mkdir(dir, { recursive: true });
    const changed = [];
    for (const [rel, contents] of Object.entries(tree)) {
      if (prev && prev[rel] === contents) continue;
      const full = path.join(dir, rel);
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, contents, "utf8");
      changed.push(rel);
    }
    return changed;
  }

  function junctionDeps(dir) {
    const nm = path.join(dir, "node_modules");
    if (!existsSync(nm)) {
      // Windows junction (same trick harness/workspace.mjs uses to share one install).
      execFileSync("cmd", ["/c", "mklink", "/J", nm, DEPS_NM], { stdio: "ignore" });
    }
  }

  async function start(id, tree) {
    await ensureDeps(() => {});
    const existing = live.get(id);
    if (existing && !existing.proc.killed) {
      return update(id, tree);
    }
    const dir = path.join(PREVIEW_ROOT, String(id));
    await rm(dir, { recursive: true, force: true });
    await writeTree(dir, tree);
    junctionDeps(dir);

    const port = allocPort();
    const viteBin = path.join(dir, "node_modules", "vite", "bin", "vite.js");
    const proc = spawn(process.execPath, [viteBin, "--port", String(port), "--strictPort", "--host", "127.0.0.1"], {
      cwd: dir,
      stdio: "ignore",
      windowsHide: true,
    });
    proc.on("exit", () => { if (live.get(id)?.proc === proc) live.delete(id); });

    await pollHttp(port);
    const url = `http://localhost:${port}/`;
    live.set(id, { proc, port, dir, url, tree: { ...tree } });
    return { url, id, mode: "local" };
  }

  async function update(id, tree) {
    const entry = live.get(id);
    if (!entry) return start(id, tree);
    const changed = await writeTree(entry.dir, tree, entry.tree);
    entry.tree = { ...tree };
    return { url: entry.url, id, changed, mode: "local" };
  }

  async function stop(id) {
    const entry = live.get(id);
    if (!entry) return { stopped: false };
    try { entry.proc.kill(); } catch {}
    live.delete(id);
    return { stopped: true };
  }

  function get(id) {
    const entry = live.get(id);
    return entry ? { url: entry.url, mode: "local" } : null;
  }

  return { start, update, stop, get, mode: "local" };
}

// ── vpsProvision (STUB — the deferred VPS boundary) ────────────────────────────────────────────
function createVpsProvisionStub() {
  const NOTE =
    "VPS container preview is a deferred boundary (RUNTIME.md proved the container + nginx-HMR proxy; " +
    "wiring the provisioning service is its own session). This stub returns no URL by design.";
  async function start() { return { url: null, mode: "vps-stub", note: NOTE }; }
  async function update() { return { url: null, mode: "vps-stub", note: NOTE }; }
  async function stop() { return { stopped: false, mode: "vps-stub" }; }
  function get() { return null; }
  return { start, update, stop, get, mode: "vps-stub" };
}

// ── vpsProvision (REAL — thin HTTP client to provisiond over the SSH tunnel) ───────────────────
// Conforms EXACTLY to the seam (start/update/stop/get -> {url,id,mode}). provisiond binds
// 127.0.0.1 on the VPS; PROVISIOND_URL is the local end of the SSH tunnel. It already returns the
// seam shape, so this is a near-passthrough. update() forwards the FULL tree as changedFiles:
// provisiond cp's them all (HMR refresh if running) and, if the container was reaped, rebuilds
// from them — correct either way, so the shell keeps no per-project diff state.
function createVpsProvision() {
  const BASE = process.env.PROVISIOND_URL;
  const TOKEN = process.env.PROVISIOND_TOKEN || "";
  if (!BASE) throw new Error("PREVIEW_MODE=vps requires PROVISIOND_URL (the SSH tunnel to provisiond)");

  async function call(method, pathname, body) {
    const res = await fetch(`${BASE}${pathname}`, {
      method,
      headers: {
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch {}
    if (!res.ok) {
      const err = new Error(data.error || `provisiond ${method} ${pathname} -> ${res.status}`);
      err.code = data.code; err.status = res.status;
      throw err;
    }
    return data;
  }

  async function start(id, tree) {
    const r = await call("POST", "/provision", { projectId: id, tree });
    return { url: r.url, id: r.id, mode: r.mode || "vps" };
  }
  async function update(id, tree) {
    const r = await call("POST", "/update", { projectId: id, changedFiles: tree });
    return { url: r.url, id: r.id, changed: r.changed, mode: r.mode || "vps" };
  }
  async function stop(id) {
    const r = await call("POST", "/stop", { projectId: id });
    return { stopped: !!r.stopped };
  }
  async function get(id) {
    const r = await call("GET", `/get?projectId=${encodeURIComponent(id)}`);
    return r && r.url ? { url: r.url, mode: r.mode || "vps" } : null; // {result:null} -> null
  }
  return { start, update, stop, get, mode: "vps" };
}

let _provider = null;
export function previewProvider() {
  if (_provider) return _provider;
  const mode = (process.env.PREVIEW_MODE || "local").toLowerCase();
  if (mode === "vps") _provider = createVpsProvision();            // REAL VPS — never the stub
  else if (mode === "vps-stub") _provider = createVpsProvisionStub(); // stub kept selectable
  else _provider = createLocalVite();
  return _provider;
}
