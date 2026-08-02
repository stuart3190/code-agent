// GET /api/v1/publish-state — which of the caller's projects are live, and whether what is live
// is current. Owner-scoped inside publishStates(); this route never takes an owner from the request.

import { publishStates } from "../lib/publishState.mjs";

export async function handlePublishState(_req, res, owner) {
  try {
    const sites = await publishStates(owner.id);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ sites }));
  } catch (error) {
    // Publish state is decoration on top of the real work. Failing it must never take down the
    // dashboard, so the caller gets an empty list and the detail stays in the server log.
    console.error(`[publish-state] ${error?.message || error}`);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ sites: [], unavailable: true }));
  }
}
