// Project logs.
//
// The three things that make a log viewer usable rather than a wall of text: you can find one
// line, you can stop it moving while you read, and you can take it with you. Everything here is in
// service of those.

import React, { useCallback, useEffect, useRef, useState } from "react";

import { projectLogs, logStreamUrl, exportLogs, projectBuildRuns } from "../lib/codeAgentApi.js";
import { TabSkeleton, TabError } from "./TabStates.jsx";
import { useDebounced } from "../lib/useDebounced.js";
import { LOG_LEVELS as LEVELS, LOG_SOURCES as SOURCES } from "../../../shared/logSources.mjs";
import { LIVE_LIMIT, trimEntries } from "./logWindow.js";

const stamp = (iso) => new Date(iso).toLocaleString("en-GB", {
  day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "UTC",
});

function Row({ entry }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  return (
    <div className={`ct-log lvl-${entry.level}`}>
      <button className="ct-log-head" onClick={() => entry.detail && setOpen((v) => !v)}
        aria-expanded={open} title={entry.detail ? "Show detail" : undefined}>
        <span className="ct-log-time">{stamp(entry.at)}</span>
        <span className={`ct-log-level lvl-${entry.level}`}>{entry.level.toUpperCase()}</span>
        <span className="ct-log-source">{entry.source}</span>
        <span className="ct-log-msg">{entry.message}</span>
        {entry.durationMs != null && <span className="ct-log-dur">{Math.round(entry.durationMs / 100) / 10}s</span>}
      </button>
      {open && entry.detail && <pre className="ct-log-detail">{entry.detail}</pre>}
      <button className="ct-log-copy" title="Copy this entry"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(
              `${entry.at} [${entry.level.toUpperCase()}] ${entry.source}: ${entry.message}${entry.detail ? `\n${entry.detail}` : ""}`,
            );
            setCopied(true);
            setTimeout(() => setCopied(false), 1_500);
          } catch { setCopied(false); }
        }}>
        {copied ? "✓" : "⧉"}
      </button>
    </div>
  );
}

const RUN_STATUS = {
  passed: "Succeeded",
  failed: "Failed",
  cancelled: "Cancelled",
  interrupted: "Interrupted",
  running: "Running",
};

export default function LogsView({ site, buildRef = null, onSelectBuild = null }) {
  const [entries, setEntries] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [levels, setLevels] = useState([]);
  const [sources, setSources] = useState([]);
  const [search, setSearch] = useState("");
  // Undebounced, every keystroke refetched the page AND reopened the live stream.
  const settledSearch = useDebounced(search, 300);
  const [live, setLive] = useState(true);
  const [loading, setLoading] = useState(false);
  const [meta, setMeta] = useState(null);
  const [error, setError] = useState("");
  const [runs, setRuns] = useState([]);
  const [runsLoaded, setRunsLoaded] = useState(false);
  const [exporting, setExporting] = useState("");
  const seen = useRef(new Set());
  const projectId = site?.projectId;

  const params = useCallback(() => ({
    levels: levels.join(","), sources: sources.join(","), q: settledSearch,
    // The build identifier goes to the server, so paging, streaming and export all stay narrowed
    // to the same run rather than the filter applying to the view alone.
    ref: buildRef || "",
  }), [levels, sources, settledSearch, buildRef]);

  // The project's builds, so a specific one can be opened and linked to. Same identity as
  // Deployments and Overview: the run id.
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    projectBuildRuns(projectId)
      .then((result) => { if (!cancelled) setRuns(result.runs || []); })
      .catch(() => { if (!cancelled) setRuns([]); })
      .finally(() => { if (!cancelled) setRunsLoaded(true); });
    return () => { cancelled = true; };
  }, [projectId]);

  const selectedRun = runs.find((r) => r.id === buildRef) || null;

  const load = useCallback(async (before = null) => {
    if (!projectId) return;
    setLoading(true);
    try {
      const result = await projectLogs(projectId, { ...params(), before });
      setMeta({ retentionDays: result.retentionDays, plan: result.plan });
      setCursor(result.nextCursor);
      setEntries((current) => {
        const base = before ? current : [];
        if (!before) seen.current = new Set();
        const fresh = result.entries.filter((e) => !seen.current.has(e.id));
        fresh.forEach((e) => seen.current.add(e.id));
        return [...base, ...fresh];
      });
      setError("");
    } catch (e) {
      setError(e.message || "Logs are unavailable right now.");
    } finally {
      setLoading(false);
    }
  }, [projectId, params]);

  // Filters restart the list; paging appends to it.
  useEffect(() => { load(null); }, [load]);

  // Live streaming. Paused means paused — the connection closes, so nothing accumulates behind
  // the scenes and jumps in when you resume.
  useEffect(() => {
    if (!live || !projectId) return undefined;
    const source = new EventSource(logStreamUrl(projectId, params()));
    source.addEventListener("log", (event) => {
      try {
        const entry = JSON.parse(event.data);
        if (seen.current.has(entry.id)) return;
        seen.current.add(entry.id);
        // Bounded. Both the rendered list and the dedupe Set grew without limit while Live was on,
        // so a busy site left on this tab rendered an ever-longer list and held every id it had
        // ever seen. "Load older" is how you reach what falls off the end.
        setEntries((current) => trimEntries([entry, ...current], seen.current, LIVE_LIMIT));
      } catch { /* a malformed frame is not worth surfacing */ }
    });
    source.onerror = () => { /* EventSource reconnects on its own */ };
    return () => source.close();
  }, [live, projectId, params]);

  const toggle = (list, setList, id) =>
    setList(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

  return (
    <div className="ct-logs">
      <div className="ct-logs-bar">
        <input className="ct-domain-input ct-log-search" value={search} placeholder="Search logs…"
          aria-label="Search logs" onChange={(e) => setSearch(e.target.value)} />
        <button className={`ct-pubrow-btn ${live ? "accent" : ""}`} onClick={() => setLive((v) => !v)}>
          {live ? "⏸ Pause" : "▶ Live"}
        </button>
        {/* Buttons, not links: a link carries no Authorization header, so these were saving a
            401 JSON body under a .csv name. */}
        {["json", "csv"].map((format) => (
          <button key={format} className="ct-pubrow-btn" disabled={!!exporting}
            onClick={async () => {
              setExporting(format); setError("");
              try { await exportLogs(projectId, { ...params(), format }); }
              catch (e) { setError(e.message || "That export could not be prepared."); }
              finally { setExporting(""); }
            }}>
            {exporting === format ? "…" : format.toUpperCase()}
          </button>
        ))}
      </div>

      {/* Builds. Selecting one narrows every source to that run and puts it in the URL, so the
          view can be linked to, refreshed and navigated back out of. */}
      {runs.length > 0 && (
        <div className="ct-logs-builds">
          <button className={`ct-chipfilter ${buildRef ? "" : "on"}`} aria-pressed={!buildRef}
            onClick={() => onSelectBuild?.(null)}>All activity</button>
          {runs.slice(0, 12).map((run) => (
            <button key={run.id} className={`ct-chipfilter bd-${run.status} ${buildRef === run.id ? "on" : ""}`}
              aria-pressed={buildRef === run.id} title={`${RUN_STATUS[run.status] || run.status} · ${stamp(run.startedAt)}`}
              onClick={() => onSelectBuild?.(run.id)}>
              {RUN_STATUS[run.status] || run.status} · {stamp(run.startedAt)}
            </button>
          ))}
        </div>
      )}

      {selectedRun && (
        <div className="ct-hint ct-logs-scope">
          Showing one build — {RUN_STATUS[selectedRun.status] || selectedRun.status}
          {selectedRun.durationMs != null && `, ${Math.round(selectedRun.durationMs / 1000)}s`}
          {" · "}
          <button className="ct-linkish" onClick={() => onSelectBuild?.(null)}>show all activity</button>
        </div>
      )}

      <div className="ct-logs-filters">
        {LEVELS.map((l) => (
          <button key={l.id} className={`ct-chipfilter lvl-${l.id} ${levels.includes(l.id) ? "on" : ""}`}
            aria-pressed={levels.includes(l.id)} onClick={() => toggle(levels, setLevels, l.id)}>
            {l.label}
          </button>
        ))}
        <span className="ct-logs-sep" aria-hidden="true" />
        {SOURCES.map((s) => (
          <button key={s.id} className={`ct-chipfilter ${sources.includes(s.id) ? "on" : ""}`}
            aria-pressed={sources.includes(s.id)} onClick={() => toggle(sources, setSources, s.id)}>
            {s.label}
          </button>
        ))}
      </div>

      {error && <TabError message={error} onRetry={() => load(null)} />}

      <div className="ct-logs-list">
        {/* The first load showed nothing at all — an empty list that had not been fetched yet is
            indistinguishable from a project with no logs, which is the distinction this whole view
            exists to make. */}
        {!entries.length && loading && !error && <TabSkeleton rows={4} label="Loading logs" />}
        {entries.map((entry) => <Row entry={entry} key={entry.id} />)}
        {/* An empty log has several distinct causes and they need different sentences. "No entries"
            for a project that has never been built reads as a fault; saying which case this is
            tells the user whether to act or wait. */}
        {!entries.length && !loading && !error && (
          <div className="ct-logs-empty">
            {(() => {
              const filtering = !!(settledSearch || levels.length || sources.length);
              if (filtering) {
                return (
                  <>
                    <strong>Nothing matches those filters.</strong>
                    <span className="ct-hint">Clear the search or the level and source chips to see everything again.</span>
                  </>
                );
              }
              // Checked before the per-build cases: with no builds at all, "this build recorded no
              // steps" would be answering a question about a build that never existed.
              if (runsLoaded && !runs.length) {
                return (
                  <>
                    <strong>Nothing has happened here yet.</strong>
                    <span className="ct-hint">
                      This project has not been built or published. Build steps, publishes,
                      deployments, domain changes and errors from real visitors all appear here as
                      soon as there are any.
                    </span>
                  </>
                );
              }
              // A link to a build that no longer exists. Logs age out on the plan's retention, so
              // an old bookmark is expected rather than broken — saying which it is prevents a
              // purged build from reading as a fault.
              if (buildRef && runsLoaded && !selectedRun) {
                return (
                  <>
                    <strong>That build is no longer available.</strong>
                    <span className="ct-hint">
                      {meta?.retentionDays != null
                        ? `Builds are kept for ${meta.retentionDays} days on your plan, and this one is older than that.`
                        : "It may have been removed with its project."}
                      {" "}
                      <button className="ct-linkish" onClick={() => onSelectBuild?.(null)}>See all activity</button>
                    </span>
                  </>
                );
              }
              if (buildRef) {
                return (
                  <>
                    <strong>This build recorded no steps.</strong>
                    <span className="ct-hint">
                      {selectedRun?.status === "interrupted"
                        ? "It was interrupted before it could log anything — usually a restart mid-build."
                        : selectedRun?.status === "cancelled"
                          ? "It was cancelled before any step was written."
                          : "It ended before any step was written."}
                      {" "}
                      <button className="ct-linkish" onClick={() => onSelectBuild?.(null)}>See all activity</button>
                    </span>
                  </>
                );
              }
              return (
                <>
                  <strong>No entries in this window.</strong>
                  <span className="ct-hint">
                    {meta?.retentionDays != null
                      ? `Your plan keeps ${meta.retentionDays} days of logs, and nothing was recorded in that period.`
                      : "Nothing was recorded in this period."}
                  </span>
                </>
              );
            })()}
          </div>
        )}
      </div>

      <div className="ct-logs-foot">
        {cursor && (
          <button className="ct-pubrow-btn" disabled={loading} onClick={() => load(cursor)}>
            {loading ? "Loading…" : "Load older"}
          </button>
        )}
        {meta?.retentionDays != null && (
          <span className="ct-hint">Your plan keeps {meta.retentionDays} days of logs.</span>
        )}
      </div>
    </div>
  );
}
