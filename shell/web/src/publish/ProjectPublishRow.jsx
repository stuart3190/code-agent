// The published details and actions on a dashboard project card.
//
// Only rendered for a project that has a publish record, so a draft card stays exactly as it was.
// Every control here does something real: there are no placeholders.

import React, { useState } from "react";
import { STATUS, displayUrl, relativeTime } from "./publishLifecycle.js";

export default function ProjectPublishRow({ site, status, onPublishUpdate, onUnpublish, onSettings }) {
  const [copied, setCopied] = useState(false);
  if (!site) return null;

  const offline = status === STATUS.unpublished;

  async function copy(event) {
    event.stopPropagation();
    try {
      await navigator.clipboard.writeText(site.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2_000);
    } catch { setCopied(false); }
  }

  // The card itself opens the conversation, so every control here has to stop the click reaching it.
  const act = (run) => (event) => { event.stopPropagation(); run(); };

  return (
    <div className="ct-pubrow" onClick={(e) => e.stopPropagation()}>
      <div className="ct-pubrow-facts">
        {offline ? (
          <span className="ct-pubrow-url offline">{displayUrl(site.url)} · offline</span>
        ) : (
          <a className="ct-pubrow-url" href={site.url} target="_blank" rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}>
            {displayUrl(site.url)}
          </a>
        )}
        <span className="ct-pubrow-meta">
          Production · {offline
            ? `unpublished ${relativeTime(site.unpublishedAt)}`
            : `published ${relativeTime(site.publishedAt)}`}
        </span>
      </div>
      <div className="ct-pubrow-actions">
        {!offline && (
          <>
            <a className="ct-pubrow-btn" href={site.url} target="_blank" rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}>Open Live Site</a>
            <button className="ct-pubrow-btn" onClick={copy}>{copied ? "Copied" : "Copy URL"}</button>
          </>
        )}
        <button className={`ct-pubrow-btn ${status === STATUS.updateAvailable ? "accent" : ""}`}
          onClick={act(onPublishUpdate)}>
          {offline ? "Publish Again" : "Publish Update"}
        </button>
        {!offline && <button className="ct-pubrow-btn" onClick={act(onUnpublish)}>Unpublish</button>}
        <button className="ct-pubrow-btn" onClick={act(onSettings)}>Project Settings</button>
      </div>
    </div>
  );
}
