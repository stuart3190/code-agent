// Shared pieces for the Manage tabs — real ports of the old console components,
// restyled to the light token theme (chat.css mg-*/ct-* families only).
import React, { useEffect, useState } from "react";
import { artifactContent } from "../lib/codeAgentApi.js";

export const terminalStates = new Set(["succeeded", "failed", "cancelled", "interrupted"]);

export function formatNumber(value) {
  return new Intl.NumberFormat().format(Number(value || 0));
}

export function formatCompact(value) {
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(Number(value || 0));
}

// Loading placeholder shaped like the rows it will become — used by every manage view so
// nothing renders as a bare "Loading…" or an empty card.
export function SkeletonRows({ rows = 2 }) {
  return (
    <div aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <div className="mg-row mg-skel" key={i}>
          <span className="mg-skel-line" style={{ width: `${46 + ((i * 17) % 30)}%` }} />
          <span className="mg-skel-line" style={{ width: 64 }} />
        </div>
      ))}
    </div>
  );
}

// Clipboard with visible confirmation — silent copies read as broken buttons.
export function useCopy() {
  const [copied, setCopied] = useState(false);
  const copy = (value) => {
    navigator.clipboard?.writeText(value).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    }).catch(() => {});
  };
  return [copied, copy];
}

export function StatusDot({ ok, label }) {
  return (
    <span className="mg-pill">
      <span className="dot" style={{ background: ok ? "var(--good)" : "var(--warn)" }} />
      {label}
    </span>
  );
}

export function Metric({ label, value }) {
  return (
    <div className="mg-card" style={{ marginBottom: 0 }}>
      <div className="mg-label" style={{ margin: 0 }}>{label}</div>
      <div style={{ marginTop: 4 }}>{value}</div>
    </div>
  );
}

export function TimelineEvent({ event }) {
  const payload = event.payload || {};
  const isError = event.type.includes("failed");
  const isTool = event.type.startsWith("tool.");
  return (
    <div className="mg-row">
      <span className="mg-pill">
        <span className="dot" style={{ background: isError ? "var(--bad)" : isTool ? "var(--accent)" : "var(--ink-3)" }} />
        {event.type.replaceAll(".", " ")}
      </span>
      <span className={isError ? "mg-error" : "ct-hint"} style={{ flex: 1, margin: 0 }}>
        {payload.message || payload.error || payload.name || payload.text || "Updated"}
      </span>
      <span className="ct-hint">#{event.sequence}</span>
    </div>
  );
}

export function ArtifactCard({ artifact }) {
  const [content, setContent] = useState(artifact.content);
  useEffect(() => {
    setContent(artifact.content);
    if (artifact.content == null && artifact.sizeBytes > 0 && artifact.id && artifact.runId) {
      artifactContent(artifact.runId, artifact.id).then(setContent).catch(() => setContent("Failed to load artifact content"));
    }
  }, [artifact.id, artifact.runId, artifact.content, artifact.sizeBytes]);
  return (
    <div className="mg-card">
      <div className="mg-row">
        <span>{artifact.name}</span>
        {artifact.sizeBytes > 0 && <span className="ct-hint">{formatNumber(artifact.sizeBytes)} B</span>}
      </div>
      <pre className="mg-mono" style={{ maxHeight: "38vh", overflow: "auto", whiteSpace: "pre-wrap", margin: "10px 0 0", padding: "10px 12px" }}>
        {content == null && artifact.sizeBytes > 0 ? "Loading…" : content || "No content"}
      </pre>
    </div>
  );
}

export function RunSummary({ run, onRetry, onPublish, onDecline, onResume, busy }) {
  if (!run) {
    return (
      <div className="mg-card">
        <span className="ct-hint">Run output will appear here</span>
      </div>
    );
  }
  const dot = run.state === "succeeded" ? "var(--good)" : run.state === "failed" ? "var(--bad)" : "var(--accent)";
  const isReview = run.result?.approval?.action === "post_review";
  return (
    <div className="mg-card">
      <div className="mg-row">
        <span className="ct-hint">Run status</span>
        <span className="mg-pill">
          <span className="dot" style={{ background: dot }} />
          {run.state}
        </span>
      </div>
      {run.workBranch && <div className="mg-mono" style={{ marginTop: 8 }}>{run.workBranch}</div>}
      {run.error && <div className="mg-error">{run.error}</div>}
      {run.state === "waiting_for_approval" && (
        <div style={{ marginTop: 10 }}>
          <p className="ct-hint" style={{ margin: "0 0 10px" }}>
            {isReview
              ? `Review of PR #${run.pullRequest} is ready (${(run.result?.findings || []).length} findings, verdict: ${String(run.result?.verdict || "comment").replace("_", " ")}). Approving posts it to GitHub — see the Reviews tab for details.`
              : "Review the diff below. Publishing will commit this branch, push it, and open a pull request."}
          </p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button className="ct-btn" onClick={onPublish} disabled={busy}>
              {busy ? "Working…" : isReview ? "Approve & post review" : "Approve & open pull request"}
            </button>
            <button className="ct-btn-quiet" onClick={onDecline} disabled={busy}>
              {isReview ? "Discard review" : "Decline & discard workspace"}
            </button>
          </div>
        </div>
      )}
      {run.result?.publication?.pullRequest?.url && (
        <div className="ct-receipt">
          <span className="ct-rcheck">✓</span>
          <a href={run.result.publication.pullRequest.url} target="_blank" rel="noreferrer">
            Open pull request #{run.result.publication.pullRequest.number}
          </a>
        </div>
      )}
      {run.resumable && (
        <div style={{ marginTop: 10 }}>
          <button className="ct-btn" onClick={onResume} disabled={busy}>Resume from preserved workspace</button>
        </div>
      )}
      {terminalStates.has(run.state) && run.state !== "succeeded" && (
        <div style={{ marginTop: 10 }}>
          <button className="ct-btn-quiet" onClick={onRetry} disabled={busy}>Retry from clean baseline</button>
        </div>
      )}
    </div>
  );
}

export function PolicyToggle({ busy, value, onLabel, offLabel, title, onToggle }) {
  const [saving, setSaving] = useState(false);
  async function toggle() {
    setSaving(true);
    try { await onToggle(!value); } finally { setSaving(false); }
  }
  return (
    <button className="mg-row" onClick={toggle} disabled={busy || saving} title={title} style={{ width: "100%", textAlign: "left" }}>
      <span>{value ? onLabel : offLabel}</span>
      <span className="mg-pill">
        <span className="dot" style={{ background: value ? "var(--accent)" : "var(--ink-3)" }} />
        {value ? "on" : "off"}
      </span>
    </button>
  );
}

export function AgentPolicy({ agent, onChange }) {
  const [busy, setBusy] = useState(false);
  const [pathsOpen, setPathsOpen] = useState(false);
  const [paths, setPaths] = useState((agent.protectedPaths || []).join("\n"));
  const auto = agent.publishMode === "auto_publish";

  async function toggleMode() {
    setBusy(true);
    try {
      await onChange(agent.id, { publishMode: auto ? "require_approval" : "auto_publish" });
    } finally { setBusy(false); }
  }

  async function savePaths() {
    setBusy(true);
    try {
      await onChange(agent.id, {
        protectedPaths: paths.split("\n").map((line) => line.trim()).filter(Boolean),
      });
      setPathsOpen(false);
    } finally { setBusy(false); }
  }

  return (
    <div className="mg-card">
      <div className="mg-label" style={{ marginTop: 0 }}>Publish policy</div>
      <button className="mg-row" onClick={toggleMode} disabled={busy} style={{ width: "100%", textAlign: "left" }}>
        <span>{auto ? "Auto-publish PRs" : "Ask before PR"}</span>
        <span className="mg-pill">
          <span className="dot" style={{ background: auto ? "var(--good)" : "var(--warn)" }} />
          {auto ? "auto" : "ask"}
        </span>
      </button>
      <PolicyToggle busy={busy} value={agent.networkPolicy === "offline"}
        onLabel="Offline sandbox" offLabel="Full network"
        title="Offline blocks all outbound network access after checkout (Codex runs keep network)."
        onToggle={(next) => onChange(agent.id, { networkPolicy: next ? "offline" : "full" })} />
      <PolicyToggle busy={busy} value={agent.commandPolicy === "restricted"}
        onLabel="Restricted commands" offLabel="Standard commands"
        title="Restricted blocks network-transfer, remote-shell, and privilege commands in the tool loop."
        onToggle={(next) => onChange(agent.id, { commandPolicy: next ? "restricted" : "standard" })} />
      {!pathsOpen && (
        <button className="ct-btn-quiet" onClick={() => setPathsOpen(true)} style={{ marginTop: 8 }}>
          Protected paths {agent.protectedPaths?.length ? `(${agent.protectedPaths.length})` : ""}
        </button>
      )}
      {pathsOpen && (
        <div style={{ marginTop: 8 }}>
          <textarea className="mg-input" rows={3} value={paths} onChange={(e) => setPaths(e.target.value)}
            placeholder={"One glob per line, e.g.\nsrc/config/**\n*.sql"} />
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button className="ct-btn" onClick={savePaths} disabled={busy}>Save</button>
            <button className="ct-btn-quiet" onClick={() => setPathsOpen(false)}>Cancel</button>
          </div>
          <div className="ct-hint" style={{ marginTop: 6 }}>
            Changes touching these globs always wait for your approval, even with auto-publish on.
          </div>
        </div>
      )}
    </div>
  );
}

export function BudgetMeter({ label, meter, format }) {
  const ratio = meter.limit ? Math.min(meter.used / meter.limit, 1) : 0;
  const tone = ratio >= 1 ? "var(--bad)" : ratio >= 0.8 ? "var(--warn)" : null;
  return (
    <div style={{ flex: 1, minWidth: 160 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
        <span className="ct-hint">{label}</span>
        <span className="ct-hint">{format(meter.used)} / {format(meter.limit)}</span>
      </div>
      <div className="mg-meter">
        <i style={{ width: `${Math.max(ratio * 100, meter.used ? 2 : 0)}%`, ...(tone ? { background: tone } : {}) }} />
      </div>
    </div>
  );
}
