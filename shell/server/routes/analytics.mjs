import { analyticsOverview } from "../lib/analytics.mjs";

const json = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
};

export async function handleAnalytics(req, res, url, owner) {
  const projectId = url.searchParams.get("projectId");
  if (!projectId) return json(res, 400, { error: "projectId is required" });
  const result = await analyticsOverview(owner, projectId, url.searchParams.get("days"));
  return result ? json(res, 200, result) : json(res, 404, { error: "project not found" });
}
