import { createQaRun, getQaRun, listQaRuns } from "../lib/qaRuns.mjs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const json = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
};

export async function handleQaStart(req, res, body, owner) {
  const projectId = body?.projectId;
  if (!projectId) return json(res, 400, { error: "projectId is required" });
  try {
    const run = await createQaRun(owner, projectId);
    return run ? json(res, 202, run) : json(res, 404, { error: "project not found" });
  } catch (error) {
    if (error.code === "upgrade_required") return json(res, 402, { error: error.message, code: error.code });
    if (error.code === "feature_unavailable") return json(res, 404, { error: error.message, code: error.code });
    if (error.code === "no_app") return json(res, 409, { error: error.message, code: error.code });
    throw error;
  }
}

export async function handleQaGet(req, res, runId, owner) {
  const run = await getQaRun(owner.id, runId);
  return run ? json(res, 200, run) : json(res, 404, { error: "test run not found" });
}

export async function handleQaList(req, res, url, owner) {
  const projectId = url.searchParams.get("projectId");
  if (!projectId) return json(res, 400, { error: "projectId is required" });
  const runs = await listQaRuns(owner.id, projectId);
  return runs == null ? json(res, 404, { error: "project not found" }) : json(res, 200, { runs });
}

export async function handleQaArtifact(req, res, runId, filename, owner) {
  if (!/^[a-z0-9-]+\.jpg$/.test(filename)) return json(res, 404, { error: "artifact not found" });
  const run = await getQaRun(owner.id, runId);
  if (!run) return json(res, 404, { error: "test run not found" });
  const root = process.env.QA_ARTIFACT_DIR || path.join(os.homedir(), "thrallo-qa");
  const file = path.join(root, run.id, filename);
  try {
    const data = await readFile(file);
    res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=300" });
    return res.end(data);
  } catch {
    return json(res, 404, { error: "artifact not found" });
  }
}
