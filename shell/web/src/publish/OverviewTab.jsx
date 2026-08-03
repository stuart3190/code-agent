// The project overview: what someone wants within two seconds of opening a live project.

import React, { useState } from "react";
import { STATUS, STATUS_LABEL, displayUrl, relativeTime } from "./publishLifecycle.js";
import { HEALTH_LABEL, HEALTH_DOT } from "./HealthView.jsx";

export default function OverviewTab({ site, onOpenTab, onPublishUpdate, onUnpublish }) {
  const [copied, setCopied] = useState(false);
  const address = site.primaryUrl || site.url;
  const status = site.status || STATUS.published;
  const offline = status === STATUS.unpublished;
  const health = site.health;

  return (
    <>
      <div className="ct-published-head">
        <span className={`ct-badge tone-${status === STATUS.published ? "live" : status === STATUS.updateAvailable ? "update" : "muted"}`}>
          {status === STATUS.published ? "LIVE" : STATUS_LABEL[status]?.toUpperCase() || "DRAFT"}
        </span>
        {status === STATUS.updateAvailable && <span className="ct-badge tone-live">LIVE</span>}
        <span className="ct-published-env">Production</span>
      </div>

      {offline
        ? <span className="ct-published-url offline">{displayUrl(address)}</span>
        : <a className="ct-published-url" href={address} target="_blank" rel="noopener noreferrer">{displayUrl(address)}</a>}

      <div className="ct-published-meta">
        {offline
          ? `Taken offline ${relativeTime(site.unpublishedAt)}`
          : `Last published ${relativeTime(site.publishedAt)}`}
        {site.customDomain && !offline && " · custom domain"}
      </div>

      <div className="ct-published-actions">
        {!offline && <a className="ct-btn" href={address} target="_blank" rel="noopener noreferrer">Open Site</a>}
        {!offline && (
          <button className="ct-btn-quiet" onClick={async () => {
            try {
              await navigator.clipboard.writeText(address);
              setCopied(true); setTimeout(() => setCopied(false), 2_000);
            } catch { setCopied(false); }
          }}>{copied ? "Copied" : "Copy URL"}</button>
        )}
        <button className="ct-btn-quiet" onClick={onPublishUpdate}>
          {offline ? "Publish Again" : "Publish Update"}
        </button>
        {!offline && <button className="ct-btn-quiet" onClick={onUnpublish}>Unpublish</button>}
      </div>

      <div className="mg-label">At a glance</div>
      <div className="ct-metrics">
        <button className="ct-metric-link" onClick={() => onOpenTab("health")}>
          <span className="v">{health ? `${HEALTH_DOT[health.status]}` : "—"}</span>
          <span className="k">{health ? HEALTH_LABEL[health.status] : "Not checked yet"}</span>
        </button>
        <button className="ct-metric-link" onClick={() => onOpenTab("analytics")}>
          <span className="v">📊</span><span className="k">Analytics</span>
        </button>
        <button className="ct-metric-link" onClick={() => onOpenTab("logs")}>
          <span className="v">📋</span><span className="k">Logs</span>
        </button>
        <button className="ct-metric-link" onClick={() => onOpenTab("domains")}>
          <span className="v">🌐</span>
          <span className="k">{site.customDomain ? site.customDomain : "Add a domain"}</span>
        </button>
      </div>

      {health?.detail && (
        <div className="mg-card">
          <div className="ct-hint">{health.detail} · <button className="ct-linkish" onClick={() => onOpenTab("health")}>See health</button></div>
        </div>
      )}
    </>
  );
}
