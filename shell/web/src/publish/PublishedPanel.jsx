// The published state of a project, shown in its conversation.
//
// Publishing used to end with a line in the thread that scrolled away. The panel persists: the
// question "is my app actually live, and is what's live current?" is answerable at a glance for as
// long as the project exists, not just in the seconds after a publish.

import React, { useState } from "react";
import { relativeTime, displayUrl } from "./publishState.js";
import { STATUS } from "./publishLifecycle.js";

export default function PublishedPanel({ site, celebrate = false, onPublishUpdate, onUnpublish, onOpenSettings, onConnectDomain }) {
  const [copied, setCopied] = useState(false);
  if (!site) return null;

  const status = site.status || (site.updateAvailable ? STATUS.updateAvailable : STATUS.published);
  const stale = status === STATUS.updateAvailable;
  const offline = status === STATUS.unpublished;
  // A verified custom domain becomes the address shown; the Thrallo URL stays in Project Settings.
  const address = site.primaryUrl || site.url;

  async function copy() {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 2_000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <section className={`ct-published ${celebrate ? "celebrate" : ""}`} aria-label="Published site">
      {celebrate && <div className="ct-published-cheer">✅ Your app is live</div>}

      <div className="ct-published-head">
        <span className={`ct-badge tone-${status === "published" ? "live" : status === "update_available" ? "update" : "muted"}`}>
          {status === "published" ? "LIVE" : status === "update_available" ? "UPDATE AVAILABLE" : "UNPUBLISHED"}
        </span>
        {stale && <span className="ct-badge tone-live">LIVE</span>}
        <span className="ct-published-env">Production</span>
      </div>

      {offline ? (
        <span className="ct-published-url offline">{displayUrl(address)}</span>
      ) : (
        <a className="ct-published-url" href={address} target="_blank" rel="noopener noreferrer">
          {displayUrl(address)}
        </a>
      )}

      <div className="ct-published-meta">
        {offline
          ? `Taken offline ${relativeTime(site.unpublishedAt)} — publishing again restores this address.`
          : `Last published ${relativeTime(site.publishedAt)}`}
        {stale && " · this project has changed since then"}
      </div>

      <div className="ct-published-actions">
        {!offline && (
          <>
            <a className="ct-btn" href={address} target="_blank" rel="noopener noreferrer">Open Site</a>
            <button className="ct-btn-quiet" onClick={copy}>{copied ? "Copied" : "Copy URL"}</button>
            {/* The natural next step the moment an app goes live, and the point at which someone
                is most likely to want their own address on it. */}
            {!site.customDomain && (
              <button className="ct-btn-quiet" onClick={onConnectDomain || onOpenSettings}>Connect Domain</button>
            )}
          </>
        )}
        {/* Publishing is a sentence in Thrallo, so this says the sentence rather than inventing a
            second, silent code path that could drift from the conversational one. */}
        <button className={stale || offline ? "ct-btn" : "ct-btn-quiet"} onClick={onPublishUpdate}>
          {offline ? "Publish Again" : "Publish Update"}
        </button>
        {!offline && <button className="ct-btn-quiet" onClick={onUnpublish}>Unpublish</button>}
        <button className="ct-btn-quiet" onClick={onOpenSettings}>Project Settings</button>
      </div>
    </section>
  );
}
