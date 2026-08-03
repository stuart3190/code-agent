// Deployment and build history. Every entry links to the logs for that deployment, because the
// question after "it failed" is always "why".

import React, { useCallback, useEffect, useState } from "react";
import { projectDeployments } from "../lib/codeAgentApi.js";
import { relativeTime } from "./publishLifecycle.js";

export default function DeploymentsView({ site, onOpenLogs, onUpgrade }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try { setData(await projectDeployments(site.projectId)); }
    catch (e) { setError(e.message || "Deployment history is unavailable right now."); }
  }, [site.projectId]);
  useEffect(() => { load(); }, [load]);

  return (
    <>
      {error && <div className="mg-error">{error}</div>}
      {!data && !error && <div className="mg-card"><div className="ct-hint">Loading…</div></div>}
      {data && (
        <>
          <div className="ct-metrics">
            <div><span className="v">{data.summary.total}</span><span className="k">Builds</span></div>
            <div><span className="v">{data.summary.failed}</span><span className="k">Failed</span></div>
            <div>
              <span className="v">{data.summary.averageDurationMs ? `${Math.round(data.summary.averageDurationMs / 1000)}s` : "—"}</span>
              <span className="k">Average build</span>
            </div>
            <div>
              <span className="v">{data.site?.lastPublishedAt ? relativeTime(data.site.lastPublishedAt).replace(" ago", "") : "—"}</span>
              <span className="k">Since last deploy</span>
            </div>
          </div>

          <div className="mg-label">History</div>
          <div className="mg-card">
            {!data.builds.length && <div className="ct-hint">No builds recorded yet.</div>}
            {data.builds.map((b) => (
              <div className="mg-row" key={b.id}>
                <div>
                  <span className={`ct-badge tone-${b.status === "passed" ? "live" : b.status === "failed" ? "failed" : "muted"}`}>
                    {String(b.status || "unknown").toUpperCase()}
                  </span>
                  <div className="ct-hint">
                    {relativeTime(b.startedAt)}
                    {b.durationMs != null && ` · ${Math.round(b.durationMs / 1000)}s`}
                    {b.repairRounds > 0 && ` · ${b.repairRounds} repair${b.repairRounds === 1 ? "" : "s"}`}
                  </div>
                </div>
                <button className="ct-pubrow-btn" onClick={onOpenLogs}>View logs</button>
              </div>
            ))}
            {data.truncated && (
              <div className="ct-hint">
                Showing recent deployments. Full build history is included on Starter and Pro.{" "}
                <button className="ct-linkish" onClick={onUpgrade}>See plans</button>
              </div>
            )}
          </div>
        </>
      )}
    </>
  );
}
