// Build Diagnostics API — owner-scoped access to the permanent audit trail: list runs,
// inspect steps, fetch full raw logs, download the complete bundle, evidence-grounded
// failure explanations, and retention prefs.

import {
  listDiagRuns, getDiagRun, getDiagStepOutput, explainBuildFailure,
  getDiagPrefs, setDiagPrefs,
} from "../lib/appBuild/buildDiagnostics.mjs";
import { serviceClient } from "../lib/supabase.mjs";

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

// Context Inspector: exactly what was sent for each AI request of a build — trigger,
// token classes, seeded files with the reason each was included, budget, and cost.
export async function handleDiagnosticsRequests(req, res, { owner, runId, client = null }) {
  const db = client || serviceClient();
  const { data: run } = await db.from("diag_runs").select("id").eq("id", runId).eq("owner", owner.id).maybeSingle();
  if (!run) return json(res, 404, { error: "No diagnostics found for that Build ID." });
  const { data } = await db.from("ai_requests").select("*")
    .eq("build_id", runId).eq("owner", owner.id).order("created_at");
  return json(res, 200, {
    requests: (data || []).map((r) => ({
      provider: r.provider, model: r.model, agent: r.agent,
      trigger: r.trigger, runId: r.run_id,
      inputTokens: Number(r.input_tokens || 0), outputTokens: Number(r.output_tokens || 0),
      cachedTokens: Number(r.cached_tokens || 0), reasoningTokens: Number(r.reasoning_tokens || 0),
      durationMs: r.duration_ms, cost: r.cost == null ? null : Number(r.cost),
      context: r.context || null, createdAt: r.created_at,
    })),
  });
}

// Builder v2 view (WP-12): the pipeline story behind an app_build_v2/app_edit_v2 run —
// the bv2 build rows for the project (state machine + spend + snapshot), the snapshot
// lineage, the green pointer, and per-STEP spend from the trace columns.
export async function handleDiagnosticsBv2(req, res, { owner, runId, client = null }) {
  const db = client || serviceClient();
  const { data: run } = await db.from("diag_runs").select("id, project_id, kind")
    .eq("id", runId).eq("owner", owner.id).maybeSingle();
  if (!run) return json(res, 404, { error: "No diagnostics found for that Build ID." });
  if (!/^app_(build|edit)_v2$/.test(run.kind || "")) return json(res, 200, { v2: false });

  const [{ data: builds }, { data: snapshots }, { data: pointers }, { data: requests }] = await Promise.all([
    db.from("bv2_builds").select("id, profile, request, state, spent_credits, final_snapshot, error, started_at, finished_at")
      .eq("owner", owner.id).eq("project_id", run.project_id).order("started_at", { ascending: false }).limit(10),
    db.from("bv2_snapshots").select("id, reason, state, file_count, parent_snapshot, created_at")
      .eq("owner", owner.id).eq("project_id", run.project_id).order("created_at", { ascending: false }).limit(10),
    db.from("bv2_project_pointers").select("label, snapshot_id")
      .eq("owner", owner.id).eq("project_id", run.project_id),
    db.from("ai_requests").select("step, input_tokens, output_tokens, cached_tokens, cost")
      .eq("build_id", runId).eq("owner", owner.id),
  ]);

  const bySteps = {};
  for (const r of requests || []) {
    const key = r.step || "(untraced)";
    const s = bySteps[key] || (bySteps[key] = { step: key, calls: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, cost: 0 });
    s.calls += 1;
    s.inputTokens += Number(r.input_tokens || 0);
    s.outputTokens += Number(r.output_tokens || 0);
    s.cachedTokens += Number(r.cached_tokens || 0);
    s.cost += Number(r.cost || 0);
  }
  return json(res, 200, {
    v2: true,
    builds: builds || [],
    snapshots: snapshots || [],
    pointers: pointers || [],
    steps: Object.values(bySteps).sort((a, b) => b.cost - a.cost),
  });
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
