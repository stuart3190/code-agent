import { connectGithub, disconnectGithub, exportGithub, githubOverview } from "../lib/githubSync.mjs";

const json = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
};

function known(error, res) {
  if (["github_auth", "github_conflict"].includes(error?.code)) { json(res, error.code === "github_auth" ? 401 : 409, { error: error.message, code: error.code }); return true; }
  return false;
}

export async function handleGithubOverview(req, res, url, owner) {
  const projectId = url.searchParams.get("projectId");
  if (!projectId) return json(res, 400, { error: "projectId is required" });
  const result = await githubOverview(owner, projectId);
  return result ? json(res, 200, result) : json(res, 404, { error: "project not found" });
}

export async function handleGithubConnect(req, res, body, owner) {
  if (!body?.projectId) return json(res, 400, { error: "projectId is required" });
  try {
    const result = await connectGithub(owner, body.projectId, body.token);
    return result ? json(res, 200, result) : json(res, 404, { error: "project not found" });
  } catch (error) { if (!known(error, res)) throw error; }
}

export async function handleGithubExport(req, res, body, owner) {
  if (!body?.projectId) return json(res, 400, { error: "projectId is required" });
  try {
    const result = await exportGithub(owner, body.projectId, body);
    return result ? json(res, 200, result) : json(res, 404, { error: "project not found" });
  } catch (error) { if (!known(error, res)) throw error; }
}

export async function handleGithubDisconnect(req, res, body, owner) {
  if (!body?.projectId) return json(res, 400, { error: "projectId is required" });
  const result = await disconnectGithub(owner, body.projectId);
  return result ? json(res, 200, result) : json(res, 404, { error: "project not found" });
}
