// Build Diagnostics API — owner-scoped access to the permanent audit trail: list runs,
// inspect steps, fetch full raw logs, download the complete bundle, evidence-grounded
// failure explanations, and retention prefs.

import {
  listDiagRuns, getDiagRun, getDiagStepOutput, explainBuildFailure,
  getDiagPrefs, setDiagPrefs,
} from "../lib/appBuild/buildDiagnostics.mjs";

const json = (res, code, body) => {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

export async function handleDiagnosticsList(req, res, { owner, url }) {
  const runs = await listDiagRuns(owner.id, { projectId: url.searchParams.get("project") || null });
  return json(res, 200, { runs });
}

export async function handleDiagnosticsRun(req, res, { owner, runId }) {
  const run = await getDiagRun(owner.id, runId);
  if (!run) return json(res, 404, { error: "No diagnostics found for that Build ID." });
  return json(res, 200, { run });
}

export async function handleDiagnosticsStep(req, res, { owner, runId, seq }) {
  const step = await getDiagStepOutput(owner.id, runId, Number(seq));
  if (!step) return json(res, 404, { error: "No such diagnostics step." });
  return json(res, 200, { step });
}

export async function handleDiagnosticsDownload(req, res, { owner, runId }) {
  const run = await getDiagRun(owner.id, runId, { full: true });
  if (!run) return json(res, 404, { error: "No diagnostics found for that Build ID." });
  const body = JSON.stringify(run, null, 2);
  res.writeHead(200, {
    "Content-Type": "application/json",
    "Content-Disposition": `attachment; filename="thrallo-diagnostics-${runId.slice(0, 8)}.json"`,
    "Content-Length": Buffer.byteLength(body),
  });
  return res.end(body);
}

export async function handleDiagnosticsExplain(req, res, { owner, runId }) {
  const result = await explainBuildFailure(owner.id, runId);
  return json(res, result.found ? 200 : 404, result);
}

export async function handleDiagnosticsPrefs(req, res, { owner, method, body }) {
  if (method === "POST") {
    const retentionDays = body?.retentionDays === null || body?.retentionDays === undefined
      ? null
      : Number(body.retentionDays);
    try {
      return json(res, 200, await setDiagPrefs(owner.id, Number.isNaN(retentionDays) ? undefined : retentionDays));
    } catch (error) {
      return json(res, error.status || 500, { error: error.message });
    }
  }
  return json(res, 200, await getDiagPrefs(owner.id));
}
