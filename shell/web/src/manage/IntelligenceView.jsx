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

// One model's measured profile. Everything shown is derived from real builds; a model
// below the evidence floor says so instead of showing a ranking.
function ModelRow({ model }) {
  const t = model.trend;
  return (
    <div className="mg-card" style={{ background: "var(--surface)", marginBottom: 8 }}>
      <div className="mg-row" style={{ borderBottom: 0, paddingBottom: 4 }}>
        <div style={{ minWidth: 0 }}>
          <span className="mg-mono">{model.model}</span>
          <div className="ct-hint">
            {model.builds} verified build{model.builds === 1 ? "" : "s"} · {fmtPct(model.verificationRate)} success ·
            {" "}{fmtCr(model.costPerVerifiedBuild)} avg · {fmtMs(model.avgBuildMs)} avg
            {model.taskWinRate != null ? ` · wins ${model.taskWinRate}% of task types (${model.taskWins}/${model.taskContests})` : ""}
          </div>
        </div>
        <span style={{ display: "flex", gap: 6, alignItems: "center", flexShrink: 0 }}>
          {model.recommendationScore != null && <span className="ct-model-cost">score {model.recommendationScore}</span>}
          <Confidence level={model.confidence} samples={model.samples} />
        </span>
      </div>
      {model.outcomes && !model.outcomes.collecting && (
        <div style={{ marginTop: 6 }}>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
            <span className="mg-pill"><span className="dot" style={{ background: "var(--accent)" }} />User success {model.outcomes.userSuccessScore}</span>
            <span className="ct-hint">
              {fmtPct(model.outcomes.firstPassAcceptanceRate)} first-pass · {fmtPct(model.outcomes.acceptanceRate)} accepted ·
              {" "}{fmtPct(model.outcomes.completionRate)} completed
            </span>
          </div>
          <div className="ct-hint" style={{ marginTop: 4 }}>
            {model.outcomes.avgFollowUps} follow-ups · {model.outcomes.avgRepairCycles} repair cycles ·
            {" "}{fmtPct(model.outcomes.exportRate)} exported · {fmtPct(model.outcomes.deploymentRate)} deployed ·
            {" "}{fmtPct(model.outcomes.rollbackRate)} rolled back · {fmtPct(model.outcomes.abandonmentRate)} abandoned
          </div>
        </div>
      )}
      {model.outcomes?.collecting && (
        <div className="ct-hint" style={{ marginTop: 6 }}>User outcomes: collecting benchmark data ({model.outcomes.builds}).</div>
      )}
      {(model.strengths.length > 0 || model.weaknesses.length > 0) && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 6 }}>
          {model.strengths.map((s) => (
            <span key={s} className="mg-pill"><span className="dot" style={{ background: "var(--good)" }} />{s}</span>
          ))}
          {model.weaknesses.map((w) => (
            <span key={w} className="mg-pill"><span className="dot" style={{ background: "var(--warn)" }} />{w}</span>
          ))}
        </div>
      )}
      <div className="ct-hint" style={{ marginTop: 6 }}>
        {model.avgRepairRounds ?? "—"} repairs · {model.avgRetries ?? "—"} retries · {fmtPct(model.cacheEfficiency)} cache ·
        {" "}{fmtPct(model.cancellationRate)} cancelled
        {t ? ` · trend: cost ${t.costChangePercent > 0 ? "+" : ""}${t.costChangePercent}%${t.verificationChange != null ? `, verification ${t.verificationChange > 0 ? "+" : ""}${t.verificationChange}pt` : ""} vs earlier window` : " · trend: collecting"}
      </div>
    </div>
  );
}

// Providers expand to reveal every model they have evidence for. No provider-specific
// logic lives here — the tree comes from the evidence.
function ProviderCard({ provider }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mg-card">
      <button className="mg-row" style={{ width: "100%", textAlign: "left", borderBottom: 0 }}
        onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <div style={{ minWidth: 0 }}>
          {provider.provider}
          <div className="ct-hint">
            {provider.models.length} model{provider.models.length === 1 ? "" : "s"} ·
            {" "}{formatNumber(provider.requests)} requests · {provider.builds} verified builds ·
            {" "}{fmtPct(provider.verificationRate)} success · {fmtCr(provider.costPerVerifiedBuild)} avg
          </div>
        </div>
        <span style={{ display: "flex", gap: 6, alignItems: "center", flexShrink: 0 }}>
          <Confidence level={provider.confidence} samples={provider.samples} />
          <span className="ct-model-chev" aria-hidden="true">{open ? "▾" : "›"}</span>
        </span>
      </button>
      {open && (
        <div style={{ marginTop: 8 }}>
          {provider.models.map((m) => <ModelRow key={m.model} model={m} />)}
          {!provider.models.length && <div className="ct-hint">Collecting benchmark data.</div>}
        </div>
      )}
    </div>
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
          {data.usedOutcomes
            ? `Score = ${data.weights.userSuccess} × (1 − user success) + ${data.weights.costPerVerified} × cost per verified build + ${data.weights.duration} × duration + ${data.weights.verification} × (1 − verification rate)`
            : `Score = ${data.weights.costPerVerified} × cost per verified build + ${data.weights.duration} × duration + ${data.weights.verification} × (1 − verification rate)`}
          , each normalised across eligible models. Lower wins; ties break alphabetically, so the same
          evidence always produces the same ranking.
          {data.usedOutcomes
            ? " Real-world outcomes are leading this ranking."
            : " Ranking on technical benchmarks only — user-outcome evidence is still collecting."}
        </div>
      </div>

      <div className="mg-label">Providers &amp; models</div>
      {data.providers.map((p) => <ProviderCard key={p.provider} provider={p} />)}
      {!data.providers.length && <div className="mg-card"><div className="ct-hint">Collecting benchmark data.</div></div>}

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
