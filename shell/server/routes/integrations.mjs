import { integrationOverview, saveIntegration } from "../lib/appIntegrations.mjs";

const json = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
};

export async function handleIntegrationOverview(req, res, url, owner) {
  const projectId = url.searchParams.get("projectId");
  if (!projectId) return json(res, 400, { error: "projectId is required" });
  const result = await integrationOverview(owner, projectId);
  return result ? json(res, 200, result) : json(res, 404, { error: "project not found" });
}

export async function handleIntegrationSave(req, res, body, owner) {
  if (!body?.projectId) return json(res, 400, { error: "projectId is required" });
  try {
    const result = await saveIntegration(owner, body.projectId, body);
    return result ? json(res, 200, result) : json(res, 404, { error: "project not found" });
  } catch (error) {
    if (error.code === "bad_integration") return json(res, 400, { error: error.message, code: error.code });
    throw error;
  }
}
