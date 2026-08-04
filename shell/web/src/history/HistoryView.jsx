// History: what you asked for, and what came back.
//
// Every row is a real build read from `diag_runs` — the record the build already wrote — joined to
// the deployment it produced and the checkpoints it kept. Nothing here is a second copy of the
// truth, so a row cannot disagree with the Deployments tab about what happened.
//
// The reuse actions are deliberately precise about what they do:
//
//   Copy prompt   puts the text on the clipboard and changes nothing.
//   Use again     starts a NEW build from the same words. It is not a rollback and never says it
//                 is: the old build, its logs and its deployment are untouched.
//   Edit & rebuild is Use again with the prompt open for changes first, which is what people
//                 usually actually want.
//
// Restoring a checkpoint lives on the project's Deployments tab, where rollback already exists
// with its own confirmation and its own "the live site is unchanged" statement. Pointing at it
// beats building a second restore path that could disagree with the first.

import React, { useCallback, useEffect, useState } from "react";
import { listHistory } from "../lib/codeAgentApi.js";
import { SkeletonRows, useCopy } from "../manage/shared.jsx";
import { useDebounced } from "../lib/useDebounced.js";
import { relativeTime } from "../publish/publishLifecycle.js";

const STATUS = {
  passed: { label: "Succeeded", tone: "live" },
  failed: { label: "Failed", tone: "bad" },
  running: { label: "Running", tone: "update" },
  cancelled: { label: "Cancelled", tone: "muted" },
  interrupted: { label: "Interrupted", tone: "muted" },
};

const duration = (ms) => (ms == null ? null
  : ms >= 60_000 ? `${Math.round(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`
    : `${Math.max(1, Math.round(ms / 1000))}s`);

export default function HistoryView({ onUseAgain, onOpenConversation, onOpenDeployment, onOpenLogs, showToast }) {
  const [items, setItems] = useState(null);   // null = loading
  const [page, setPage] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState("");
  const settled = useDebounced(search, 300);
  const [copied, copy] = useCopy();

  const load = useCallback(async ({ offset = 0, append = false } = {}) => {
    setBusy(true);
    try {
      const result = await listHistory({ offset, q: settled.trim() });
      setItems((current) => (append ? [...(current || []), ...result.items] : result.items));
      setPage(result.page);
      setError("");
    } catch (e) {
      // A failed load is not an empty history — said plainly, because "you have never built
      // anything" is an alarming way to report a network error.
      setError(e.message || "Your history could not be loaded.");
      if (!append) setItems(null);
    } finally { setBusy(false); }
  }, [settled]);

  useEffect(() => { load({ offset: 0 }); }, [load]);

  return (
    <div className="st-tab hs-view">
      <div className="st-headline">
        <div>
          <div className="st-headline-plan">History</div>
          <div className="ct-hint">Every build you have asked for, and what it produced.</div>
        </div>
        <input className="mg-input hs-search" value={search} placeholder="Search your prompts…"
          aria-label="Search your prompts" onChange={(e) => setSearch(e.target.value)} />
      </div>

      {error && (
        <div className="mg-error">
          {error} <button className="ct-linkish" onClick={() => load({ offset: 0 })}>Try again</button>
        </div>
      )}

      {items === null && !error && <SkeletonRows rows={4} />}

      {items !== null && !items.length && (
        <div className="st-empty">
          {settled.trim()
            ? <>Nothing you have built matches “{settled.trim()}”. Try a word from the original request.</>
            : <>
                Nothing here yet. Every build you start is recorded — the words you used, the model,
                what it produced and where it went — so you can come back, copy a prompt or run it
                again. Describe something in the composer and this fills in.
              </>}
        </div>
      )}

      <div className="hs-list">
        {(items || []).map((item) => {
          const status = STATUS[item.status] || { label: item.status, tone: "muted" };
          return (
            <div className="hs-item" key={item.id}>
              <div className="hs-item-head">
                <span className={`ct-badge tone-${status.tone}`}>{status.label}</span>
                {/* The model is shown only when the record has one — a build that predates model
                    recording must not be labelled with a guess. */}
                {item.model && <span className="ct-hint hs-model">{item.model}</span>}
                <span className="ct-hint">{relativeTime(item.startedAt)}</span>
                {duration(item.durationMs) && <span className="ct-hint">· {duration(item.durationMs)}</span>}
                {item.repairRounds > 0 && (
                  <span className="ct-hint">· {item.repairRounds} repair{item.repairRounds === 1 ? "" : "s"}</span>
                )}
              </div>

              {/* The customer's own words, marked as theirs. Agent activity is not mixed into this
                  list: the thread and the logs are where that lives. */}
              <blockquote className="hs-prompt">
                {item.prompt || <span className="ct-hint">This build recorded no prompt text.</span>}
              </blockquote>

              <div className="hs-item-facts">
                {item.conversationTitle && (
                  <button className="ct-linkish" onClick={() => onOpenConversation(item.conversationId)}>
                    {item.conversationTitle}
                  </button>
                )}
                {item.deployment && (
                  <button className="ct-linkish" onClick={() => onOpenDeployment(item.deployment)}>
                    Deployment #{item.deployment.number}
                  </button>
                )}
                {item.checkpoints > 0 && (
                  <span className="ct-hint">{item.checkpoints} checkpoint{item.checkpoints === 1 ? "" : "s"}</span>
                )}
              </div>

              <div className="hs-item-actions">
                {item.prompt && (
                  <button className="ct-pubrow-btn" onClick={() => { copy(item.prompt); showToast?.("Prompt copied."); }}>
                    {copied ? "Copied ✓" : "Copy prompt"}
                  </button>
                )}
                {item.prompt && (
                  <>
                    {/* Named for what they do. Neither is a rollback, and neither touches this row. */}
                    <button className="ct-pubrow-btn" onClick={() => onUseAgain(item.prompt, { edit: false })}>
                      Use again
                    </button>
                    <button className="ct-pubrow-btn" onClick={() => onUseAgain(item.prompt, { edit: true })}>
                      Edit &amp; rebuild
                    </button>
                  </>
                )}
                {item.projectId && (
                  <button className="ct-pubrow-btn" onClick={() => onOpenLogs(item)}>View build</button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {page?.nextOffset != null && (
        <button className="ct-ws-more" disabled={busy}
          onClick={() => load({ offset: page.nextOffset, append: true })}>
          {busy ? "Loading…" : `Load more (${page.total - (items?.length || 0)} more)`}
        </button>
      )}
      {page && page.total > 0 && page.nextOffset == null && page.total > page.limit && (
        <div className="ct-hint hs-all">All {page.total} builds shown.</div>
      )}
    </div>
  );
}
