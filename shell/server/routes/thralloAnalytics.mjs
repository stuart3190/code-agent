// Thrallo Analytics routes.
//
//   POST /api/analytics/collect                  PUBLIC — the beacon from published sites
//   GET  /api/v1/projects/:id/analytics          owner-scoped overview
//   GET  /api/v1/projects/:id/analytics/live     near-real-time visitors
//   GET  /api/v1/projects/:id/analytics/export   CSV or JSON of the selected range
// Deployment history moved to routes/deployments.mjs, which reads real deployment records rather
// than diagnostic build runs.
//
// This is NOT the retired routes/analytics.mjs, which is the Buildr101 connector reading a table
// Thrallo has never had. Nothing was carried over from it.

import { recordBeacon } from "../lib/analytics/ingest.mjs";
import { overview, liveVisitors } from "../lib/analytics/reports.mjs";
import { buildAnalyticsExport } from "../lib/analytics/export.mjs";

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

/**
 * CSV or JSON of the whole selected range.
 *
 * Errors come back as JSON with a real message rather than a zero-byte file: a download that
 * silently produces an empty spreadsheet is the least debuggable possible failure.
 */
export async function handleAnalyticsExport(_req, res, owner, projectId, url) {
  const format = (url?.searchParams?.get("format") || "json").toLowerCase() === "csv" ? "csv" : "json";
  const days = Number(url?.searchParams?.get("days") || 30);
  try {
    const file = await buildAnalyticsExport(owner.id, projectId, { days, format });
    res.writeHead(200, {
      "Content-Type": file.contentType,
      "Content-Disposition": `attachment; filename="${file.filename.replace(/[^a-zA-Z0-9._-]/g, "-")}"`,
      "Cache-Control": "no-store",
    });
    return res.end(file.body);
  } catch (error) {
    const status = error.status || 500;
    console.error(`[analytics-export] ${error?.message || error}`);
    return sendJson(res, status, {
      error: status === 500 ? "That export could not be prepared. Please try again." : error.message,
      code: error.code || "export_failed",
    });
  }
}

// handleDeploymentHistory lived here and listed diag_runs as though diagnostic build runs were
// deployments. Real deployment records replace it in routes/deployments.mjs; it is deleted rather
// than left unused, because an unused reader of the wrong table is one route change away from
// coming back.
