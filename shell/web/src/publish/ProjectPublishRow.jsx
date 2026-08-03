// The published details and actions on a dashboard project card.
//
// Only rendered for a project that has a publish record, so a draft card stays exactly as it was.
// Every control here does something real: there are no placeholders.

import React, { useState } from "react";
import { STATUS, displayUrl, relativeTime } from "./publishLifecycle.js";
import { DOMAIN_LABEL, isDomainLive, healthStateOf, isHealthProblem } from "../../../shared/operationalState.mjs";

export default function ProjectPublishRow({ site, status, onPublishUpdate, onUnpublish, onSettings, onAnalytics, onHealth, health = null, today = null }) {
  const [copied, setCopied] = useState(false);
  if (!site) return null;

  const offline = status === STATUS.unpublished;
  // Once a custom domain is verified it IS the address — it is what the owner gives people. The
  // Thrallo URL is never lost; it stays copyable from Project Settings.
  const address = site.primaryUrl || site.url;
  // Furthest along, so the card reflects work already in progress rather than showing nothing.
  const pendingDomain = (site.domains || []).find((d) => !isDomainLive(d.status)) || null;

  async function copy(event) {
    event.stopPropagation();
    try {
      await navigator.clipboard.writeText(address);
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
          <span className="ct-pubrow-url offline">{displayUrl(address)} · offline</span>
        ) : (
          <a className="ct-pubrow-url" href={address} target="_blank" rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}>
            {displayUrl(address)}
          </a>
        )}
        <span className="ct-pubrow-meta">
          <span className="ct-env">Production</span>
          {offline
            ? ` · unpublished ${relativeTime(site.unpublishedAt)}`
            : ` · published ${relativeTime(site.publishedAt)}`}
          {/* A domain still verifying is said to be verifying. Silence here read as "no domain",
              which is the same wrong answer the Overview tile used to give. */}
          {!offline && site.customDomain && " · custom domain"}
          {/* Today's traffic, where any was collected. Absent rather than "0" for a site with no
              day yet — a zero implies nobody came, which is a different claim. */}
          {!offline && today?.visitors > 0 && ` · ${today.visitors} visitor${today.visitors === 1 ? "" : "s"} today`}
          {!offline && !site.customDomain && pendingDomain
            && ` · ${pendingDomain.domain} ${DOMAIN_LABEL[pendingDomain.status]?.toLowerCase() || "pending"}`}
        </span>
      </div>
      <div className="ct-pubrow-actions">
        {!offline && (
          <>
            <a className="ct-pubrow-btn" href={address} target="_blank" rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}>Open Live Site</a>
            <button className="ct-pubrow-btn" onClick={copy}>{copied ? "Copied" : "Copy URL"}</button>
          </>
        )}
        <button className={`ct-pubrow-btn ${status === STATUS.updateAvailable ? "accent" : ""}`}
          onClick={act(onPublishUpdate)}>
          {offline ? "Publish Again" : "Publish Update"}
        </button>
        {!offline && <button className="ct-pubrow-btn" onClick={act(onUnpublish)}>Unpublish</button>}
        <button className={`ct-pubrow-btn ${isHealthProblem(healthStateOf(health)) ? "accent" : ""}`} onClick={act(onHealth)}>Health</button>
        <button className="ct-pubrow-btn" onClick={act(onAnalytics)}>Analytics</button>
        <button className="ct-pubrow-btn" onClick={act(onSettings)}>Project Settings</button>
      </div>
    </div>
  );
}
