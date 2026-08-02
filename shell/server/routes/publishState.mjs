// Publish lifecycle routes.
//
//   GET  /api/v1/publish-state              — which of the caller's projects are live
//   POST /api/v1/projects/:projectId/unpublish — take one offline
//
// Both are owner-scoped inside the library; neither takes an owner from the request.

import { publishStates } from "../lib/publishState.mjs";
import { unpublishApp } from "../lib/appBuild/appPublishService.mjs";

function sendJson(res, code, value) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(value));
}

export async function handlePublishState(_req, res, owner) {
  try {
    sendJson(res, 200, { sites: await publishStates(owner.id) });
  } catch (error) {
    // Publish state is decoration on top of the real work. Failing it must never take down the
    // dashboard, so the caller gets an empty list and the detail stays in the server log.
    console.error(`[publish-state] ${error?.message || error}`);
    sendJson(res, 200, { sites: [], unavailable: true });
  }
}

export async function handleProjectUnpublish(_req, res, owner, projectId) {
  try {
    const result = await unpublishApp(owner.id, projectId);
    // The full state goes back with it so the dashboard can settle without a second round trip.
    sendJson(res, 200, {
      ...result,
      message: "Your site has been unpublished.",
      sites: await publishStates(owner.id),
    });
  } catch (error) {
    const status = error.code === "not_published" ? 404 : error.code === "not_configured" ? 501 : 500;
    console.error(`[unpublish] ${error?.message || error}`);
    sendJson(res, status, {
      error: status === 500 ? "The site could not be taken offline. Please try again." : error.message,
      code: error.code || "unpublish_failed",
    });
  }
}
