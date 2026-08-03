// The project dashboard.
//
// Everything about one published project in one place, behind tabs, instead of six separate
// overlays reached from six separate buttons. The conversation stays where the work happens; this
// is where the deployment lives.
//
// The six tab bodies are code-split. They were all in the initial bundle — a 584 kB chunk every
// visitor downloaded, including people who never open a project — and each one is only ever needed
// the moment its tab is chosen.

import React, { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import OverviewTab from "./OverviewTab.jsx";
import { TabSkeleton } from "./TabStates.jsx";
import { STATUS, displayUrl } from "./publishLifecycle.js";
import { HEALTH_DOT, HEALTH_LABEL, healthStateOf } from "../../../shared/operationalState.mjs";

// Overview stays eager: it is the tab that opens by default, so splitting it would only add a
// round trip to the common case.
const AnalyticsView = lazy(() => import("./AnalyticsView.jsx"));
const HealthView = lazy(() => import("./HealthView.jsx"));
const LogsView = lazy(() => import("./LogsView.jsx"));
const DeploymentsView = lazy(() => import("./DeploymentsView.jsx"));
const DomainsSection = lazy(() => import("./DomainsSection.jsx"));
const ProjectSettingsBody = lazy(() => import("./ProjectSettingsBody.jsx"));

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "analytics", label: "Analytics" },
  { id: "health", label: "Health" },
  { id: "logs", label: "Logs" },
  { id: "deployments", label: "Deployments" },
  { id: "domains", label: "Domains" },
  { id: "settings", label: "Settings" },
];

export default function ProjectDashboard({
  site, initialTab = "overview", initialRef = null, onClose, onUpgrade, onSentence,
  onPublishUpdate, onUnpublish, onTabChange = null,
}) {
  const [tab, setTabState] = useState(initialTab);
  // The selected build travels with the tab, so a link to one deployment's logs reopens that
  // deployment's logs rather than the project's whole log stream.
  const [buildRef, setBuildRef] = useState(initialRef);
  const tablist = useRef(null);

  // The URL is the source of truth, so back/forward and refresh land on the same tab and build
  // that were open. Following props rather than owning state outright is what makes that work.
  useEffect(() => { setTabState(initialTab); }, [initialTab]);
  useEffect(() => { setBuildRef(initialRef); }, [initialRef]);

  const setTab = useCallback((next, ref = null) => {
    setTabState(next);
    setBuildRef(ref);
    onTabChange?.(next, ref);
  }, [onTabChange]);

  // Escape closes, as it does for every other sheet in the product.
  useEffect(() => {
    const onKey = (event) => { if (event.key === "Escape") onClose?.(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  /**
   * Arrow keys move between tabs, Home and End jump to the ends.
   *
   * The markup already claimed role="tablist" and role="tab", which tells a screen-reader user to
   * expect exactly this. Claiming the pattern without implementing it is worse than not claiming
   * it: the promise is announced and then broken.
   */
  const onTabKeyDown = (event) => {
    const index = TABS.findIndex((t) => t.id === tab);
    const move = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
    let next = null;
    if (move) next = TABS[(index + move + TABS.length) % TABS.length];
    else if (event.key === "Home") next = TABS[0];
    else if (event.key === "End") next = TABS[TABS.length - 1];
    if (!next) return;
    event.preventDefault();
    setTab(next.id);
    // Focus follows selection, which is the expected behaviour for automatic-activation tabs.
    tablist.current?.querySelector(`#projtab-${next.id}`)?.focus();
  };

  const status = site?.status || STATUS.published;
  const health = healthStateOf(site?.health);
  const address = site?.primaryUrl || site?.url;

  // The panel body for the selected tab. Kept in a memo so switching tabs does not rebuild the
  // header and the strip alongside it.
  const body = useMemo(() => {
    switch (tab) {
      case "analytics": return <AnalyticsView site={site} embedded onUpgrade={onUpgrade} />;
      case "health": return <HealthView site={site} embedded onOpenTab={(next, ref = null) => setTab(next, ref)} />;
      case "logs": return <LogsView site={site} buildRef={buildRef} onSelectBuild={(id) => setTab("logs", id)} />;
      case "deployments": return (
        <DeploymentsView site={site} focusId={buildRef}
          onOpenLogs={(runId = null) => setTab("logs", runId)} onUpgrade={onUpgrade} />
      );
      case "domains": return <DomainsSection site={site} />;
      case "settings": return <ProjectSettingsBody site={site} onSentence={onSentence} />;
      default: return (
        <OverviewTab site={site} onOpenTab={(next) => setTab(next)}
          onPublishUpdate={onPublishUpdate} onUnpublish={onUnpublish} />
      );
    }
  }, [tab, site, buildRef, setTab, onUpgrade, onSentence, onPublishUpdate, onUnpublish]);

  if (!site) return null;

  return (
    <aside className="ct-sheet show ct-projdash" aria-label="Project dashboard">
      <div className="ct-sheet-head ct-projdash-head">
        <div className="ct-projdash-title">
          <h2>{site.name || "Project"}</h2>
          {/* The two facts worth carrying on every tab: is it live, and at what address. Reading
              them from the shared vocabulary rather than restating them here is what stops this
              header disagreeing with the Health page one tab away. */}
          <div className="ct-projdash-facts">
            <span className={`ct-badge tone-${status === STATUS.published ? "live" : status === STATUS.updateAvailable ? "update" : "muted"}`}>
              {status === STATUS.published ? "LIVE" : status === STATUS.updateAvailable ? "UPDATE AVAILABLE" : "UNPUBLISHED"}
            </span>
            {site.health && (
              <span className="ct-projdash-health" title={`Health: ${HEALTH_LABEL[health]}`}>
                <span aria-hidden="true">{HEALTH_DOT[health]}</span> {HEALTH_LABEL[health]}
              </span>
            )}
            {address && status !== STATUS.unpublished && (
              <a className="ct-projdash-url" href={address} target="_blank" rel="noopener noreferrer">
                {displayUrl(address)} ↗
              </a>
            )}
          </div>
        </div>
        <button className="ct-btn-quiet" onClick={onClose}>Done</button>
      </div>

      <div className="ct-projtabs-wrap">
        <div className="ct-projtabs" role="tablist" aria-label="Project sections"
          ref={tablist} onKeyDown={onTabKeyDown}>
          {TABS.map((t) => (
            <button key={t.id} id={`projtab-${t.id}`} role="tab"
              aria-selected={tab === t.id} aria-controls="projtab-panel"
              // Roving tabindex: one stop for the whole strip, then arrow keys within it.
              tabIndex={tab === t.id ? 0 : -1}
              className={`ct-projtab ${tab === t.id ? "on" : ""}`} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div className="ct-sheet-body" id="projtab-panel" role="tabpanel"
        aria-labelledby={`projtab-${tab}`} tabIndex={-1}>
        {/* The fallback is the shape of what is arriving, not a spinner. It covers the moment a
            code-split tab is being fetched; each tab then shows its own skeleton while its data
            loads. */}
        <Suspense fallback={<TabSkeleton rows={3} metrics={tab === "analytics" || tab === "health"} />}>
          {body}
        </Suspense>
      </div>
    </aside>
  );
}
