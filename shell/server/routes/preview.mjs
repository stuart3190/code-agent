// POST /api/preview  { projectId, tree }  -> { url, mode }
//
// (Re)start a live preview for an ALREADY-GENERATED tree — used when reopening a saved project so it
// can preview WITHOUT spending Codex quota. Generation itself drives preview inline via the same seam.

import { previewProvider } from "../preview/index.mjs";
import { withRuntimeEnv } from "../lib/runtimeEnv.mjs";

export async function handlePreview(req, res, body /*, owner */) {
  const projectId = body?.projectId;
  const tree = body?.tree;
  if (!projectId || !tree || typeof tree !== "object") {
    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "projectId and tree are required" }));
  }
  try {
    // Inject the runtime backend .env at materialization (saved tree stays clean).
    const result = await previewProvider().start(projectId, withRuntimeEnv(tree, projectId));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
  } catch (e) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: e.message }));
  }
}
