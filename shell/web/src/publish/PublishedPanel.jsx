// The published state of a project, shown in its conversation.
//
// Publishing used to end with a line in the thread that scrolled away. The panel persists: the
// question "is my app actually live, and is what's live current?" is answerable at a glance for as
// long as the project exists, not just in the seconds after a publish.

import React, { useState } from "react";
import { relativeTime, displayUrl } from "./publishState.js";

export default function PublishedPanel({ site, celebrate = false, onPublishUpdate, onOpenSettings }) {
  const [copied, setCopied] = useState(false);
  if (!site) return null;

  const stale = site.updateAvailable;

  async function copy() {
    try {
      await navigator.clipboard.writeText(site.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2_000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <section className={`ct-published ${celebrate ? "celebrate" : ""}`} aria-label="Published site">
      {celebrate && <div className="ct-published-cheer">🎉 Your app is live.</div>}

      <div className="ct-published-head">
        <span className={`ct-published-badge ${stale ? "stale" : ""}`}>
          <span className="dot" aria-hidden="true" />
          {stale ? "Update Available" : "Published"}
        </span>
        <span className="ct-published-env">Production</span>
      </div>

      <a className="ct-published-url" href={site.url} target="_blank" rel="noopener noreferrer">
        {displayUrl(site.url)}
      </a>

      <div className="ct-published-meta">
        Last published {relativeTime(site.publishedAt)}
        {stale && " · this project has changed since then"}
      </div>

      <div className="ct-published-actions">
        <a className="ct-btn" href={site.url} target="_blank" rel="noopener noreferrer">Open Live Site</a>
        <button className="ct-btn-quiet" onClick={copy}>{copied ? "Copied" : "Copy URL"}</button>
        {/* Publishing is a sentence in Thrallo, so this says the sentence rather than inventing a
            second, silent code path that could drift from the conversational one. */}
        <button className={stale ? "ct-btn" : "ct-btn-quiet"} onClick={onPublishUpdate}>Publish Update</button>
        <button className="ct-btn-quiet" onClick={onOpenSettings}>Project Settings</button>
      </div>
    </section>
  );
}
