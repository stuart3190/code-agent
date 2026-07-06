// POST /api/publish  { projectId, tree }  -> { url, files, bytes }
//
// F7 publish v1: static export to the VPS. Builds the tree (same bar as generate), reads the
// resulting dist/, and ships it base64-encoded to provisiond's /publish, which serves it on
// https://<label>.app.buildr101.com. The runtime backend config is injected at build time
// (withRuntimeEnv) — "backend as a parameter" (DECISION-hosting.md) holds: the SAVED tree and
// export ZIPs stay clean; a different backend later = republish, no code change.

import path from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { buildTree, ensureDeps, workDirFor } from "../../../harness/workspace.mjs";
import { withRuntimeEnv } from "../lib/runtimeEnv.mjs";

const PROVISIOND_URL = () => process.env.PROVISIOND_URL;
const PROVISIOND_TOKEN = () => process.env.PROVISIOND_TOKEN;

async function readDistAsBase64(dir) {
  const files = {};
  async function walk(relDir) {
    for (const entry of await readdir(path.join(dir, relDir), { withFileTypes: true })) {
      const childRel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(childRel);
      else files[childRel] = (await readFile(path.join(dir, childRel))).toString("base64");
    }
  }
  await walk("");
  return files;
}

// POST /api/unpublish { projectId } — remove the published static site (the URL then 404s).
export async function handleUnpublish(req, res, body /*, owner */) {
  const projectId = body?.projectId;
  if (!projectId) {
    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "projectId is required" }));
  }
  if (!PROVISIOND_URL() || !PROVISIOND_TOKEN()) {
    res.writeHead(503, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "publishing is not configured (PROVISIOND_URL/TOKEN)" }));
  }
  try {
    const r = await fetch(`${PROVISIOND_URL()}/unpublish`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${PROVISIOND_TOKEN()}` },
      body: JSON.stringify({ projectId }),
    });
    const out = await r.json();
    if (!r.ok) throw new Error(out.error || `provisiond unpublish ${r.status}`);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ unpublished: out.unpublished }));
  } catch (e) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: e.message }));
  }
}

export async function handlePublish(req, res, body /*, owner */) {
  const projectId = body?.projectId;
  const tree = body?.tree;
  if (!projectId || !tree || typeof tree !== "object") {
    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "projectId and tree are required" }));
  }
  if (!PROVISIOND_URL() || !PROVISIOND_TOKEN()) {
    res.writeHead(503, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "publishing is not configured (PROVISIOND_URL/TOKEN)" }));
  }
  try {
    await ensureDeps(() => {});
    const caseName = `pub-${projectId}`.replace(/[^a-zA-Z0-9_-]/g, "_");
    const build = await buildTree(withRuntimeEnv(tree, projectId), caseName, () => {});
    if (!build.ok) {
      res.writeHead(422, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "build failed", stderr: (build.stderr || "").slice(-2000) }));
    }
    const files = await readDistAsBase64(path.join(workDirFor(caseName), "dist"));
    const r = await fetch(`${PROVISIOND_URL()}/publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${PROVISIOND_TOKEN()}` },
      body: JSON.stringify({ projectId, files }),
    });
    const out = await r.json();
    if (!r.ok) throw new Error(out.error || `provisiond publish ${r.status}`);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ url: out.url, files: out.files, bytes: out.bytes }));
  } catch (e) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: e.message }));
  }
}
