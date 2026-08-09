// Explicit local-only D11 fixture export adapter. The host supplies its extension storage root;
// project folders and production storage are never implicit export targets.

"use strict";

const fs = require("node:fs");
const path = require("node:path");

function createDeploymentLocalExportAdapter({ root, fsApi = fs.promises } = {}) {
  const resolvedRoot = root ? path.resolve(root) : null;

  async function write(payload) {
    if (!resolvedRoot) return unavailable("local_export_storage_unavailable");
    if (!payload || payload.mimeType !== "application/json" || typeof payload.content !== "string") return unavailable("fixture_export_invalid");
    const name = safeName(payload.name);
    if (!name) return unavailable("fixture_export_name_rejected");
    await fsApi.mkdir(resolvedRoot, { recursive: true });
    let file = path.join(resolvedRoot, name);
    try { await fsApi.writeFile(file, payload.content, { encoding: "utf8", flag: "wx" }); }
    catch (error) {
      if (error?.code !== "EEXIST") throw error;
      file = path.join(resolvedRoot, `${path.basename(name, ".json")}-${String(payload.id || "fixture").slice(-8)}.json`);
      await fsApi.writeFile(file, payload.content, { encoding: "utf8", flag: "wx" });
    }
    return Object.freeze({ id: payload.id, kind: "fixture_deployment_export", name, storage: "desktop_local", localPath: file, mimeType: "application/json", bytes: Buffer.byteLength(payload.content), localOnly: true, uploaded: false, available: true });
  }

  return Object.freeze({ write, root: resolvedRoot });
}

function safeName(value) {
  const name = String(value || "").replace(/[^a-z0-9_.-]/gi, "-").slice(0, 120);
  return name && name.endsWith(".json") && name !== ".json" ? name : null;
}
function unavailable(code) { return Object.freeze({ ok: false, code, state: "capability_unavailable", sideEffects: false }); }

module.exports = { createDeploymentLocalExportAdapter, safeName };
