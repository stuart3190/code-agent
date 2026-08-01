// Admin → Provider Intelligence. Everything here is measured from real builds; where the
// evidence floor isn't met it says "Collecting benchmark data." rather than showing a
// number. Weights are displayed so any ranking can be re-derived by hand.

import React, { useEffect, useState } from "react";
import { adminIntelligence } from "../lib/codeAgentApi.js";
import { SkeletonRows, formatNumber } from "./shared.jsx";

const CONF_TONE = { High: "var(--good)", Medium: "var(--warn)", Low: "var(--ink-3)" };
const fmtMs = (ms) => (ms == null ? "—" : ms >= 60_000 ? `${Math.round(ms / 60_000)}m` : `${Math.round(ms / 1000)}s`);
const fmtCr = (v) => (v == null ? "—" : `${Number(v).toFixed(3)} cr`);
const fmtPct = (v) => (v == null ? "—" : `${v}%`);

function Confidence({ level, samples }) {
  if (!level) return <span className="ct-hint">Collecting benchmark data ({samples || 0})</span>;
  return (
    <span className="mg-pill">
      <span className="dot" style={{ background: CONF_TONE[level] || "var(--ink-3)" }} />
      {level} · {samples} samples
    </span>
  );
}

function ScoreTable({ title, rows }) {
  return (
    <>
      <div className="mg-label">{title}</div>
      <div className="mg-card" style={{ overflowX: "auto" }}>
        <table className="mg-table">
          <thead><tr><th>Model</th><th>Cost / verified build</th><th>Verification</th><th>Avg duration</th><th>Repairs</th><th>Retries</th><th>Cache</th><th>Confidence</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}>
                <td className="mg-mono">{r.key}</td>
                <td>{fmtCr(r.costPerVerifiedBuild)}</td>
                <td>{fmtPct(r.verificationRate)}</td>
                <td>{fmtMs(r.avgBuildMs)}</td>
                <td>{r.avgRepairRounds ?? "—"}</td>
                <td>{r.avgRetries ?? "—"}</td>
                <td>{fmtPct(r.cacheEfficiency)}</td>
                <td><Confidence level={r.confidence} samples={r.samples} /></td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && <div className="ct-hint" style={{ padding: 10 }}>Collecting benchmark data.</div>}
      </div>
    </>
  );
}

export default function IntelligenceView() {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => { adminIntelligence().then(setData).catch((e) => setError(e.message)); }, []);

  if (error) {
    return (
      <div>
        <h3>Provider intelligence</h3>
        <p className="mg-sub">{/admin/i.test(error) ? "This dashboard is only available to platform administrators." : error}</p>
      </div>
    );
  }
  if (!data) return <div><h3>Provider intelligence</h3><div className="mg-card"><SkeletonRows rows={4} /></div></div>;

  return (
    <div>
      <h3>Provider intelligence</h3>
      <p className="mg-sub">
        How Auto ranks models, learned from {formatNumber(data.totalRequests || 0)} real AI requests over the last {data.windowDays} days.
        Rankings need at least {data.minSamples} verified builds; below that Auto keeps its configured order.
      </p>

      <div className="mg-card">
        <div className="mg-label" style={{ marginTop: 0 }}>Current recommendation</div>
        <div style={{ fontSize: 14 }}>{data.overall.explanation}</div>
        {data.overall.ranked.length > 0 && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
            {data.overall.ranked.map((r, i) => (
              <span key={r.model} className="mg-pill">
                {i + 1}. {r.model} · score {r.score} · {r.confidence || "collecting"}
              </span>
            ))}
          </div>
        )}
        <div className="ct-hint" style={{ marginTop: 8 }}>
          Score = {data.weights.costPerVerified} × cost per verified build + {data.weights.duration} × duration
          + {data.weights.verification} × (1 − verification rate), each normalised across eligible models. Lower wins;
          ties break alphabetically, so the same evidence always produces the same ranking.
        </div>
      </div>

      <ScoreTable title="Model rankings" rows={data.models} />
      <ScoreTable title="Provider rankings" rows={data.providers} />

      <div className="mg-label">By task type</div>
      <div className="mg-card">
        {Object.entries(data.perTask).map(([task, entry]) => (
          <div className="mg-row" key={task}>
            <div style={{ minWidth: 0 }}>
              {task.replace(/_/g, " ")}
              <div className="ct-hint">{entry.explanation}</div>
            </div>
            <span style={{ flexShrink: 0 }}>
              {entry.ranked[0] ? <Confidence level={entry.ranked[0].confidence} samples={entry.ranked[0].samples} /> : <span className="ct-hint">—</span>}
            </span>
          </div>
        ))}
      </div>

      <div className="mg-label">Execution modes</div>
      <div className="mg-card" style={{ overflowX: "auto" }}>
        <table className="mg-table">
          <thead><tr><th>Mode</th><th>Requests</th><th>Cost / verified</th><th>Verification</th><th>Cancellations</th><th>Confidence</th></tr></thead>
          <tbody>
            {data.modes.map((m) => (
              <tr key={m.key}>
                <td>{m.key}</td>
                <td>{formatNumber(m.requests)}</td>
                <td>{fmtCr(m.costPerVerifiedBuild)}</td>
                <td>{fmtPct(m.verificationRate)}</td>
                <td>{fmtPct(m.cancellationRate)}</td>
                <td><Confidence level={m.confidence} samples={m.samples} /></td>
              </tr>
            ))}
          </tbody>
        </table>
        {!data.modes.length && <div className="ct-hint" style={{ padding: 10 }}>Collecting benchmark data.</div>}
      </div>
    </div>
  );
}
