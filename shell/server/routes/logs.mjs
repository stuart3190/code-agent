// Project log routes.
//
//   GET /api/v1/projects/:id/logs           one page, filtered
//   GET /api/v1/projects/:id/logs/stream    SSE — new lines as they arrive
//   GET /api/v1/projects/:id/logs/export    ?format=json|csv
//
// The stream polls the same reader rather than holding a database subscription: logs merge three
// sources, so there is no single table to listen to, and a five-second poll is indistinguishable
// from live for a human reading a log.

import { readLogs, readSince, toCsv, buildRunsFor } from "../lib/logs/logReader.mjs";

const STREAM_TICK_MS = 5_000;

function sendJson(res, code, value) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(value));
}

function filtersFrom(url) {
  const list = (name) => {
    const raw = url?.searchParams?.get(name);
    return raw ? raw.split(",").map((s) => s.trim()).filter(Boolean) : null;
  };
  return {
    sources: list("sources"),
    levels: list("levels"),
    search: url?.searchParams?.get("q") || "",
    since: url?.searchParams?.get("since") || null,
    before: url?.searchParams?.get("before") || null,
    limit: Number(url?.searchParams?.get("limit") || 100),
    // The build/run identifier. Narrows every source to one run, which is what makes a deployment's
    // "View logs" a real link rather than a tab switch that shows everything.
    ref: url?.searchParams?.get("ref") || null,
  };
}

export async function handleLogsList(_req, res, owner, projectId, url) {
  try {
    sendJson(res, 200, await readLogs(owner.id, projectId, filtersFrom(url)));
  } catch (error) {
    console.error(`[logs] ${error?.message || error}`);
    sendJson(res, 500, { error: "Logs are unavailable right now. Please try again." });
  }
}

/**
 * The project's builds, so a log view can be narrowed to one of them.
 *
 * This is the same identity Deployments and Overview use — the diag_runs id — so "View logs" from
 * a deployment and picking a build here land on exactly the same run.
 */
export async function handleLogRuns(_req, res, owner, projectId) {
  try {
    const runs = await buildRunsFor(owner.id, projectId);
    sendJson(res, 200, {
      runs: runs.map((run) => ({
        id: String(run.id),
        status: run.status,
        kind: run.kind,
        startedAt: run.started_at,
        finishedAt: run.finished_at,
        durationMs: run.duration_ms,
      })),
    });
  } catch (error) {
    console.error(`[logs-runs] ${error?.message || error}`);
    sendJson(res, 500, { error: "Builds could not be listed right now. Please try again." });
  }
}

export async function handleLogsExport(_req, res, owner, projectId, url) {
  const format = (url?.searchParams?.get("format") || "json").toLowerCase();
  try {
    // Export takes the whole visible window, not just the page on screen — a download that
    // silently contained only the last 100 lines would be worse than no download.
    const { entries } = await readLogs(owner.id, projectId, { ...filtersFrom(url), limit: 500 });
    const stamp = new Date().toISOString().slice(0, 10);
    if (format === "csv") {
      res.writeHead(200, {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="thrallo-logs-${stamp}.csv"`,
        "Cache-Control": "no-store",
      });
      return res.end(toCsv(entries));
    }
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="thrallo-logs-${stamp}.json"`,
      "Cache-Control": "no-store",
    });
    return res.end(JSON.stringify({ exportedAt: new Date().toISOString(), entries }, null, 2));
  } catch (error) {
    console.error(`[logs-export] ${error?.message || error}`);
    return sendJson(res, 500, { error: "That export could not be prepared." });
  }
}

export async function handleLogsStream(req, res, owner, projectId, url) {
  const filters = filtersFrom(url);
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    // Nginx/Caddy buffering would hold events until the buffer filled, which for a quiet log
    // could be minutes.
    "X-Accel-Buffering": "no",
  });

  let cursor = new Date().toISOString();
  let closed = false;
  const stop = () => { closed = true; clearInterval(timer); clearInterval(ping); };

  const tick = async () => {
    if (closed) return;
    try {
      const { entries } = await readSince(owner.id, projectId, cursor, filters);
      if (entries.length) {
        cursor = entries[entries.length - 1].at;
        for (const entry of entries) {
          res.write(`event: log\ndata: ${JSON.stringify(entry)}\n\n`);
        }
      }
    } catch (error) {
      console.error(`[logs-stream] ${error?.message || error}`);
    }
  };

  const timer = setInterval(tick, STREAM_TICK_MS);
  // A comment keeps proxies and browsers from closing an idle connection; a quiet log is normal.
  const ping = setInterval(() => { if (!closed) res.write(": ping\n\n"); }, 25_000);

  req.on("close", stop);
  req.on("error", stop);
  res.write("event: ready\ndata: {}\n\n");
}
