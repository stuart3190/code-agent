// Thrallo Analytics for one published project.
//
// Charts are inline SVG rather than a charting library: the whole view needs a trend line and a
// set of ranked bars, and pulling in a dependency for that would cost more than it is worth on
// every page load of the shell.
//
// Numbers shown here are cookieless by construction — a "visitor" is a daily-rotating hash that
// cannot be linked across days, which is stated in the UI because it is a feature, not a caveat.

import React, { useCallback, useEffect, useState } from "react";
import { projectAnalytics, projectAnalyticsLive, projectDeployments } from "../lib/codeAgentApi.js";
import { formatNumber } from "../manage/shared.jsx";
import { relativeTime } from "./publishLifecycle.js";

const RANGES = [
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
  { days: 365, label: "12 months" },
];

const ms = (value) => (value == null ? "—" : value >= 1000 ? `${(value / 1000).toFixed(2)}s` : `${value}ms`);

// Good/needs-work/poor thresholds are Google's published Core Web Vitals bands.
const VITALS = [
  { key: "lcpMs", label: "LCP", hint: "Largest Contentful Paint", good: 2500, poor: 4000, format: ms },
  { key: "fcpMs", label: "FCP", hint: "First Contentful Paint", good: 1800, poor: 3000, format: ms },
  { key: "inpMs", label: "INP", hint: "Interaction to Next Paint", good: 200, poor: 500, format: ms },
  { key: "ttfbMs", label: "TTFB", hint: "Time To First Byte", good: 800, poor: 1800, format: ms },
  { key: "cls", label: "CLS", hint: "Cumulative Layout Shift", good: 0.1, poor: 0.25, format: (v) => (v == null ? "—" : v.toFixed(3)) },
];

function band(value, good, poor) {
  if (value == null) return "none";
  return value <= good ? "good" : value <= poor ? "warn" : "bad";
}

function Trend({ series }) {
  if (!series.length) return <div className="ct-hint">No traffic yet in this period.</div>;
  const max = Math.max(1, ...series.map((d) => d.pageviews));
  const width = 100;
  const step = series.length > 1 ? width / (series.length - 1) : width;
  const line = series.map((d, i) => `${(i * step).toFixed(2)},${(30 - (d.pageviews / max) * 28).toFixed(2)}`).join(" ");
  return (
    <div className="ct-chart">
      <svg viewBox={`0 0 ${width} 30`} preserveAspectRatio="none" role="img"
        aria-label={`Page views over ${series.length} days, peak ${max}`}>
        <polyline className="ct-chart-line" points={line} />
        <polygon className="ct-chart-fill" points={`0,30 ${line} ${width},30`} />
      </svg>
      <div className="ct-chart-axis">
        <span>{series[0].day}</span><span>{series[series.length - 1].day}</span>
      </div>
    </div>
  );
}

function Ranked({ title, rows, empty }) {
  const max = Math.max(1, ...rows.map((r) => r.pageviews));
  return (
    <div className="ct-rank">
      <div className="mg-label" style={{ marginTop: 0 }}>{title}</div>
      {!rows.length && <div className="ct-hint">{empty}</div>}
      {rows.map((r) => (
        <div className="ct-rank-row" key={r.key}>
          <span className="ct-rank-bar" style={{ width: `${(r.pageviews / max) * 100}%` }} aria-hidden="true" />
          <span className="ct-rank-key">{r.key}</span>
          <span className="ct-rank-n">{formatNumber(r.pageviews)}</span>
        </div>
      ))}
    </div>
  );
}

export default function AnalyticsView({ site, onClose, onUpgrade , embedded = false }) {
  const [days, setDays] = useState(30);
  const [data, setData] = useState(null);
  const [live, setLive] = useState(null);
  const [deploys, setDeploys] = useState(null);
  const [error, setError] = useState("");
  const projectId = site?.projectId;

  const load = useCallback(async () => {
    if (!projectId) return;
    try {
      const [overview, deployments] = await Promise.all([
        projectAnalytics(projectId, days),
        projectDeployments(projectId),
      ]);
      setData(overview);
      setDeploys(deployments);
    } catch (e) {
      setError(e.message || "Analytics is unavailable right now.");
    }
  }, [projectId, days]);

  useEffect(() => { load(); }, [load]);

  // Live visitors are only meaningful if they keep up.
  useEffect(() => {
    if (!projectId) return undefined;
    const tick = () => projectAnalyticsLive(projectId).then(setLive).catch(() => {});
    tick();
    const timer = setInterval(tick, 20_000);
    return () => clearInterval(timer);
  }, [projectId]);

  const caps = data?.capabilities;
  const totals = data?.totals;

    // Rendered bare when embedded: the project dashboard supplies the sheet, heading and Done
  // button, and nesting a second one inside it would mean two scroll areas and two close buttons.
  const body = (
    <>
        {error && <div className="mg-error">{error}</div>}

        <div className="ct-ws-tabs" role="group" aria-label="Date range">
          {RANGES.map((r) => {
            // A range the plan cannot see is shown but disabled, so the limit is legible rather
            // than the option simply missing.
            const locked = caps?.retentionDays != null && r.days > caps.retentionDays;
            return (
              <button key={r.days} className={`ct-ws-tab ${days === r.days ? "on" : ""}`}
                disabled={locked} title={locked ? `Your plan keeps ${caps.retentionDays} days` : undefined}
                onClick={() => setDays(r.days)}>
                {r.label}{locked && " 🔒"}
              </button>
            );
          })}
          {live && (
            <span className="ct-livedot" title={`Visitors in the last ${live.windowMinutes} minutes`}>
              <span className="dot" aria-hidden="true" />{live.live} online
            </span>
          )}
        </div>

        {!data && !error && <div className="mg-card"><div className="ct-hint">Loading…</div></div>}

        {data?.unavailable === "not_published" && (
          <div className="mg-card"><div className="ct-hint">
            Analytics starts collecting the moment this project is published.
          </div></div>
        )}

        {totals && (
          <>
            <div className="ct-metrics">
              <div><span className="v">{formatNumber(totals.visitors)}</span><span className="k">Unique visitors</span></div>
              <div><span className="v">{formatNumber(totals.pageviews)}</span><span className="k">Page views</span></div>
              <div><span className="v">{formatNumber(totals.sessions)}</span><span className="k">Sessions</span></div>
              <div><span className="v">{formatNumber(totals.errors)}</span><span className="k">Errors</span></div>
            </div>
            {data.window?.clamped && (
              <div className="ct-hint">
                Showing {data.window.days} days — your plan keeps {caps.retentionDays}.{" "}
                <button className="ct-linkish" onClick={onUpgrade}>See plans</button>
              </div>
            )}

            <div className="mg-label">Traffic</div>
            <div className="mg-card"><Trend series={data.series} /></div>

            <div className="ct-rank-grid">
              <Ranked title="Top pages" rows={data.topPages} empty="No page views yet." />
              <Ranked title="Referrers" rows={data.referrers} empty="No referrers yet." />
            </div>

            {caps?.fullAnalytics ? (
              <div className="ct-rank-grid">
                <Ranked title="Browsers" rows={data.browsers} empty="No data yet." />
                <Ranked title="Operating systems" rows={data.operatingSystems} empty="No data yet." />
                <Ranked title="Devices" rows={data.devices} empty="No data yet." />
              </div>
            ) : (
              <div className="mg-card">
                <div className="ct-hint">
                  Browser, operating system and device breakdowns are included on Starter and Pro.{" "}
                  <button className="ct-linkish" onClick={onUpgrade}>See plans</button>
                </div>
              </div>
            )}

            <div className="mg-label">Performance</div>
            <div className="mg-card">
              {data.vitals ? (
                <>
                  <div className="ct-vitals">
                    {VITALS.map((v) => {
                      const value = data.vitals[v.key];
                      return (
                        <div className={`ct-vital band-${band(value, v.good, v.poor)}`} key={v.key} title={v.hint}>
                          <span className="v">{v.format(value)}</span>
                          <span className="k">{v.label}</span>
                        </div>
                      );
                    })}
                  </div>
                  <div className="ct-hint">
                    Measured on real visits ({formatNumber(data.vitals.samples)} samples), not a lab test.
                  </div>
                </>
              ) : (
                <div className="ct-hint">Performance data appears after your site has real visitors.</div>
              )}
            </div>
          </>
        )}

        <div className="mg-label">Deployments</div>
        <div className="mg-card">
          {!deploys && <div className="ct-hint">Loading…</div>}
          {deploys?.site && (
            <div className="ct-hint" style={{ marginBottom: 8 }}>
              First published {relativeTime(deploys.site.firstPublishedAt)} · last{" "}
              {relativeTime(deploys.site.lastPublishedAt)}
              {deploys.summary.averageDurationMs
                ? ` · average build ${Math.round(deploys.summary.averageDurationMs / 1000)}s` : ""}
            </div>
          )}
          {deploys?.builds?.length === 0 && <div className="ct-hint">No builds recorded yet.</div>}
          {deploys?.builds?.map((b) => (
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
            </div>
          ))}
          {deploys?.truncated && (
            <div className="ct-hint">
              Showing recent deployments. Full build history is included on Starter and Pro.{" "}
              <button className="ct-linkish" onClick={onUpgrade}>See plans</button>
            </div>
          )}
        </div>

        <div className="ct-hint" style={{ marginTop: 14 }}>
          Thrallo Analytics is cookieless. Visitors are counted with a hash that is regenerated
          daily and cannot be linked across days or across sites, so no consent banner is required.
        </div>
      </>
  );

  if (embedded) return body;
  return (
    <aside className="ct-sheet show ct-analytics" aria-label="Analytics">
      <div className="ct-sheet-head"><h2>Analytics</h2>
        <button className="ct-btn-quiet" onClick={onClose}>Done</button></div>
      <div className="ct-sheet-body">{body}</div>
    </aside>
  );
}
