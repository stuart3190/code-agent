// Build Diagnostics — the permanent audit trail for every build, repair and verification.
// Browse runs, inspect every repair round, expand raw logs, compare iterations, download
// the full bundle, and ask for an explanation grounded in the ACTUAL stored output.

import React, { useEffect, useState } from "react";
import {
  listDiagnostics, getDiagnostics, getDiagnosticsStep, explainDiagnostics,
  diagnosticsPrefs, setDiagnosticsPrefs, diagnosticsRequests, diagnosticsBv2,
} from "../lib/codeAgentApi.js";
import { SkeletonRows, formatCompact } from "./shared.jsx";

const STATUS_TONE = {
  passed: "var(--good)", complete_unverified: "var(--good)", running: "var(--accent)",
  failed: "var(--bad)", interrupted: "var(--warn)",
};
const STATUS_LABEL = {
  passed: "verified", complete_unverified: "complete (preview pending)", running: "running",
  failed: "failed", interrupted: "interrupted",
};

const fmtDuration = (ms) => (ms == null ? "—" : ms >= 60_000 ? `${Math.round(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s` : `${Math.round(ms / 1000)}s`);
const fmtCost = (totals) => (totals?.cost ? `${Number(totals.cost).toFixed(3)} cr` : "—");

export default function DiagnosticsView() {
  const [runs, setRuns] = useState(null);
  const [open, setOpen] = useState(null); // run id
  const [error, setError] = useState("");
  const [prefs, setPrefs] = useState(null);

  useEffect(() => {
    listDiagnostics().then((r) => setRuns(r.runs || [])).catch((e) => { setError(e.message); setRuns([]); });
    diagnosticsPrefs().then(setPrefs).catch(() => {});
  }, []);

  if (open) return <RunDetail runId={open} onBack={() => setOpen(null)} />;

  return (
    <div>
      <h3>Build diagnostics</h3>
      <p className="mg-sub">Every build keeps its complete audit trail — prompts, compiler output, tests, repairs, costs. Nothing is discarded, even when a build fails.</p>
      {error && <div className="mg-error">{error}</div>}

      {prefs && (
        <div className="mg-card">
          <div className="mg-row">
            <div>Keep diagnostics for<div className="ct-hint">Older runs are compressed, then removed automatically.</div></div>
            <select className="mg-select" style={{ width: 140 }}
              value={prefs.retentionDays == null ? "forever" : String(prefs.retentionDays)}
              onChange={(e) => {
                const v = e.target.value === "forever" ? null : Number(e.target.value);
                setDiagnosticsPrefs(v).then(setPrefs).catch((err) => setError(err.message));
              }}>
              <option value="30">30 days</option>
              <option value="90">90 days</option>
              <option value="365">365 days</option>
              <option value="forever">Forever</option>
            </select>
          </div>
        </div>
      )}

      <div className="mg-card">
        {runs === null && <SkeletonRows rows={3} />}
        {runs?.length === 0 && <div className="ct-hint">No builds recorded yet — diagnostics start with your next build.</div>}
        {(runs || []).map((run) => (
          <div className="mg-row" key={run.id}>
            <div style={{ minWidth: 0 }}>
              <span className="mg-mono" title={run.id}>{run.id.slice(0, 8)}</span> {run.prompt || run.kind}
              <div className="ct-hint">
                {new Date(run.started_at).toLocaleString()} · {run.kind} · {fmtDuration(run.duration_ms)} ·
                {" "}{run.repair_rounds || 0} repair round{(run.repair_rounds || 0) === 1 ? "" : "s"} · {fmtCost(run.totals)}
              </div>
            </div>
            <span style={{ display: "flex", gap: 6, alignItems: "center", flexShrink: 0 }}>
              <span className="mg-pill"><span className="dot" style={{ background: STATUS_TONE[run.status] || "var(--ink-3)" }} />{STATUS_LABEL[run.status] || run.status}</span>
              <button className="ct-btn-quiet" onClick={() => setOpen(run.id)}>Inspect</button>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// Builder v2 (WP-12): the pipeline story — build state machine + spend, per-step cost from
// the trace hierarchy, snapshot lineage, and which snapshot each pointer currently serves.
function BuilderV2Panel({ runId }) {
  const [data, setData] = useState(null);
  useEffect(() => {
    diagnosticsBv2(runId).then(setData).catch(() => setData(null));
  }, [runId]);
  if (!data?.v2) return null;
  const pointerFor = (snapId) => (data.pointers || []).filter((p) => p.snapshot_id === snapId).map((p) => p.label);
  return (
    <div className="mg-card">
      <div className="mg-label" style={{ marginTop: 0 }}>Builder v2 pipeline</div>
      {(data.builds || []).slice(0, 3).map((b) => (
        <div key={b.id} style={{ fontSize: 13.5, marginBottom: 4 }}>
          <span className="mg-mono">{b.id.slice(0, 8)}</span> · {b.profile} · <b>{b.state}</b>
          {b.final_snapshot ? <> · snapshot <span className="mg-mono">{b.final_snapshot.slice(0, 8)}</span></> : null}
          {b.error ? <span style={{ color: "var(--bad)" }}> · {String(b.error).slice(0, 90)}</span> : null}
        </div>
      ))}
      {(data.steps || []).length > 0 && (
        <>
          <div className="mg-label">Spend by pipeline step</div>
          {(data.steps || []).map((s) => (
            <div key={s.step} style={{ fontSize: 13, display: "flex", gap: 10 }}>
              <span className="mg-mono" style={{ minWidth: 110 }}>{s.step}</span>
              <span>{s.calls} call{s.calls === 1 ? "" : "s"}</span>
              <span>{formatCompact(s.inputTokens)} in ({formatCompact(s.cachedTokens)} cached)</span>
              <span>{formatCompact(s.outputTokens)} out</span>
              <span><b>{s.cost.toFixed(2)} cr</b></span>
            </div>
          ))}
        </>
      )}
      {(data.snapshots || []).length > 0 && (
        <>
          <div className="mg-label">Snapshots</div>
          {(data.snapshots || []).map((s) => (
            <div key={s.id} style={{ fontSize: 13 }}>
              <span className="mg-mono">{s.id.slice(0, 8)}</span> · {s.reason} · {s.state} · {s.file_count} files
              {pointerFor(s.id).map((l) => <b key={l} style={{ color: "var(--good)" }}> ← {l}</b>)}
            </div>
          ))}
        </>
      )}
    </div>
  );
}

function RunDetail({ runId, onBack }) {
  const [run, setRun] = useState(null);
  const [error, setError] = useState("");
  const [explaining, setExplaining] = useState(false);
  const [explanation, setExplanation] = useState(null);
  const [compare, setCompare] = useState([]); // selected rounds for comparison

  useEffect(() => {
    getDiagnostics(runId).then((r) => setRun(r.run)).catch((e) => setError(e.message));
  }, [runId]);

  const explain = () => {
    setExplaining(true); setExplanation(null);
    explainDiagnostics(runId)
      .then((r) => setExplanation(r.explanation))
      .catch((e) => setExplanation(`Explanation unavailable: ${e.message}`))
      .finally(() => setExplaining(false));
  };

  const rounds = run ? [...new Set(run.steps.map((s) => s.round))].sort((a, b) => a - b) : [];
  const toggleCompare = (round) => setCompare((c) =>
    c.includes(round) ? c.filter((r) => r !== round) : [...c.slice(-1), round]);

  return (
    <div>
      <button className="ct-btn-quiet" onClick={onBack}>← All builds</button>
      {error && <div className="mg-error">{error}</div>}
      {!run && !error && <div className="mg-card" style={{ marginTop: 10 }}><SkeletonRows rows={4} /></div>}
      {run && (
        <>
          <h3 style={{ marginTop: 10 }}>Build <span className="mg-mono">{run.id.slice(0, 8)}</span></h3>
          <p className="mg-sub">
            {STATUS_LABEL[run.status] || run.status} · {run.kind} · {fmtDuration(run.duration_ms)} ·
            {" "}{run.repair_rounds || 0} repair round{(run.repair_rounds || 0) === 1 ? "" : "s"} ·
            {" "}{run.model || "model n/a"} · {formatCompact(run.totals?.totalTokens || 0)} tokens · {fmtCost(run.totals)}
          </p>

          <div className="mg-card">
            <div className="mg-label" style={{ marginTop: 0 }}>Original request</div>
            <div style={{ whiteSpace: "pre-wrap", fontSize: 14 }}>{run.prompt || "—"}</div>
            {run.plan && (
              <>
                <div className="mg-label">Build plan</div>
                <pre className="mg-mono" style={{ whiteSpace: "pre-wrap", margin: 0, padding: "8px 10px" }}>{run.plan}</pre>
              </>
            )}
            {run.contract && <ContractSummary contract={run.contract} />}
            <div className="ct-actions">
              <a className="ct-btn-quiet" style={{ textDecoration: "none", border: "1px solid var(--line)" }}
                href={`/api/v1/diagnostics/${run.id}/download`} download>Download diagnostics</a>
              {["failed", "interrupted"].includes(run.status) && (
                <button className="ct-btn" onClick={explain} disabled={explaining}>
                  {explaining ? "Reading the logs…" : "Explain this failure"}
                </button>
              )}
            </div>
            {explanation && (
              <div className="mg-card" style={{ marginTop: 10 }}>
                <div className="mg-label" style={{ marginTop: 0 }}>Explanation (from the stored logs)</div>
                <div style={{ whiteSpace: "pre-wrap", fontSize: 13.5 }}>{explanation}</div>
              </div>
            )}
          </div>

          {/^app_(build|edit)_v2$/.test(run.kind || "") && <BuilderV2Panel runId={run.id} />}
          <ContextInspector runId={run.id} />

          {rounds.length > 1 && (
            <div className="mg-card">
              <div className="mg-row" style={{ borderBottom: 0 }}>
                <div>Compare repair rounds<div className="ct-hint">Pick two rounds to see their steps side by side.</div></div>
                <span style={{ display: "flex", gap: 6 }}>
                  {rounds.map((round) => (
                    <button key={round} className={`ct-btn-quiet ${compare.includes(round) ? "on" : ""}`}
                      style={compare.includes(round) ? { background: "var(--accent-soft)", color: "var(--accent)" } : { border: "1px solid var(--line)" }}
                      onClick={() => toggleCompare(round)} aria-pressed={compare.includes(round)}>
                      Round {round}
                    </button>
                  ))}
                </span>
              </div>
            </div>
          )}

          {compare.length === 2 ? (
            <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))" }}>
              {compare.sort((a, b) => a - b).map((round) => (
                <div key={round}>
                  <div className="mg-label">Round {round}</div>
                  {run.steps.filter((s) => s.round === round).map((step) => (
                    <StepCard key={step.seq} runId={run.id} step={step} />
                  ))}
                </div>
              ))}
            </div>
          ) : (
            rounds.map((round) => (
              <div key={round}>
                <div className="mg-label">{rounds.length > 1 ? `Round ${round}` : "Steps"}</div>
                {run.steps.filter((s) => s.round === round).map((step) => (
                  <StepCard key={step.seq} runId={run.id} step={step} />
                ))}
              </div>
            ))
          )}
        </>
      )}
    </div>
  );
}

// Context Inspector: exactly what each AI request carried — trigger, token classes,
// task budget, and every seeded file with the reason it was included.
/**
 * The implementation contract, as what it is: the list of things this build was judged against.
 *
 * Shown as outcomes rather than as JSON, because the point of the contract is that a person can
 * read "the booking is still shown after the reload" and know whether the build honoured it. The
 * raw object is still in the downloadable diagnostics for anyone who wants it.
 */
function ContractSummary({ contract }) {
  const [open, setOpen] = useState(false);
  const journeys = contract.journeys || [];
  const primary = journeys.find((j) => j.priority === "primary") || journeys[0];

  return (
    <>
      <div className="mg-label">
        What this build was judged against
        <button className="ct-btn-quiet" style={{ marginLeft: 8, fontSize: 12 }}
          aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {open ? "Show less" : "Show all"}
        </button>
      </div>
      <div style={{ fontSize: 14, display: "grid", gap: 10 }}>
        {primary && (
          <div>
            <strong>Primary journey — {primary.title}</strong>
            <ol style={{ margin: "4px 0 0", paddingLeft: 20 }}>
              {(primary.steps || []).map((step, i) => (
                <li key={i} style={{ marginBottom: 2 }}>
                  {step.action} → <span style={{ opacity: 0.85 }}>{step.expect}</span>
                </li>
              ))}
            </ol>
          </div>
        )}
        {open && (
          <>
            {journeys.filter((j) => j !== primary).map((journey) => (
              <div key={journey.id}>
                <strong>{journey.title}</strong>
                <ul style={{ margin: "4px 0 0", paddingLeft: 20 }}>
                  {(journey.steps || []).map((step, i) => <li key={i}>{step.expect}</li>)}
                </ul>
              </div>
            ))}
            {!!(contract.entities || []).length && (
              <div>
                <strong>Persisted data</strong>
                <ul style={{ margin: "4px 0 0", paddingLeft: 20 }}>
                  {contract.entities.map((entity) => (
                    <li key={entity.name}>
                      {entity.name}{entity.owned ? " (per signed-in user)" : ""} —{" "}
                      {(entity.fields || []).map((f) => f.name).join(", ")}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {!!(contract.acceptance || []).length && (
              <div>
                <strong>Acceptance tests</strong>
                <ul style={{ margin: "4px 0 0", paddingLeft: 20 }}>
                  {contract.acceptance.map((test) => <li key={test.id}>{test.statement}</li>)}
                </ul>
              </div>
            )}
            {/* Deferred work is stated so an absent feature reads as a decision rather than a gap. */}
            {!!(contract.deferred || []).length && (
              <div>
                <strong>Deliberately not built</strong>
                <ul style={{ margin: "4px 0 0", paddingLeft: 20 }}>
                  {contract.deferred.map((item, i) => (
                    <li key={i}>{item.item}{item.reason ? ` — ${item.reason}` : ""}</li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}

function ContextInspector({ runId }) {
  const [open, setOpen] = useState(false);
  const [requests, setRequests] = useState(null);
  const toggle = () => {
    setOpen((v) => !v);
    if (!requests) diagnosticsRequests(runId).then((r) => setRequests(r.requests)).catch(() => setRequests([]));
  };
  return (
    <div className="mg-card">
      <button className="mg-row" style={{ width: "100%", textAlign: "left", borderBottom: 0 }} onClick={toggle} aria-expanded={open}>
        <div>Context Inspector<div className="ct-hint">What was actually sent to the model on every request</div></div>
        <span className="ct-hint">{open ? "Hide" : "Show"}</span>
      </button>
      {open && requests && !requests.length && (
        <div className="ct-hint">No per-request context records — this build predates context diagnostics.</div>
      )}
      {open && (requests || []).map((r, i) => (
        <div className="mg-card" key={i} style={{ marginTop: 8 }}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "baseline", fontSize: 13 }}>
            <strong>{r.agent || "Agent"}</strong>
            <span className="ct-hint">{r.provider} / {r.model}</span>
            {r.trigger && <span className="mg-pill">{r.trigger}</span>}
            {r.context?.taskType && <span className="mg-pill"><span className="dot" style={{ background: "var(--accent)" }} />{r.context.taskType}</span>}
            <span className="ct-hint" style={{ marginLeft: "auto" }}>
              in {r.inputTokens} · cached {r.cachedTokens} · out {r.outputTokens}{r.cost != null ? ` · ${Number(r.cost).toFixed(4)} cr` : ""}
            </span>
          </div>
          {r.context && (
            <div className="ct-hint" style={{ marginTop: 6 }}>
              Budget {r.context.budgetTokens} tok · estimated context {r.context.estContextTokens} tok
              (system {r.context.systemTokens} · prompt {r.context.promptTokens})
              {r.context.contextSelection ? " · seeded context selection" : " · scaffold build"}
            </div>
          )}
          {r.context?.files?.length > 0 && (
            <div style={{ marginTop: 6 }}>
              {r.context.files.map((f) => (
                <div key={f.path} className="ct-hint"><span className="mg-mono">{f.path}</span> — {f.reason}</div>
              ))}
            </div>
          )}
          {r.context?.warnings?.length > 0 && r.context.warnings.map((w, j) => (
            <div key={j} className="mg-error" style={{ margin: "6px 0 0" }}>{w}</div>
          ))}
        </div>
      ))}
    </div>
  );
}

function StepCard({ runId, step }) {
  const [openLog, setOpenLog] = useState(false);
  const [full, setFull] = useState(null);
  const failed = step.status === "failed";
  const expand = () => {
    setOpenLog((v) => !v);
    if (!full && step.truncated) {
      getDiagnosticsStep(runId, step.seq).then((r) => setFull(r.step.output)).catch(() => {});
    }
  };
  const output = full ?? step.output;
  return (
    <div className="mg-card" style={failed ? { borderColor: "rgba(214, 69, 69, 0.4)" } : undefined}>
      <div className="mg-row" style={{ borderBottom: 0, padding: "2px 0" }}>
        <div style={{ minWidth: 0 }}>
          <span className="mg-pill" style={{ marginRight: 8 }}>
            <span className="dot" style={{ background: failed ? "var(--bad)" : "var(--good)" }} />
            {step.kind}
          </span>
          {step.agent ? `${step.agent} · ` : ""}{step.label}
          <div className="ct-hint">
            #{step.seq}{step.durationMs != null ? ` · ${fmtDuration(step.durationMs)}` : ""}
            {step.usage ? ` · ${formatCompact(step.usage.total || (step.usage.inputTokens || 0) + (step.usage.outputTokens || 0))} tokens` : ""}
            {step.cost != null ? ` · ${Number(step.cost).toFixed(4)} cr` : ""}
          </div>
        </div>
        {(output || step.prompt) && (
          <button className="ct-btn-quiet" onClick={expand} aria-expanded={openLog}>{openLog ? "Collapse" : "Expand"}</button>
        )}
      </div>
      {openLog && (
        <>
          {step.prompt && (
            <>
              <div className="mg-label">Prompt</div>
              <pre className="mg-mono" style={{ whiteSpace: "pre-wrap", maxHeight: "30vh", overflow: "auto", margin: 0, padding: "8px 10px" }}>{step.prompt}</pre>
            </>
          )}
          {output && (
            <>
              <div className="mg-label">Raw output</div>
              <pre className="mg-mono" style={{ whiteSpace: "pre-wrap", maxHeight: "44vh", overflow: "auto", margin: 0, padding: "8px 10px" }}>
                {output}{step.truncated && !full ? "\n… loading the full log …" : ""}
              </pre>
            </>
          )}
        </>
      )}
    </div>
  );
}

