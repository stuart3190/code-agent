// Operations — admin-only platform telemetry ("how is the platform doing?"). Hidden for
// everyone else; reached via ⌘K.

import React, { useEffect, useState } from "react";
import { opsTelemetry } from "../lib/codeAgentApi.js";
import { Metric, formatNumber, formatCompact } from "./shared.jsx";

function StatusList({ title, entries }) {
  const keys = Object.keys(entries || {});
  return (
    <div className="mg-card" style={{ marginBottom: 0 }}>
      <div style={{ fontWeight: 700, fontSize: 13.5 }}>{title}</div>
      {keys.map((key) => (
        <div className="mg-row" key={key}><span className="ct-hint">{key}</span><span className="mg-mono">{formatNumber(entries[key])}</span></div>
      ))}
      {!keys.length && <div className="ct-hint">Nothing recorded yet.</div>}
    </div>
  );
}

export default function OpsView() {
  const [snapshot, setSnapshot] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => { opsTelemetry().then(setSnapshot).catch((err) => setError(err.message)); }, []);
  if (!snapshot) return <div><h3>Operations</h3><p className="mg-sub">{error || "Loading telemetry…"}</p></div>;
  const day = snapshot.runs.last24h;
  return (
    <div>
      <h3>Operations</h3>
      <p className="mg-sub">Platform-wide runs, queue health, provider reliability. Generated {new Date(snapshot.generatedAt).toLocaleTimeString()}.</p>
      <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))" }}>
        <Metric label="Runs · 24h" value={formatNumber(day.total)} />
        <Metric label="Failure rate · 24h" value={`${Math.round(day.failureRate * 100)}%`} />
        <Metric label="Avg duration · 24h" value={`${day.averageDurationSeconds}s`} />
        <Metric label="Queue depth" value={formatNumber(snapshot.runs.queueDepth)} />
        <Metric label="Active runs" value={formatNumber(snapshot.runs.active)} />
        <Metric label="Awaiting approval" value={formatNumber(snapshot.runs.waitingForApproval)} />
        <Metric label="Tokens · 7d" value={formatCompact(snapshot.usage.last7d.tokens)} />
        <Metric label="Compute · 7d" value={`${Math.round(snapshot.usage.last7d.computeSeconds / 60)}m`} />
      </div>
      <div className="mg-label">Provider reliability · 7d</div>
      <div className="mg-card" style={{ overflowX: "auto" }}>
        <table className="mg-table">
          <thead><tr><th>Provider</th><th>Model</th><th>Attempts</th><th>Errors</th><th>Latency</th></tr></thead>
          <tbody>
            {snapshot.providers.map((row) => (
              <tr key={`${row.provider}:${row.model}`}>
                <td>{row.provider}</td><td>{row.model}</td>
                <td>{formatNumber(row.attempts)}</td>
                <td style={row.errorRate > 0.1 ? { color: "var(--bad)" } : undefined}>{Math.round(row.errorRate * 100)}%</td>
                <td>{formatNumber(row.averageLatencyMs)}ms</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!snapshot.providers.length && <div className="ct-hint" style={{ padding: 10 }}>No model attempts in the last 7 days.</div>}
      </div>
      <div className="mg-label">Health</div>
      <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
        <StatusList title="Run states · 7d" entries={snapshot.runs.last7d.byState} />
        <StatusList title="Webhook deliveries" entries={snapshot.webhooks} />
        <StatusList title="Repository indexes" entries={snapshot.indexing} />
      </div>
    </div>
  );
}
