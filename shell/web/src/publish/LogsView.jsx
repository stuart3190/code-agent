// Project logs.
//
// The three things that make a log viewer usable rather than a wall of text: you can find one
// line, you can stop it moving while you read, and you can take it with you. Everything here is in
// service of those.

import React, { useCallback, useEffect, useRef, useState } from "react";
import { projectLogs, logStreamUrl, logExportUrl } from "../lib/codeAgentApi.js";

const LEVELS = [
  { id: "info", label: "Info" },
  { id: "warning", label: "Warning" },
  { id: "error", label: "Error" },
  { id: "critical", label: "Critical" },
];
const SOURCES = [
  { id: "publish", label: "Publish" },
  { id: "deploy", label: "Deploy" },
  { id: "build", label: "Build" },
  { id: "runtime", label: "Runtime" },
  { id: "visitor", label: "Visitor" },
  { id: "domain", label: "Domain" },
  { id: "system", label: "System" },
];

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

export default function LogsView({ site }) {
  const [entries, setEntries] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [levels, setLevels] = useState([]);
  const [sources, setSources] = useState([]);
  const [search, setSearch] = useState("");
  const [live, setLive] = useState(true);
  const [loading, setLoading] = useState(false);
  const [meta, setMeta] = useState(null);
  const [error, setError] = useState("");
  const seen = useRef(new Set());
  const projectId = site?.projectId;

  const params = useCallback(() => ({
    levels: levels.join(","), sources: sources.join(","), q: search,
  }), [levels, sources, search]);

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
        setEntries((current) => [entry, ...current]);
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
        <a className="ct-pubrow-btn" href={logExportUrl(projectId, { ...params(), format: "json" })} download>JSON</a>
        <a className="ct-pubrow-btn" href={logExportUrl(projectId, { ...params(), format: "csv" })} download>CSV</a>
      </div>

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

      {error && <div className="mg-error">{error}</div>}

      <div className="ct-logs-list">
        {entries.map((entry) => <Row entry={entry} key={entry.id} />)}
        {!entries.length && !loading && (
          <div className="ct-hint" style={{ padding: 16 }}>
            No log entries match. Publishing, deployments, build steps and errors from real visitors
            all appear here.
          </div>
        )}
      </div>

      <div className="ct-logs-foot">
        {cursor && (
          <button className="ct-btn-quiet" disabled={loading} onClick={() => load(cursor)}>
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
