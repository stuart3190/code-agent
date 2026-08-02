// Usage & plan — a clean dashboard by default (plan, meters with warnings, builds, AI
// cost, recent activity) with an expandable Advanced Usage section for per-request and
// per-record detail. All data is owner-scoped server-side; nothing here filters.

import React, { useCallback, useEffect, useState } from "react";
import {
  usageSummary, billingOverview, selectPlan, billingPortal, updateBudgets,
  usageInsights, buildCostSummary,
} from "../lib/codeAgentApi.js";
import { Metric, SkeletonRows, formatNumber, formatCompact } from "./shared.jsx";
import { meterWarning } from "./usageWarnings.js";

const fmtDuration = (ms) => (ms == null ? "—" : ms >= 60_000 ? `${Math.round(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s` : `${Math.round(ms / 1000)}s`);
const fmtCr = (v) => `${Number(v || 0).toFixed(2)} cr`;

function Meter({ label, used, limit, format }) {
  const ratio = limit ? Math.min(used / limit, 1) : 0;
  const warning = meterWarning(used, limit);
  const tone = warning?.level >= 100 ? "var(--bad)" : warning ? "var(--warn)" : null;
  return (
    <div style={{ flex: 1, minWidth: 170 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
        <span className="ct-hint">{label}</span>
        <span className="ct-hint">{format(used)} / {format(limit)}</span>
      </div>
      <div className="mg-meter">
        <i style={{ width: `${Math.max(ratio * 100, used ? 2 : 0)}%`, ...(tone ? { background: tone } : {}) }} />
      </div>
      {warning && <div className="ct-hint" style={{ color: warning.tone, fontWeight: 600 }}>{warning.text}</div>}
    </div>
  );
}

export default function UsageView() {
  const [data, setData] = useState(null);
  const [billing, setBilling] = useState(null);
  const [insights, setInsights] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busyPlan, setBusyPlan] = useState("");
  const [advanced, setAdvanced] = useState(false);

  const refreshBilling = useCallback(() => {
    billingOverview().then(setBilling).catch((err) => setError(err.message));
  }, []);
  useEffect(() => {
    usageSummary().then(setData).catch((err) => setError(err.message));
    usageInsights().then(setInsights).catch(() => setInsights({ unavailable: true }));
    refreshBilling();
  }, [refreshBilling]);

  async function choosePlan(planId) {
    setBusyPlan(planId); setError(""); setNotice("");
    try {
      const result = await selectPlan(planId);
      if (result.url) { window.location.href = result.url; return; }
      setBilling(result);
      // A plan change carries its own precise wording — an upgrade took effect now, a downgrade
      // takes effect on a stated date. Saying "you are on Starter" for a scheduled downgrade would
      // be untrue for the rest of the period they have already paid for.
      setNotice(result.planChange?.message
        || `You are on the ${planId === "free" ? "Free" : planId} plan.`);
    } catch (err) { setError(err.message); } finally { setBusyPlan(""); }
  }

  const budgets = billing?.budgets;
  const anyCritical = budgets && ["runs", "managedTokens", "computeSeconds"]
    .some((k) => meterWarning(budgets[k]?.used || 0, budgets[k]?.limit || 0)?.level >= 90);

  return (
    <div>
      <h3>Usage &amp; plan</h3>
      <p className="mg-sub">Ask “how much budget is left?” any time — this is the full picture, and it only ever shows your own account.</p>
      {error && <div className="mg-error">{error}</div>}
      {notice && <div className="mg-ok">{notice}</div>}
      {anyCritical && (
        <div className="mg-card" style={{ borderColor: "rgba(199,126,26,0.5)" }}>
          <div style={{ fontWeight: 700, fontSize: 14 }}>You're close to a plan limit</div>
          <div className="ct-hint">Upgrade below or tighten spend guards — the meters show exactly where you stand.</div>
        </div>
      )}

      {!billing && !error && <div className="mg-card"><SkeletonRows rows={3} /></div>}
      {billing && (
        <div className="mg-card">
          <div className="mg-row">
            <div>
              {billing.plans.find((p) => p.id === billing.subscription.plan)?.name || billing.subscription.plan} plan
              <div className="ct-hint">Resets {new Date(billing.period.end).toLocaleDateString()}</div>
            </div>
            <span className="mg-pill"><span className="dot" style={{ background: "var(--good)" }} />current</span>
          </div>
          <div style={{ display: "flex", gap: 18, flexWrap: "wrap", marginTop: 10 }}>
            <Meter label="Runs" used={budgets.runs.used} limit={budgets.runs.limit} format={formatNumber} />
            <Meter label="Managed tokens" used={budgets.managedTokens.used} limit={budgets.managedTokens.limit} format={formatCompact} />
            <Meter label="Sandbox compute" used={budgets.computeSeconds.used} limit={budgets.computeSeconds.limit} format={(v) => `${Math.round(v / 60)}m`} />
          </div>
          <SpendGuards billing={billing} onSaved={setBilling} onError={setError} />
        </div>
      )}

      <div className="mg-label">This month</div>
      {!insights && <div className="mg-card"><SkeletonRows rows={2} /></div>}
      {insights && !insights.unavailable && (
        <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))" }}>
          <Metric label="Builds" value={formatNumber(insights.buildsThisMonth)} />
          <Metric label="AI requests" value={formatNumber(insights.requests)} />
          <Metric label="AI tokens" value={formatCompact(insights.tokens)} />
          <Metric label="Estimated AI cost" value={`${fmtCr(insights.aiCost)} · ~£${Number(insights.aiCostGbp || 0).toFixed(2)}`} />
        </div>
      )}
      {insights?.unavailable && <div className="mg-card"><div className="ct-hint">AI usage insights are warming up — they appear after your next build.</div></div>}

      {insights?.byProvider?.length > 0 && (
        <div className="mg-card" style={{ marginTop: 10 }}>
          <div className="mg-label" style={{ marginTop: 0 }}>AI usage summary</div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {insights.byProvider.map((p) => (
              <span key={p.key} className="mg-pill">{p.key} · {formatCompact(p.tokens)} tok · {fmtCr(p.cost)}</span>
            ))}
            {insights.byAgent.slice(0, 4).map((a) => (
              <span key={a.key} className="mg-pill"><span className="dot" style={{ background: "var(--accent)" }} />{a.key} · {fmtCr(a.cost)}</span>
            ))}
          </div>
        </div>
      )}

      {insights?.recentBuilds?.length > 0 && (
        <>
          <div className="mg-label">Recent activity</div>
          <div className="mg-card">
            {insights.recentBuilds.map((b) => <BuildRow key={b.id} build={b} />)}
          </div>
        </>
      )}

      {billing && (
        <>
          <div className="mg-label">Plan</div>
          <div className="mg-card">
            {billing.subscription.pendingPlan && (
              <div className="mg-row">
                <div className="ct-hint">
                  Moving to <strong>{billing.subscription.pendingPlanName}</strong> on{" "}
                  {new Date(billing.subscription.pendingPlanAt).toLocaleDateString()}. You keep{" "}
                  {billing.plans.find((p) => p.id === billing.subscription.plan)?.name} until then.
                  {" "}Choosing your current plan again cancels the change.
                </div>
              </div>
            )}
            {billing.plans.map((plan) => {
              const current = billing.subscription.plan === plan.id;
              const scheduled = billing.subscription.pendingPlan === plan.id;
              // A paid subscriber can move in either direction, so the button must say which.
              const rank = { free: 0, starter: 1, pro: 2 };
              const action = plan.id === "free" ? "Switch"
                : !billing.stripeConfigured ? "Not yet"
                  : rank[plan.id] > rank[billing.subscription.plan] ? "Upgrade" : "Downgrade";
              return (
                <div className="mg-row" key={plan.id}>
                  <div>
                    {plan.name} {current && <span className="mg-pill" style={{ marginLeft: 6 }}><span className="dot" style={{ background: "var(--good)" }} />current</span>}
                    {scheduled && <span className="mg-pill" style={{ marginLeft: 6 }}><span className="dot" style={{ background: "var(--warn)" }} />scheduled</span>}
                    <div className="ct-hint">
                      {plan.priceGbp === 0 ? "£0" : plan.priceApproved ? `£${plan.priceGbp}/mo` : "pricing coming soon"} · {formatNumber(plan.monthly.runs)} runs · {formatCompact(plan.monthly.managedTokens)} tokens · {Math.round(plan.monthly.computeSeconds / 3600)}h compute
                    </div>
                  </div>
                  {!current ? (
                    <button className="ct-btn-quiet" disabled={busyPlan === plan.id || scheduled || (plan.id !== "free" && !billing.stripeConfigured)}
                      onClick={() => choosePlan(plan.id)}>
                      {scheduled ? "Scheduled" : action}
                    </button>
                  ) : billing.subscription.pendingPlan ? (
                    <button className="ct-btn-quiet" disabled={busyPlan === plan.id}
                      onClick={() => choosePlan(plan.id)}>
                      Keep {plan.name}
                    </button>
                  ) : billing.subscription.stripeManaged ? (
                    <button className="ct-btn-quiet"
                      onClick={() => billingPortal().then((r) => { window.location.href = r.url; }).catch((err) => setError(err.message))}>
                      Manage billing
                    </button>
                  ) : null}
                </div>
              );
            })}
          </div>
        </>
      )}

      <div className="mg-card" style={{ marginTop: 14 }}>
        <button className="mg-row" style={{ width: "100%", textAlign: "left", borderBottom: 0 }}
          onClick={() => setAdvanced((v) => !v)} aria-expanded={advanced}>
          <div>Advanced usage<div className="ct-hint">Per-request AI accounting and raw usage records</div></div>
          <span className="ct-hint">{advanced ? "Hide" : "Show"}</span>
        </button>
        {advanced && (
          <>
            {insights?.recentRequests?.length > 0 && (
              <>
                <div className="mg-label">AI requests (this month, latest 50)</div>
                <div style={{ overflowX: "auto" }}>
                  <table className="mg-table">
                    <thead><tr><th>When</th><th>Agent</th><th>Provider / model</th><th>In</th><th>Out</th><th>Cached</th><th>Reasoning</th><th>Time</th><th>Cost</th></tr></thead>
                    <tbody>
                      {insights.recentRequests.map((r, i) => (
                        <tr key={i}>
                          <td>{new Date(r.createdAt).toLocaleTimeString()}</td>
                          <td>{r.agent || "—"}</td>
                          <td>{r.provider} / {r.model}</td>
                          <td>{formatCompact(r.inputTokens)}</td>
                          <td>{formatCompact(r.outputTokens)}</td>
                          <td>{formatCompact(r.cachedTokens)}</td>
                          <td>{formatCompact(r.reasoningTokens)}</td>
                          <td>{fmtDuration(r.durationMs)}</td>
                          <td>{r.cost == null ? "—" : fmtCr(r.cost)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
            <div className="mg-label">Run usage records</div>
            <div style={{ overflowX: "auto" }}>
              <table className="mg-table">
                <thead><tr><th>Provider</th><th>Model</th><th>Input</th><th>Output</th></tr></thead>
                <tbody>
                  {(data?.records || []).slice(0, 20).map((record) => (
                    <tr key={record.id}>
                      <td>{record.provider}</td><td>{record.model}</td>
                      <td>{formatNumber(record.input_tokens)}</td><td>{formatNumber(record.output_tokens)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {data && !data.records.length && <div className="ct-hint" style={{ padding: 10 }}>No completed run usage yet.</div>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

const BUILD_TONE = { passed: "var(--good)", complete_unverified: "var(--good)", failed: "var(--bad)", running: "var(--accent)", interrupted: "var(--warn)" };

function BuildRow({ build }) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState(null);
  const toggle = () => {
    setOpen((v) => !v);
    if (!detail) buildCostSummary(build.id).then(setDetail).catch(() => setDetail({ unavailable: true }));
  };
  return (
    <div style={{ borderBottom: "1px solid var(--line)" }}>
      <button className="mg-row" style={{ width: "100%", textAlign: "left", borderBottom: 0 }} onClick={toggle} aria-expanded={open}>
        <div style={{ minWidth: 0 }}>
          <span className="mg-pill" style={{ marginRight: 8 }}><span className="dot" style={{ background: BUILD_TONE[build.status] || "var(--ink-3)" }} />{build.status}</span>
          {build.prompt || build.kind}
          <div className="ct-hint">{new Date(build.startedAt).toLocaleString()} · {fmtDuration(build.durationMs)} · {build.repairRounds} repair{build.repairRounds === 1 ? "" : "s"} · {formatCompact(build.tokens)} tok</div>
        </div>
        <span className="ct-hint" style={{ flexShrink: 0 }}>{fmtCr(build.cost)}</span>
      </button>
      {open && detail && !detail.unavailable && (
        <div style={{ padding: "0 4px 10px" }}>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {detail.costByAgent.map((a) => <span key={a.key} className="mg-pill">{a.key} · {fmtCr(a.cost)}</span>)}
            {detail.costByModel.map((m) => <span key={m.key} className="mg-pill"><span className="dot" style={{ background: "var(--accent)" }} />{m.key} · {fmtCr(m.cost)}</span>)}
          </div>
        </div>
      )}
      {open && detail?.unavailable && <div className="ct-hint" style={{ padding: "0 4px 10px" }}>No cost breakdown recorded for this build.</div>}
    </div>
  );
}

function SpendGuards({ billing, onSaved, onError }) {
  const overrides = billing.subscription.overrides;
  const [open, setOpen] = useState(false);
  const [runs, setRuns] = useState(overrides.runs || "");
  const [tokens, setTokens] = useState(overrides.managedTokens || "");
  const [compute, setCompute] = useState(overrides.computeSeconds || "");
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true); onError("");
    try {
      onSaved(await updateBudgets({
        runs: runs === "" ? null : Number(runs),
        managedTokens: tokens === "" ? null : Number(tokens),
        computeSeconds: compute === "" ? null : Number(compute),
      }));
      setOpen(false);
    } catch (err) { onError(err.message); } finally { setBusy(false); }
  }

  if (!open) {
    return (
      <button className="ct-btn-quiet" style={{ marginTop: 10 }} onClick={() => setOpen(true)}>
        {overrides.runs || overrides.managedTokens || overrides.computeSeconds ? "Edit spend guards" : "Set spend guards"}
      </button>
    );
  }
  return (
    <div style={{ marginTop: 10 }}>
      <div className="ct-hint">Personal caps below the plan allowance. Empty = plan limit.</div>
      <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
        <input className="mg-input" style={{ width: 130 }} type="number" min="1" placeholder="Max runs" value={runs} onChange={(e) => setRuns(e.target.value)} />
        <input className="mg-input" style={{ width: 160 }} type="number" min="1" placeholder="Max tokens" value={tokens} onChange={(e) => setTokens(e.target.value)} />
        <input className="mg-input" style={{ width: 160 }} type="number" min="1" placeholder="Max compute (s)" value={compute} onChange={(e) => setCompute(e.target.value)} />
        <button className="ct-btn" disabled={busy} onClick={save}>{busy ? "Saving…" : "Save"}</button>
        <button className="ct-btn-quiet" onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </div>
  );
}
