import { deployTestEnvironment, environmentOverview, promoteTestRelease, rollbackLiveRelease } from "../lib/environments.mjs";

const json = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
};

export async function handleEnvironmentOverview(req, res, url, owner) {
  const projectId = url.searchParams.get("projectId");
  if (!projectId) return json(res, 400, { error: "projectId is required" });
  const result = await environmentOverview(owner, projectId);
  return result ? json(res, 200, result) : json(res, 404, { error: "project not found" });
}

export async function handleTestDeploy(req, res, body, owner) {
  if (!body?.projectId) return json(res, 400, { error: "projectId is required" });
  try {
    const result = await deployTestEnvironment(owner, body.projectId);
    return result ? json(res, 200, result) : json(res, 404, { error: "project not found" });
  } catch (error) {
    if (error.code === "no_app") return json(res, 409, { error: error.message, code: error.code });
    throw error;
  }
}

export async function handleReleaseAction(req, res, body, owner) {
  if (!body?.projectId || !body?.releaseId) return json(res, 400, { error: "projectId and releaseId are required" });
  const action = body.action;
  const result = action === "promote" ? await promoteTestRelease(owner, body.projectId, body.releaseId)
    : action === "rollback" ? await rollbackLiveRelease(owner, body.projectId, body.releaseId)
      : undefined;
  if (result === undefined) return json(res, 400, { error: "action must be promote or rollback" });
  return result == null ? json(res, 404, { error: "project not found" })
    : result === false ? json(res, 404, { error: "release not found" }) : json(res, 200, result);
}
