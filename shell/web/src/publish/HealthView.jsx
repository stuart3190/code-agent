// The health page for one published project.
//
// Answers the questions an owner actually asks when something feels wrong, in the order they ask
// them: is it up, how long has it been like this, is it slow, is the certificate about to expire,
// does the domain still point here, and when did it last work.

import React, { useCallback, useEffect, useState } from "react";
import { projectHealth } from "../lib/codeAgentApi.js";
import { relativeTime, displayUrl } from "./publishLifecycle.js";

export const HEALTH_LABEL = { healthy: "Healthy", warning: "Warning", offline: "Offline" };
export const HEALTH_DOT = { healthy: "🟢", warning: "🟡", offline: "🔴" };

const ms = (value) => (value == null ? "—" : value >= 1000 ? `${(value / 1000).toFixed(2)}s` : `${value}ms`);

function UptimeBars({ daily }) {
  if (!daily.length) return <div className="ct-hint">No checks recorded yet.</div>;
  return (
    <div className="ct-uptime" role="img" aria-label={`Uptime over ${daily.length} days`}>
      {daily.map((d) => (
        <span key={d.day}
          className={`ct-uptime-bar ${d.uptime >= 99.9 ? "good" : d.uptime >= 95 ? "warn" : "bad"}`}
          title={`${d.day} — ${d.uptime}% up${d.averageMs ? `, avg ${ms(d.averageMs)}` : ""}`} />
      ))}
    </div>
  );
}

export default function HealthView({ site, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const projectId = site?.projectId;

  const load = useCallback(async () => {
    if (!projectId) return;
    try { setData(await projectHealth(projectId)); }
    catch (e) { setError(e.message || "Health information is unavailable right now."); }
  }, [projectId]);

  useEffect(() => { load(); }, [load]);
  // A health page that goes stale while you watch it is worse than none.
  useEffect(() => {
    const timer = setInterval(load, 30_000);
    return () => clearInterval(timer);
  }, [load]);

  const status = data?.status;
  const state = status?.status || "healthy";

  return (
    <aside className="ct-sheet show ct-analytics" aria-label="Health">
      <div className="ct-sheet-head">
        <h2>Health</h2>
        <button className="ct-btn-quiet" onClick={onClose}>Done</button>
      </div>
      <div className="ct-sheet-body">
        {error && <div className="mg-error">{error}</div>}
        {!data && !error && <div className="mg-card"><div className="ct-hint">Loading…</div></div>}

        {data && !status && (
          <div className="mg-card"><div className="ct-hint">
            This site has not been checked yet. Monitoring begins within a few minutes of publishing.
          </div></div>
        )}

        {status && (
          <>
            <div className={`ct-health-hero st-${state}`}>
              <div className="ct-health-state">
                <span aria-hidden="true">{HEALTH_DOT[state]}</span> {HEALTH_LABEL[state]}
              </div>
              <div className="ct-hint">
                {status.detail || "Responding normally."}
                {status.since && ` · since ${relativeTime(status.since)}`}
              </div>
              {status.url && (
                <a className="ct-published-url" href={status.url} target="_blank" rel="noopener noreferrer">
                  {displayUrl(status.url)}
                </a>
              )}
            </div>

            <div className="ct-metrics">
              <div>
                <span className="v">{data.uptime == null ? "—" : `${data.uptime}%`}</span>
                <span className="k">Uptime · {data.windowDays} days</span>
              </div>
              <div>
                <span className="v">{ms(data.responseTime?.medianMs)}</span>
                <span className="k">Median response</span>
              </div>
              <div>
                <span className="v">{ms(data.responseTime?.p95Ms)}</span>
                <span className="k">95th percentile</span>
              </div>
              <div>
                <span className="v">{status.httpStatus ?? "—"}</span>
                <span className="k">HTTP status</span>
              </div>
            </div>

            <div className="mg-label">Uptime</div>
            <div className="mg-card">
              <UptimeBars daily={data.daily} />
              <div className="ct-hint" style={{ marginTop: 6 }}>
                Based on {data.checks} checks. A slow response or an expiring certificate is a
                warning, not downtime — the site was still serving.
              </div>
            </div>

            <div className="mg-label">Certificate &amp; domain</div>
            <div className="mg-card">
              <div className="mg-row">
                <div>
                  HTTPS certificate
                  <div className="ct-hint">
                    {status.sslValidTo
                      ? `Valid until ${new Date(status.sslValidTo).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })}`
                      : "Not checked yet."}
                  </div>
                </div>
                <span className={`ct-badge tone-${status.sslDaysLeft == null ? "muted" : status.sslDaysLeft <= 0 ? "failed" : status.sslDaysLeft <= 14 ? "update" : "live"}`}>
                  {status.sslDaysLeft == null ? "UNKNOWN"
                    : status.sslDaysLeft <= 0 ? "EXPIRED"
                      : `${status.sslDaysLeft} DAYS`}
                </span>
              </div>
              <div className="mg-row">
                <div>
                  Domain routing
                  <div className="ct-hint">
                    {status.dnsOk === false
                      ? "The domain no longer points to Thrallo."
                      : "Resolving to Thrallo correctly."}
                  </div>
                </div>
                <span className={`ct-badge tone-${status.dnsOk === false ? "failed" : "live"}`}>
                  {status.dnsOk === false ? "MISCONFIGURED" : "OK"}
                </span>
              </div>
              <div className="mg-row">
                <div>
                  Last successful check
                  <div className="ct-hint">
                    {status.lastHealthyAt ? relativeTime(status.lastHealthyAt) : "Never"}
                    {status.lastCheckedAt && ` · last checked ${relativeTime(status.lastCheckedAt)}`}
                  </div>
                </div>
              </div>
            </div>

            {data.incidents.length > 0 && (
              <>
                <div className="mg-label">Incidents</div>
                <div className="mg-card">
                  {data.incidents.map((incident) => (
                    <div className="mg-row" key={incident.startedAt}>
                      <div>
                        {new Date(incident.startedAt).toLocaleString("en-GB", { timeZone: "UTC" })}
                        <div className="ct-hint">
                          {incident.detail || "The site did not respond."}
                          {incident.endedAt
                            ? ` · recovered after ${Math.max(1, Math.round((Date.parse(incident.endedAt) - Date.parse(incident.startedAt)) / 60_000))} min`
                            : " · ongoing"}
                        </div>
                      </div>
                      <span className={`ct-badge tone-${incident.endedAt ? "muted" : "failed"}`}>
                        {incident.endedAt ? "RESOLVED" : "ONGOING"}
                      </span>
                    </div>
                  ))}
                </div>
              </>
            )}

            <div className="ct-hint" style={{ marginTop: 14 }}>
              Checked every five minutes. You are alerted when the site goes down, when a
              certificate is close to expiry, and when a custom domain stops pointing here — once
              per problem, not once per check.
            </div>
          </>
        )}
      </div>
    </aside>
  );
}
