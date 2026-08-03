// The project dashboard.
//
// Everything about one published project in one place, behind tabs, instead of six separate
// overlays reached from six separate buttons. The conversation stays where the work happens; this
// is where the deployment lives.

import React, { useEffect, useState } from "react";
import AnalyticsView from "./AnalyticsView.jsx";
import HealthView from "./HealthView.jsx";
import LogsView from "./LogsView.jsx";
import DomainsSection from "./DomainsSection.jsx";
import ProjectSettingsBody from "./ProjectSettingsBody.jsx";
import DeploymentsView from "./DeploymentsView.jsx";
import OverviewTab from "./OverviewTab.jsx";

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

  // The URL is the source of truth, so back/forward and refresh land on the same tab and build
  // that were open. Following props rather than owning state outright is what makes that work.
  useEffect(() => { setTabState(initialTab); }, [initialTab]);
  useEffect(() => { setBuildRef(initialRef); }, [initialRef]);

  const setTab = (next, ref = null) => {
    setTabState(next);
    setBuildRef(ref);
    onTabChange?.(next, ref);
  };

  if (!site) return null;

  return (
    <aside className="ct-sheet show ct-projdash" aria-label="Project dashboard">
      <div className="ct-sheet-head">
        <h2>{site.name || "Project"}</h2>
        <button className="ct-btn-quiet" onClick={onClose}>Done</button>
      </div>

      <div className="ct-projtabs" role="tablist" aria-label="Project sections">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id}
            className={`ct-projtab ${tab === t.id ? "on" : ""}`} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      <div className="ct-sheet-body">
        {tab === "overview" && (
          <OverviewTab site={site} onOpenTab={(next) => setTab(next)}
            onPublishUpdate={onPublishUpdate} onUnpublish={onUnpublish} />
        )}
        {/* Mounted only when selected: each of these polls, and four background pollers for tabs
            nobody is looking at is exactly the kind of thing that makes a dashboard feel heavy. */}
        {tab === "analytics" && <AnalyticsView site={site} embedded onUpgrade={onUpgrade} />}
        {tab === "health" && <HealthView site={site} embedded />}
        {tab === "logs" && <LogsView site={site} buildRef={buildRef} onSelectBuild={(id) => setTab("logs", id)} />}
        {tab === "deployments" && <DeploymentsView site={site} onOpenLogs={(runId = null) => setTab("logs", runId)} onUpgrade={onUpgrade} />}
        {tab === "domains" && <DomainsSection site={site} />}
        {tab === "settings" && <ProjectSettingsBody site={site} onSentence={onSentence} />}
      </div>
    </aside>
  );
}
