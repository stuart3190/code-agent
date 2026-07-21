import { capabilityOverview, clearRuntimeCredential, deleteCapability, saveActionSchedule, saveCapability, saveKnowledgeBase } from "../lib/capabilities.mjs";

const json = (res, status, body) => { res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(body)); };
const known = (error) => ["bad_capability","feature_unavailable","feature_not_allowed"].includes(error?.code);

export async function handleCapabilities(req, res, { method, url, body, owner }) {
  const projectId = method === "GET" ? url.searchParams.get("projectId") : body?.projectId;
  if (!projectId) return json(res, 400, { error: "projectId is required" });
  try {
    if (method === "GET") { const result = await capabilityOverview(owner, projectId); return result ? json(res, 200, result) : json(res, 404, { error: "project not found" }); }
    if (method === "DELETE") { const result = await deleteCapability(owner, projectId, body.actionId); return result ? json(res, 200, result) : json(res, 404, { error: "project not found" }); }
    const result = await saveCapability(owner, projectId, body); return result ? json(res, 200, { action: result }) : json(res, 404, { error: "project not found" });
  } catch (error) { if (known(error)) return json(res, 400, { error: error.message, code: error.code }); throw error; }
}

export async function handleKnowledgeBase(req, res, body, owner) {
  try { const result = await saveKnowledgeBase(owner, body?.projectId, body); return result ? json(res, 200, { knowledgeBase: result }) : json(res, 404, { error: "project not found" }); }
  catch (error) { if (known(error)) return json(res, 400, { error: error.message, code: error.code }); throw error; }
}

export async function handleActionSchedule(req, res, body, owner) {
  try { const result = await saveActionSchedule(owner, body?.projectId, body); return result ? json(res, 200, { schedule: result }) : json(res, 404, { error: "project not found" }); }
  catch (error) { if (known(error)) return json(res, 400, { error: error.message, code: error.code }); throw error; }
}

export async function handleRuntimeCredentialDelete(req, res, body, owner) {
  try { const result = await clearRuntimeCredential(owner, body?.projectId, body?.provider); return result ? json(res, 200, result) : json(res, 404, { error: "project not found" }); }
  catch (error) { if (known(error)) return json(res, 400, { error: error.message, code: error.code }); throw error; }
}
