import React, { useState } from "react";

export default function PreviewPane({ url, onPublish, onRefresh, building = false, bare = false, verified = true }) {
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState(null);
  const [revision, setRevision] = useState(0);
  const refresh = async () => {
    if (refreshing || building || !onRefresh) return;
    setRefreshing(true); setRefreshError(null);
    try { await onRefresh(); setRevision(value => value + 1); }
    catch (error) { setRefreshError(error.message || "The preview could not restart. Please retry."); }
    finally { setRefreshing(false); }
  };
  return (
    <div className="ct-pane" style={bare ? { border: 0, borderRadius: 0, boxShadow: "none", background: "transparent" } : undefined}>
      <div className="ct-pane-top">
        <a className="ct-urlpill" href={url} title={url} target="_blank" rel="noreferrer noopener">
          <span className="ct-lock">●</span><span>{String(url).replace(/^https?:\/\//, "").replace(/\/$/, "")}</span>
        </a>
        {verified === false && (
          <span className="ct-unverified" title="This preview has no confirmed browser check.">Not verified</span>
        )}
        {onRefresh && <button className="ct-btn" onClick={refresh} disabled={refreshing || building}
          title={building ? "Wait for the current build to finish" : "Restart an expired preview from the saved app"}>
          {refreshing ? "Restarting…" : "Restart preview"}
        </button>}
        <button className="ct-btn" onClick={onPublish}>Publish</button>
      </div>
      {refreshError && <p role="alert" style={{ padding: "0 14px" }}>{refreshError}</p>}
      <div className="ct-pane-frame">
        <iframe key={`${url}:${revision}`} src={url} title="Live preview" sandbox="allow-scripts allow-same-origin allow-forms allow-popups" />
      </div>
    </div>
  );
}

