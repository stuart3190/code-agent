// Deployment history: what actually went out, and when.
//
// This used to list diag_runs — diagnostic BUILD runs — which meant a build nobody published
// appeared as a deployment, a publish appeared as nothing of its own, and there was nothing to
// roll back to. It now reads real deployment records.
//
// The fields are the ones Thrallo genuinely has. There is no commit, no branch and no author,
// because these projects have no repository connected; showing empty ones would be inventing a
// concept the product does not have.

import React, { useCallback, useEffect, useState } from "react";
import { projectDeployments, rollbackDeployment, downloadDeployment } from "../lib/codeAgentApi.js";
import { relativeTime } from "./publishLifecycle.js";

const STATUS_LABEL = {
  building: "Building",
  deploying: "Deploying",
  live: "Live",
  failed: "Failed",
  rolled_back: "Rolled back",
  superseded: "Superseded",
};
const STATUS_TONE = {
  building: "building", deploying: "building", live: "live",
  failed: "failed", rolled_back: "update", superseded: "muted",
};

const seconds = (ms) => (ms == null ? "—" : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);

function Confirm({ deployment, busy, error, onCancel, onConfirm }) {
  return (
    <div className="ct-confirm" role="alertdialog" aria-label="Confirm rollback">
      <strong>Roll back to deployment #{deployment.number}?</strong>
      <div className="ct-hint">
        Your site will serve the source published as #{deployment.number} again. The address and any
        custom domains stay exactly as they are, and this is recorded as a new deployment — nothing
        in the history is rewritten.
      </div>
      {error && <div className="mg-error">{error}</div>}
      <div className="ct-pubrow-actions">
        <button className="ct-btn" disabled={busy} onClick={onConfirm}>
          {busy ? "Rolling back…" : `Roll back to #${deployment.number}`}
        </button>
        <button className="ct-btn-quiet" disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

export default function DeploymentsView({ site, onOpenLogs, onUpgrade }) {
  const [deployments, setDeployments] = useState(null);
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const projectId = site?.projectId;

  const load = useCallback(async () => {
    if (!projectId) return;
    try {
      const result = await projectDeployments(projectId);
      setDeployments(result.deployments || []);
      setError("");
    } catch (e) {
      // An empty list and a failed read must not look the same.
      setError(e.message || "Deployment history is unavailable right now.");
    }
  }, [projectId]);
  useEffect(() => { load(); }, [load]);

  // While something is going out, the list is stale the moment it renders.
  useEffect(() => {
    if (!deployments?.some((d) => d.status === "building" || d.status === "deploying")) return undefined;
    const timer = setInterval(load, 5_000);
    return () => clearInterval(timer);
  }, [deployments, load]);

  async function rollback(deployment) {
    setBusy(true); setActionError("");
    try {
      const result = await rollbackDeployment(projectId, deployment.id);
      setDeployments(result.deployments || []);
      setConfirming(null);
    } catch (e) {
      setActionError(e.message || "That rollback did not work. Your site is unchanged.");
    } finally {
      setBusy(false);
    }
  }

  if (error) {
    return (
      <div className="mg-error">
        {error} <button className="ct-linkish" onClick={load}>Try again</button>
      </div>
    );
  }
  if (!deployments) return <div className="mg-card"><div className="ct-hint">Loading…</div></div>;

  if (!deployments.length) {
    return (
      <div className="ct-logs-empty">
        <strong>Nothing has been deployed yet.</strong>
        <span className="ct-hint">
          Every publish is recorded here with its build and deploy times, so you can see what went
          out and put an earlier version back.
        </span>
      </div>
    );
  }

  const live = deployments.find((d) => d.status === "live") || null;

  return (
    <>
      <div className="mg-label">Deployments</div>
      {deployments.map((d) => {
        const isLive = d.status === "live";
        return (
          <div className={`mg-card ct-deploy ${isLive ? "is-live" : ""}`} key={d.id}>
            <div className="ct-deploy-head">
              <span className="ct-deploy-no">#{d.number}</span>
              <span className={`ct-badge tone-${STATUS_TONE[d.status] || "muted"}`}>
                {STATUS_LABEL[d.status] || d.status}
              </span>
              {/* The current live deployment must be obvious at a glance, not deduced from a list
                  position that changes. */}
              {isLive && <span className="ct-deploy-current">Currently serving</span>}
              <span className="ct-deploy-env">{d.environment === "production" ? "Production" : "Preview"}</span>
            </div>

            <div className="ct-deploy-facts">
              <span><b>Triggered by</b> {d.triggeredByKind === "rollback" ? "Rollback" : d.triggeredByKind === "system" ? "Thrallo" : "You"}</span>
              <span><b>Build</b> {seconds(d.buildDurationMs)}</span>
              <span><b>Deploy</b> {seconds(d.deployDurationMs)}</span>
              <span><b>Published</b> {d.deployedAt ? relativeTime(d.deployedAt) : "—"}</span>
            </div>

            {d.rolledBackFrom && (
              <div className="ct-hint">
                Restored the source published as #{deployments.find((x) => x.id === d.rolledBackFrom)?.number ?? "an earlier deployment"}.
              </div>
            )}
            {d.failureReason && <div className="ct-hint ct-deploy-fail">{d.failureReason}</div>}
            {d.url && isLive && (
              <a className="ct-published-url" href={d.url} target="_blank" rel="noopener noreferrer">
                {String(d.url).replace(/^https?:\/\//, "").replace(/\/$/, "")}
              </a>
            )}

            <div className="ct-pubrow-actions">
              {/* Never a fallback to the whole log stream: without a build run there is no exact
                  log to open, and a button that quietly shows something else is worse than none. */}
              {d.buildRunId
                ? <button className="ct-pubrow-btn" onClick={() => onOpenLogs(d.buildRunId)}>View logs</button>
                : <span className="ct-hint">No build log recorded</span>}

              {d.sourceAvailable && !isLive && d.status !== "building" && d.status !== "deploying" && (
                <button className="ct-pubrow-btn" onClick={() => { setActionError(""); setConfirming(d); }}>
                  Rollback
                </button>
              )}
              {d.sourceAvailable
                ? <button className="ct-pubrow-btn" onClick={() => downloadDeployment(projectId, d.id, d.number).catch((e) => setActionError(e.message))}>Download source</button>
                : <span className="ct-hint">Source not stored</span>}
            </div>

            {confirming?.id === d.id && (
              <Confirm deployment={d} busy={busy} error={actionError}
                onCancel={() => setConfirming(null)} onConfirm={() => rollback(d)} />
            )}
          </div>
        );
      })}

      <div className="ct-hint" style={{ marginTop: 8 }}>
        Download gives the source that was published, rebuilt from what Thrallo stored — not the
        built files themselves.
        {live?.number != null && ` Deployment #${live.number} is serving now.`}
      </div>
    </>
  );
}
