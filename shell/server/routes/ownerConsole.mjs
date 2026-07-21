import { deleteAppRecord, ownerConsoleOverview, setAppUserStatus } from "../lib/ownerConsole.mjs";

const json = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
};

export async function handleOwnerConsole(req, res, url, owner) {
  const projectId = url.searchParams.get("projectId");
  if (!projectId) return json(res, 400, { error: "projectId is required" });
  const result = await ownerConsoleOverview(owner, projectId);
  return result ? json(res, 200, result) : json(res, 404, { error: "project not found" });
}

export async function handleConsoleUser(req, res, body, owner) {
  if (!body?.projectId || !body?.userId) return json(res, 400, { error: "projectId and userId are required" });
  try {
    const result = await setAppUserStatus(owner, body.projectId, body.userId, body.status);
    return result == null ? json(res, 404, { error: "project not found" })
      : result === false ? json(res, 404, { error: "app user not found" }) : json(res, 200, { user: result });
  } catch (error) {
    if (error.code === "bad_status") return json(res, 400, { error: error.message, code: error.code });
    throw error;
  }
}

export async function handleConsoleRecordDelete(req, res, body, owner) {
  if (!body?.projectId || !body?.recordId) return json(res, 400, { error: "projectId and recordId are required" });
  const result = await deleteAppRecord(owner, body.projectId, body.recordId);
  return result == null ? json(res, 404, { error: "project not found" })
    : result === false ? json(res, 404, { error: "record not found" }) : json(res, 200, { ok: true });
}
