// Build-job observation routes — the client's window onto detached background builds.
//
//   GET  /api/builds/:jobId/events        SSE: snapshot frame, then live coarse events
//   GET  /api/projects/:id/active-build   running (else most recent) job for a project — reattach
//   POST /api/builds/:jobId/cancel        flag the job; the runner aborts between engine turns
//
// Every route is owner-checked inside buildJobs (getJob/activeBuildFor/cancelJob take the
// verified owner id) — user B gets a 404 on user A's jobs, never a stream. Frames carry ONLY
// the coarse vocabulary + whitelisted result (see buildJobs.publicJob); the browser subscribes
// with a streaming fetch (EventSource can't send the Authorization header — same reason as the
// old generate stream).

import { getJob, activeBuildFor, cancelJob, subscribe, publicJob, isTerminal } from "../lib/buildJobs.mjs";

function sendJson(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

function sse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

export async function handleBuildEvents(req, res, jobId, owner) {
  const job = await getJob(owner.id, jobId);
  if (!job) return sendJson(res, 404, { error: "build not found" });

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  // The snapshot IS the replay: phases are monotonic, so current state supersedes anything a
  // late subscriber missed. Terminal jobs get their whole story (incl. result) in this one frame.
  sse(res, "snapshot", publicJob(job));
  if (isTerminal(job)) return res.end();

  const unsub = subscribe(job, (name, data) => {
    try {
      sse(res, name, data);
      if (name === "end") res.end();
    } catch { unsub(); }
  });
  // Close the finish-while-subscribing race: if the job went terminal between the snapshot and
  // the subscribe, deliver the ending ourselves (the emit already happened without us).
  if (isTerminal(job)) {
    unsub();
    sse(res, "end", publicJob(job));
    return res.end();
  }
  // Keep proxies (Caddy) from idling the stream out between rare phase changes.
  const ping = setInterval(() => { try { res.write(":ping\n\n"); } catch { /* close handler cleans up */ } }, 15000);
  // The subscriber dying must never touch the job — detach and move on (this exact missing
  // handler is what used to kill builds with the browser).
  res.on("close", () => { clearInterval(ping); unsub(); });
}

export async function handleActiveBuild(req, res, projectId, owner) {
  const job = await activeBuildFor(owner.id, projectId);
  return sendJson(res, 200, { job: job ? publicJob(job) : null });
}

export async function handleBuildCancel(req, res, jobId, owner) {
  const out = await cancelJob(owner.id, jobId);
  if (!out.ok) return sendJson(res, 404, { error: out.error });
  return sendJson(res, 200, { ok: true });
}
