// The published state of a project, shown in its conversation.
//
// Publishing used to end with a line in the thread that scrolled away. The panel persists: the
// question "is my app actually live, and is what's live current?" is answerable at a glance for as
// long as the project exists, not just in the seconds after a publish.
//
// It has two states. Just after a publish it expands — the version, both timings, and the actions
// someone actually wants in that moment. Then it settles to the resting panel, because this sits
// above every conversation forever and permanent chrome has to earn its place (Principle 3).

import React, { useEffect, useState } from "react";
import { relativeTime, displayUrl } from "./publishLifecycle.js";
import { STATUS } from "./publishLifecycle.js";
import { shareUrl } from "../lib/share.js";

const ms = (value) => (value == null ? null : value < 1000 ? `${value}ms` : `${(value / 1000).toFixed(1)}s`);

// A deployment newer than the one serving means the last publish did not replace it.
const isInFlight = (status) => status === "building" || status === "deploying";

export default function PublishedPanel({
  site, celebrate = false, onPublishUpdate, onUnpublish, onOpenSettings, onConnectDomain,
  onAnalytics, onLogs, onDeployments,
}) {
  const [copied, setCopied] = useState(false);
  const [shared, setShared] = useState("");
  const [more, setMore] = useState(false);
  if (!site) return null;

  const status = site.status || (site.updateAvailable ? STATUS.updateAvailable : STATUS.published);
  const stale = status === STATUS.updateAvailable;
  const offline = status === STATUS.unpublished;
  // A verified custom domain becomes the address shown; the Thrallo URL stays in Project Settings.
  const address = site.primaryUrl || site.url;

  const deployment = site.deployment || null;
  const attempt = site.lastAttempt || null;
  // The last attempt differs from what is serving exactly when a publish failed or is still going
  // out. Comparing numbers rather than ids so a rollback (which IS the newest) reads as serving.
  const newerAttempt = attempt && (!deployment || attempt.number > deployment.number) ? attempt : null;
  const publishing = newerAttempt && isInFlight(newerAttempt.status) ? newerAttempt : null;
  const failedAttempt = newerAttempt && newerAttempt.status === "failed" ? newerAttempt : null;

  async function copy() {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 2_000);
    } catch {
      setCopied(false);
    }
  }

  async function share() {
    try {
      const how = await shareUrl(address, site.name || "My app");
      if (how === "dismissed") return;
      setShared(how === "shared" ? "Shared" : "Copied");
      setTimeout(() => setShared(""), 2_000);
    } catch {
      setShared("");
    }
  }

  const timings = deployment && [ms(deployment.buildDurationMs), ms(deployment.deployDurationMs)];
  const hasTimings = !!(timings && timings[0] && timings[1]);

  // The version, clickable — it opens the Deployments tab focused on this exact deployment rather
  // than making someone find it in a list.
  const version = deployment && (
    onDeployments
      ? (
        <button className="ct-published-version is-link" onClick={() => onDeployments(deployment.id)}
          title={`View deployment #${deployment.number}`}>
          #{deployment.number}
        </button>
      )
      : <span className="ct-published-version">#{deployment.number}</span>
  );

  // Always a new tab: losing the Thrallo session to look at your own site would be an odd trade.
  const openSite = (
    <a className="ct-btn" href={address} target="_blank" rel="noopener noreferrer">Open Site</a>
  );

  return (
    <section className={`ct-published ${celebrate ? "celebrate" : ""}`} aria-label="Published site">
      {celebrate && (
        <div className="ct-published-cheer">
          ✅ Your app is live{deployment ? ` — deployment #${deployment.number}` : ""}
        </div>
      )}

      <div className="ct-published-head">
        <span className={`ct-badge tone-${status === "published" ? "live" : status === "update_available" ? "update" : "muted"}`}>
          {status === "published" ? "LIVE" : status === "update_available" ? "UPDATE AVAILABLE" : "UNPUBLISHED"}
        </span>
        {stale && <span className="ct-badge tone-live">LIVE</span>}
        <span className="ct-published-env">Production</span>
        {version}
      </div>

      {offline ? (
        <span className="ct-published-url offline">{displayUrl(address)}</span>
      ) : (
        <a className="ct-published-url" href={address} target="_blank" rel="noopener noreferrer">
          {displayUrl(address)}
        </a>
      )}

      <div className="ct-published-meta">
        {celebrate && hasTimings
          ? `Built in ${timings[0]} · deployed in ${timings[1]}`
          : offline
            ? `Taken offline ${relativeTime(site.unpublishedAt)} — publishing again restores this address.`
            : `Last published ${relativeTime(site.publishedAt)}`}
        {!celebrate && stale && " · this project has changed since then"}
      </div>

      {/* A publish that is still going out. The panel keeps showing what is SERVING — nothing has
          changed yet — and says plainly that something is on its way. */}
      {publishing && (
        <div className="ct-published-note working">
          Deployment #{publishing.number} is going out…
        </div>
      )}

      {/* A publish that failed. The most useful sentence here is which version people are still
          getting, because the answer is "the old one, and it is fine". */}
      {failedAttempt && (
        <div className="ct-published-note failed">
          Deployment #{failedAttempt.number} failed
          {deployment ? ` — #${deployment.number} is still serving` : ""}.
          {failedAttempt.failureReason && (
            <span className="ct-published-reason">{String(failedAttempt.failureReason).slice(0, 200)}</span>
          )}
          {onLogs && failedAttempt.buildRunId && (
            <>
              {" "}
              <button className="ct-linkish" onClick={() => onLogs(failedAttempt.buildRunId)}>
                View logs
              </button>
            </>
          )}
        </div>
      )}

      <div className="ct-published-actions">
        {celebrate ? (
          <>
            {!offline && openSite}
            {!offline && (
              <button className="ct-btn-quiet" onClick={share}>{shared || "Share"}</button>
            )}
            {!offline && !site.customDomain && (
              <button className="ct-btn-quiet" onClick={onConnectDomain || onOpenSettings}>Connect Domain</button>
            )}
            {onAnalytics && <button className="ct-btn-quiet" onClick={onAnalytics}>View Analytics</button>}
            {/* Never a fallback to the whole log stream: without a build run there is no exact log
                to open, and a button that quietly shows something else is worse than none (PR 6). */}
            {onLogs && deployment?.buildRunId && (
              <button className="ct-btn-quiet" onClick={() => onLogs(deployment.buildRunId)}>View Logs</button>
            )}
          </>
        ) : (
          <>
            {!offline && openSite}
            {!offline && <button className="ct-btn-quiet" onClick={copy}>{copied ? "Copied" : "Copy URL"}</button>}
            {/* Publishing is a sentence in Thrallo, so this says the sentence rather than inventing
                a second, silent code path that could drift from the conversational one. */}
            <button className={stale || offline ? "ct-btn" : "ct-btn-quiet"} onClick={onPublishUpdate}>
              {offline ? "Publish Again" : "Publish Update"}
            </button>
            <button className="ct-btn-quiet" aria-expanded={more} onClick={() => setMore((v) => !v)}>
              {more ? "Less ▴" : "More ▾"}
            </button>
          </>
        )}
      </div>

      {/* The rest, one click away. These are all real and all reachable — they are simply not what
          someone needs every time they open a conversation. */}
      {!celebrate && more && (
        <div className="ct-published-actions ct-published-more">
          {!offline && <button className="ct-btn-quiet" onClick={share}>{shared || "Share"}</button>}
          {!offline && !site.customDomain && (
            <button className="ct-btn-quiet" onClick={onConnectDomain || onOpenSettings}>Connect Domain</button>
          )}
          {onAnalytics && <button className="ct-btn-quiet" onClick={onAnalytics}>View Analytics</button>}
          {onLogs && deployment?.buildRunId && (
            <button className="ct-btn-quiet" onClick={() => onLogs(deployment.buildRunId)}>View Logs</button>
          )}
          {onDeployments && <button className="ct-btn-quiet" onClick={() => onDeployments(deployment?.id || null)}>Deployments</button>}
          {!offline && <button className="ct-btn-quiet" onClick={onUnpublish}>Unpublish</button>}
          <button className="ct-btn-quiet" onClick={onOpenSettings}>Project Settings</button>
        </div>
      )}
    </section>
  );
}
