// Admin Analytics — platform-wide spend, revenue, profitability, and cost breakdowns.
// The server 403s anyone who isn't a platform administrator; this view simply renders
// that honest boundary for everyone else.

import React, { useEffect, useState } from "react";
import { adminAnalytics } from "../lib/codeAgentApi.js";
import { Metric, SkeletonRows, formatNumber, formatCompact } from "./shared.jsx";

const fmtCr = (v) => `${Number(v || 0).toFixed(2)} cr`;
const fmtGbp = (v) => `£${Number(v || 0).toFixed(2)}`;

function Bars({ series, valueKey = "cost", label }) {
  const max = Math.max(...series.map((s) => s[valueKey]), 0.0001);
  return (
    <div className="mg-card" style={{ marginBottom: 0 }}>
      <div className="mg-label" style={{ marginTop: 0 }}>{label}</div>
      {!series.length && <div className="ct-hint">No data in this window yet.</div>}
      <div style={{ display: "flex", alignItems: "flex-end", gap: 3, height: 90 }}>
        {series.map((s) => (
          <div key={s.period} title={`${s.period}: ${fmtCr(s[valueKey])} · ${s.requests} req`}
            style={{
              flex: 1, minWidth: 4, borderRadius: "3px 3px 0 0",
              background: "linear-gradient(180deg, var(--accent), #9b8cf0)",
              height: `${Math.max((s[valueKey] / max) * 100, 2)}%`,
            }} />
        ))}
      </div>
      {series.length > 0 && (
        <div className="ct-hint" style={{ display: "flex", justifyContent: "space-between" }}>
          <span>{series[0].period}</span><span>{series[series.length - 1].period}</span>
        </div>
      )}
    </div>
  );
}

function Breakdown({ title, rows }) {
  const max = Math.max(...rows.map((r) => r.cost), 0.0001);
  return (
    <div className="mg-card" style={{ marginBottom: 0 }}>
      <div className="mg-label" style={{ marginTop: 0 }}>{title}</div>
      {!rows.length && <div className="ct-hint">Nothing recorded.</div>}
      {rows.slice(0, 8).map((r) => (
        <div key={r.key} style={{ margin: "6px 0" }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.key}</span>
            <span className="ct-hint">{fmtCr(r.cost)} · {formatCompact(r.tokens)} tok</span>
          </div>
          <div className="mg-meter" style={{ margin: "3px 0 0" }}><i style={{ width: `${(r.cost / max) * 100}%` }} /></div>
        </div>
      ))}
    </div>
  );
}

export default function AdminAnalyticsView() {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => { adminAnalytics().then(setData).catch((e) => setError(e.message)); }, []);

  if (error) {
    return (
      <div>
        <h3>Admin analytics</h3>
        <p className="mg-sub">{/admin/i.test(error) ? "This dashboard is only available to platform administrators." : error}</p>
      </div>
    );
  }
  if (!data) return <div><h3>Admin analytics</h3><div className="mg-card"><SkeletonRows rows={4} /></div></div>;

  const t = data.totals;
  return (
    <div>
      <h3>Admin analytics</h3>
      <p className="mg-sub">Platform-wide AI spend, revenue and profitability — last {data.windowDays} days, generated {new Date(data.generatedAt).toLocaleTimeString()}.</p>

      <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))" }}>
        <Metric label="AI spend" value={`${fmtCr(t.aiSpendCredits)} · ~${fmtGbp(t.aiSpendGbp)}`} />
        <Metric label="Monthly revenue" value={`${fmtGbp(t.monthlyRevenueGbp)} (${t.paidSubscribers} paid)`} />
        <Metric label="Gross profit" value={fmtGbp(t.grossProfitGbp)} />
        <Metric label="Active users" value={formatNumber(t.activeUsers)} />
        <Metric label="Builds" value={formatNumber(t.builds)} />
        <Metric label="AI requests" value={formatNumber(t.requests)} />
        <Metric label="Avg cost / user" value={fmtCr(t.avgCostPerUser)} />
        <Metric label="Avg cost / build" value={fmtCr(t.avgCostPerBuild)} />
      </div>

      <div className="mg-label">Spend over time</div>
      <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))" }}>
        <Bars series={data.series.daily} label="Daily (30d)" />
        <Bars series={data.series.weekly} label="Weekly (12w)" />
        <Bars series={data.series.monthly} label="Monthly (12m)" />
      </div>

      <div className="mg-label">Where the cost goes</div>
      <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))" }}>
        <Breakdown title="Cost by model" rows={data.costByModel} />
        <Breakdown title="Cost by agent" rows={data.costByAgent} />
      </div>

      <div className="mg-label">Most expensive builds</div>
      <div className="mg-card" style={{ overflowX: "auto" }}>
        <table className="mg-table">
          <thead><tr><th>Build</th><th>Owner</th><th>Status</th><th>Prompt</th><th>Cost</th></tr></thead>
          <tbody>
            {data.topBuilds.map((b) => (
              <tr key={b.buildId}>
                <td className="mg-mono">{b.buildId.slice(0, 8)}</td>
                <td className="mg-mono">{String(b.owner).slice(0, 8)}</td>
                <td>{b.status}</td>
                <td style={{ maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{b.prompt}</td>
                <td>{fmtCr(b.cost)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!data.topBuilds.length && <div className="ct-hint" style={{ padding: 10 }}>No builds in this window.</div>}
      </div>

      <div className="mg-label">Most expensive users</div>
      <div className="mg-card" style={{ overflowX: "auto" }}>
        <table className="mg-table">
          <thead><tr><th>Owner</th><th>Requests</th><th>Tokens</th><th>Cost</th></tr></thead>
          <tbody>
            {data.topUsers.map((u) => (
              <tr key={u.owner}>
                <td className="mg-mono">{String(u.owner).slice(0, 8)}</td>
                <td>{formatNumber(u.requests)}</td>
                <td>{formatCompact(u.tokens)}</td>
                <td>{fmtCr(u.cost)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!data.topUsers.length && <div className="ct-hint" style={{ padding: 10 }}>No usage in this window.</div>}
      </div>
    </div>
  );
}
