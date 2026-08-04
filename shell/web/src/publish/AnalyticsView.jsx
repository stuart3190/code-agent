// Thrallo Analytics for one published project.
//
// Charts are inline SVG rather than a charting library: the whole view needs a trend line and a
// set of ranked bars, and pulling in a dependency for that would cost more than it is worth on
// every page load of the shell.
//
// Numbers shown here are cookieless by construction — a "visitor" is a daily-rotating hash that
// cannot be linked across days, which is stated in the UI because it is a feature, not a caveat.

import React, { useCallback, useEffect, useState } from "react";
import { projectAnalytics, projectAnalyticsLive, exportAnalytics } from "../lib/codeAgentApi.js";
import { formatNumber } from "../manage/shared.jsx";
import { TabSkeleton, TabError } from "./TabStates.jsx";

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

// Every metric that was collected, not page views alone. A trend that plots one of four numbers
// makes the other three look like they were never measured.
const METRICS = [
  { key: "pageviews", label: "Page views" },
  { key: "visitors", label: "Visitors" },
  { key: "sessions", label: "Sessions" },
  { key: "errors", label: "Errors", requires: "errorReporting" },
];

function Trend({ series, metric, onMetric, caps }) {
  const available = METRICS.filter((m) => !m.requires || caps?.[m.requires]);
  if (!series.length) {
    return (
      <div className="ct-hint">
        Nothing was recorded in this period. That is not the same as zero traffic on a day the site
        was not yet published — days before the first publish are not shown at all.
      </div>
    );
  }
  const values = series.map((d) => d[metric] ?? 0);
  const max = Math.max(1, ...values);
  const width = 100;
  const step = series.length > 1 ? width / (series.length - 1) : width;
  const line = values.map((v, i) => `${(i * step).toFixed(2)},${(30 - (v / max) * 28).toFixed(2)}`).join(" ");
  const label = available.find((m) => m.key === metric)?.label || metric;
  return (
    <>
      <div className="ct-trend-tabs" role="group" aria-label="Trend metric">
        {available.map((m) => (
          <button key={m.key} className={`ct-chipfilter ${metric === m.key ? "on" : ""}`}
            aria-pressed={metric === m.key} onClick={() => onMetric(m.key)}>{m.label}</button>
        ))}
      </div>
      <div className="ct-chart">
        <svg viewBox={`0 0 ${width} 30`} preserveAspectRatio="none" role="img"
          aria-label={`${label} over ${series.length} days, peak ${max}`}>
          <polyline className="ct-chart-line" points={line} />
          <polygon className="ct-chart-fill" points={`0,30 ${line} ${width},30`} />
        </svg>
        <div className="ct-chart-axis">
          <span>{series[0].day}</span><span>{series[series.length - 1].day}</span>
        </div>
      </div>
    </>
  );
}

// Change against the immediately preceding period of equal length. Silent when there is nothing to
// compare against — "+∞%" from a period with no data is not a fact anyone can use.
function Delta({ value }) {
  if (value == null) return null;
  const rounded = Math.round(value * 10) / 10;
  if (rounded === 0) return <span className="ct-delta flat">no change</span>;
  return (
    <span className={`ct-delta ${rounded > 0 ? "up" : "down"}`}>
      {rounded > 0 ? "▲" : "▼"} {Math.abs(rounded)}%
    </span>
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
  const [error, setError] = useState("");
  const [metric, setMetric] = useState("pageviews");
  const [exporting, setExporting] = useState("");
  const projectId = site?.projectId;

  const load = useCallback(async () => {
    if (!projectId) return;
    try {
      // Deployments used to be fetched and rendered here too. That is the Deployments tab's job,
      // and two surfaces reading the same history is how they come to disagree.
      setData(await projectAnalytics(projectId, days));
      setError("");
    } catch (e) {
      setError(e.message || "Analytics is unavailable right now.");
    }
  }, [projectId, days]);

  async function runExport(format) {
    setExporting(format); setError("");
    try {
      await exportAnalytics(projectId, { days, format });
    } catch (e) {
      // A real message beats a zero-byte file.
      setError(e.message || "That export could not be prepared.");
    } finally {
      setExporting("");
    }
  }

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
        {error && <TabError message={error} onRetry={load} />}

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
          {/* Buttons, not links: every API route authenticates from the Authorization header, and
              a bare link sends none. Export covers the whole selected range, not the page. */}
          {caps?.export && (
            <span className="ct-export-actions">
              <button className="ct-pubrow-btn" disabled={exporting}
                onClick={() => runExport("json")}>{exporting === "json" ? "…" : "JSON"}</button>
              <button className="ct-pubrow-btn" disabled={exporting}
                onClick={() => runExport("csv")}>{exporting === "csv" ? "…" : "CSV"}</button>
            </span>
          )}
        </div>

        {!data && !error && <TabSkeleton rows={3} metrics label="Loading analytics" />}

        {data?.unavailable === "not_published" && (
          <div className="mg-card"><div className="ct-hint">
            <strong>Nothing is being measured yet.</strong> Analytics starts the moment this project
            is published — the script is added for you, there is nothing to install, and no cookie
            banner is needed because visitors are counted without cookies.
          </div></div>
        )}

        {/* Published, but nobody has been yet. A different sentence from "not published", because
            it is a different situation with a different next action: the site works, it just has
            no audience. Zero here is a real measurement, not a gap. */}
        {totals && totals.visitors === 0 && totals.pageviews === 0 && (
          <div className="mg-card"><div className="ct-hint">
            <strong>No visits recorded in this period.</strong> The site is live and being measured —
            this is a real zero, not missing data. Share the address and visits appear here within
            about a minute of the first one.
          </div></div>
        )}

        {totals && (
          <>
            <div className="ct-metrics">
              <div>
                <span className="v">{formatNumber(totals.visitors)}</span>
                <span className="k">Unique visitors <Delta value={data.change?.visitors} /></span>
              </div>
              <div>
                <span className="v">{formatNumber(totals.pageviews)}</span>
                <span className="k">Page views <Delta value={data.change?.pageviews} /></span>
              </div>
              <div>
                <span className="v">{formatNumber(totals.sessions)}</span>
                <span className="k">Sessions <Delta value={data.change?.sessions} /></span>
              </div>
              {/* Errors are a paid feature. Free sees the lock, not a number it was told it does
                  not get — and never a zero standing in for "unavailable". */}
              {caps?.errorReporting ? (
                <div>
                  <span className="v">{formatNumber(totals.errors)}</span>
                  <span className="k">Errors <Delta value={data.change?.errors} /></span>
                </div>
              ) : (
                <div>
                  <span className="v">🔒</span>
                  <span className="k">Errors on Starter</span>
                </div>
              )}
            </div>

            <div className="ct-hint">
              {data.window?.clamped && (
                <>
                  Showing {data.window.days} days — your plan keeps {caps.retentionDays}.{" "}
                  <button className="ct-linkish" onClick={onUpgrade}>See plans</button>{" · "}
                </>
              )}
              {data.window?.comparable
                ? `Compared with the ${data.window.days} days before ${data.window.from}.`
                : "There is not enough history on your plan to compare with the previous period."}
            </div>

            <div className="mg-label">Traffic</div>
            <div className="mg-card">
              <Trend series={data.series} metric={metric} onMetric={setMetric} caps={caps} />
            </div>

            <div className="ct-metrics">
              <div>
                <span className="v">{formatNumber(data.sameDayReturning?.visitors || 0)}</span>
                {/* Deliberately NOT "returning visitors". The hash rotates daily and the salts are
                    destroyed, so cross-day identity does not exist and claiming it would be a lie
                    about the privacy model this product is sold on. */}
                <span className="k">Same-day returning</span>
              </div>
              <div>
                <span className="v">{live ? formatNumber(live.live) : "—"}</span>
                <span className="k">Online now</span>
              </div>
            </div>
            <div className="ct-hint">
              Same-day returning counts visitors with more than one session on the same day.
              Cross-day visitor identity is deliberately not tracked.
            </div>

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

        {/* Errors, kept as aggregates so they outlive the three-day raw-event prune. The count
            alone used to survive, which meant "14 errors last month" could never be investigated. */}
        {totals && caps?.errorReporting && (
          <>
            <div className="mg-label">Errors</div>
            <div className="mg-card">
              {!data.errors?.length && <div className="ct-hint">No errors recorded in this period.</div>}
              {data.errors?.map((e) => (
                <div className="mg-row" key={e.key}>
                  <div className="ct-error-row">
                    <span className="ct-error-msg">{e.key}</span>
                    <span className="ct-hint">
                      {formatNumber(e.errors)} occurrence{e.errors === 1 ? "" : "s"}
                      {" · "}{formatNumber(e.visitors)} visitor{e.visitors === 1 ? "" : "s"} affected
                    </span>
                  </div>
                </div>
              ))}
              {data.errors?.length > 0 && (
                <div className="ct-hint">
                  Messages are scrubbed of tokens, keys, emails and addresses before they are stored.
                </div>
              )}
            </div>
          </>
        )}

        {/* Countries. Unavailable is stated, never inferred: guessing a country from language or
            timezone would present a guess as a fact. */}
        <div className="mg-label">Countries</div>
        <div className="mg-card">
          <div className="ct-hint">
            Country reporting is not available yet — it needs a MaxMind GeoLite2 licence, and
            Thrallo will resolve country at ingest and store only the country, never the address.
            It is deliberately not guessed from browser language or timezone.
          </div>
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
