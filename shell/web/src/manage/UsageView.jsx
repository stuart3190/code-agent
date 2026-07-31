// Usage & plan — the visual answer to "show my monthly usage". Conversation answers the
// quick question; this view holds the graphs, plan switching, and spend guards.

import React, { useCallback, useEffect, useState } from "react";
import { usageSummary, billingOverview, selectPlan, billingPortal, updateBudgets } from "../lib/codeAgentApi.js";
import { BudgetMeter, Metric, SkeletonRows, formatNumber, formatCompact } from "./shared.jsx";

export default function UsageView() {
  const [data, setData] = useState(null);
  const [billing, setBilling] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busyPlan, setBusyPlan] = useState("");

  const refreshBilling = useCallback(() => {
    billingOverview().then(setBilling).catch((err) => setError(err.message));
  }, []);
  useEffect(() => {
    usageSummary().then(setData).catch((err) => setError(err.message));
    refreshBilling();
  }, [refreshBilling]);

  async function choosePlan(planId) {
    setBusyPlan(planId); setError(""); setNotice("");
    try {
      const result = await selectPlan(planId);
      if (result.url) { window.location.href = result.url; return; }
      setBilling(result);
      setNotice(`You are on the ${planId === "free" ? "Free" : planId} plan.`);
    } catch (err) { setError(err.message); } finally { setBusyPlan(""); }
  }

  const totals = data?.totals || {};
  return (
    <div>
      <h3>Usage &amp; plan</h3>
      <p className="mg-sub">Ask “how much budget is left?” any time — this is the full picture.</p>
      {error && <div className="mg-error">{error}</div>}
      {notice && <div className="mg-ok">{notice}</div>}

      {!billing && !error && <div className="mg-card"><SkeletonRows rows={3} /></div>}
      {billing && (
        <>
          <div className="mg-card">
            <div className="mg-row">
              <span>This period's budgets</span>
              <span className="ct-hint">resets {new Date(billing.period.end).toLocaleDateString()}</span>
            </div>
            <div style={{ display: "flex", gap: 18, flexWrap: "wrap", marginTop: 10 }}>
              <BudgetMeter label="Agent runs" meter={billing.budgets.runs} format={formatNumber} />
              <BudgetMeter label="Managed tokens" meter={billing.budgets.managedTokens} format={formatCompact} />
              <BudgetMeter label="Sandbox compute" meter={billing.budgets.computeSeconds} format={(v) => `${Math.round(v / 60)}m`} />
            </div>
            <SpendGuards billing={billing} onSaved={setBilling} onError={setError} />
          </div>

          <div className="mg-label">Plan</div>
          <div className="mg-card">
            {billing.plans.map((plan) => {
              const current = billing.subscription.plan === plan.id;
              return (
                <div className="mg-row" key={plan.id}>
                  <div>
                    {plan.name} {current && <span className="mg-pill" style={{ marginLeft: 6 }}><span className="dot" style={{ background: "var(--good)" }} />current</span>}
                    <div className="ct-hint">
                      {plan.priceGbp === 0 ? "£0" : plan.priceApproved ? `£${plan.priceGbp}/mo` : "pricing coming soon"} · {formatNumber(plan.monthly.runs)} runs · {formatCompact(plan.monthly.managedTokens)} tokens · {Math.round(plan.monthly.computeSeconds / 3600)}h compute
                    </div>
                  </div>
                  {!current ? (
                    <button className="ct-btn-quiet" disabled={busyPlan === plan.id || (plan.id !== "free" && !billing.stripeConfigured)}
                      onClick={() => choosePlan(plan.id)}>
                      {plan.id === "free" ? "Switch" : billing.stripeConfigured ? "Upgrade" : "Not yet"}
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

      <div className="mg-label">This period's totals</div>
      <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))" }}>
        <Metric label="Input tokens" value={formatNumber(totals.inputTokens)} />
        <Metric label="Output tokens" value={formatNumber(totals.outputTokens)} />
        <Metric label="Cached tokens" value={formatNumber(totals.cachedTokens)} />
        <Metric label="Sandbox time" value={`${Math.round(totals.computeSeconds || 0)}s`} />
      </div>

      <div className="mg-label">Recent records</div>
      <div className="mg-card" style={{ overflowX: "auto" }}>
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
