// Health monitoring routes.
//
//   GET /api/v1/projects/:id/health   detail for the health page
//
// The badge on each dashboard card does NOT come from here — it travels with the conversation
// rows, so the dashboard renders in one request rather than one per project.

import { healthDetail } from "../lib/health/report.mjs";

export async function handleProjectHealth(_req, res, owner, projectId) {
  try {
    const detail = await healthDetail(owner.id, projectId);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(detail));
  } catch (error) {
    console.error(`[health] ${error?.message || error}`);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Health information is unavailable right now." }));
  }
}
