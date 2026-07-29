import { deleteProjectSecret, listProjectSecrets, setProjectSecret } from "../lib/projectSecrets.mjs";
import { auditEvent, listProjectEnvironments, listReleases } from "../lib/projectState.mjs";

const json = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
};

export async function handleProjectSecrets(req, res, { method, url, body, owner }) {
  const projectId = method === "GET" ? url.searchParams.get("projectId") : body?.projectId;
  const environment = (method === "GET" ? url.searchParams.get("environment") : body?.environment) || "test";
  if (!projectId) return json(res, 400, { error: "projectId is required" });

  let result;
  if (method === "GET") result = await listProjectSecrets(owner.id, projectId, environment);
  else if (method === "POST") result = await setProjectSecret(owner.id, projectId, environment, body?.name, body?.value);
  else if (method === "DELETE") result = await deleteProjectSecret(owner.id, projectId, environment, body?.name);
  else return json(res, 405, { error: "method not allowed" });

  if (result == null) return json(res, 404, { error: "project not found" });
  if (method !== "GET") {
    await auditEvent({
      owner: owner.id, projectId, action: method === "POST" ? "project.secret.saved" : "project.secret.deleted",
      target: body?.name, metadata: { environment },
    });
  }
  return json(res, 200, method === "GET" ? { secrets: result } : result);
}

export async function handleProjectReleases(req, res, url, owner) {
  const projectId = url.searchParams.get("projectId");
  if (!projectId) return json(res, 400, { error: "projectId is required" });
  const releases = await listReleases(owner.id, projectId, url.searchParams.get("limit"));
  return releases == null ? json(res, 404, { error: "project not found" }) : json(res, 200, { releases });
}

export async function handleProjectEnvironments(req, res, url, owner) {
  const projectId = url.searchParams.get("projectId");
  if (!projectId) return json(res, 400, { error: "projectId is required" });
  const environments = await listProjectEnvironments(owner.id, projectId);
  return environments == null ? json(res, 404, { error: "project not found" }) : json(res, 200, { environments });
}
