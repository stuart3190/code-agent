// Thrallo Analytics routes.
//
//   POST /api/analytics/collect                  PUBLIC — the beacon from published sites
//   GET  /api/v1/projects/:id/analytics          owner-scoped overview
//   GET  /api/v1/projects/:id/analytics/live     near-real-time visitors
//   GET  /api/v1/projects/:id/deployments        build + deployment history
//
// This is NOT the retired routes/analytics.mjs, which is the Buildr101 connector reading a table
// Thrallo has never had. Nothing was carried over from it.

import { recordBeacon } from "../lib/analytics/ingest.mjs";
import { overview, liveVisitors, deployments } from "../lib/analytics/reports.mjs";

function sendJson(res, code, value) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(value));
}

/**
 * The beacon endpoint. Called by every visitor to every published site, so it is unauthenticated
 * by necessity — the project is resolved from the app id server-side, never trusted from the body.
 *
 * It always answers 204, whatever happened. A visitor's browser must never see an error caused by
 * analytics, and telling a caller whether an app id exists would be a way to enumerate them.
 */
export async function handleAnalyticsCollect(req, res, rawBody, clientIp) {
  // Sent as text/plain to stay CORS-safelisted, so the content type header says nothing useful.
  let body = {};
  try { body = JSON.parse(String(rawBody || "{}")); } catch { body = {}; }
  try {
    await recordBeacon({ body, ip: clientIp, userAgent: req.headers["user-agent"] || "" });
  } catch (error) {
    console.error(`[analytics-collect] ${error?.message || error}`);
  }
  res.writeHead(204, {
    // Published sites live on their own hostnames and on custom domains, so the beacon is always
    // cross-origin. No credentials are involved and the body carries nothing private.
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
  });
  res.end();
}

export function handleAnalyticsPreflight(_req, res) {
  res.writeHead(204, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  });
  res.end();
}

async function wrap(res, run) {
  try {
    sendJson(res, 200, await run());
  } catch (error) {
    console.error(`[analytics] ${error?.message || error}`);
    sendJson(res, 500, { error: "Analytics is unavailable right now. Please try again." });
  }
}

export async function handleAnalyticsOverview(_req, res, owner, projectId, url) {
  const days = Number(url?.searchParams?.get("days") || 30);
  return wrap(res, () => overview(owner.id, projectId, { days }));
}

export async function handleAnalyticsLive(_req, res, owner, projectId) {
  return wrap(res, () => liveVisitors(owner.id, projectId));
}

export async function handleDeploymentHistory(_req, res, owner, projectId) {
  return wrap(res, () => deployments(owner.id, projectId));
}
