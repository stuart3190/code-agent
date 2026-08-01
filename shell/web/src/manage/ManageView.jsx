// Summonable visual views (Stuart's Phase 24 merge): repositories, usage, and admin
// telemetry. Opened instantly from ⌘K, settings, conversation cards, or the Lead Agent's
// open_view capability — never a destination the user must "navigate" to.

import React from "react";
import RepositoriesView from "./RepositoriesView.jsx";
import UsageView from "./UsageView.jsx";
import OpsView from "./OpsView.jsx";
import DiagnosticsView from "./DiagnosticsView.jsx";
import AdminAnalyticsView from "./AdminAnalyticsView.jsx";
import IntelligenceView from "./IntelligenceView.jsx";

const VIEWS = {
  repos: RepositoriesView,
  usage: UsageView,
  ops: OpsView,
  diagnostics: DiagnosticsView,
  analytics: AdminAnalyticsView,
  intelligence: IntelligenceView,
};

export const MANAGE_VIEW_IDS = Object.keys(VIEWS);

export default function ManageView({ view, onClose, onSentence, onOpenRun }) {
  const Active = VIEWS[view] || null;
  return (
    <div className={`mg-panel ${Active ? "show" : ""}`} role="dialog" aria-modal="true" aria-label="Thrallo view">
      <div className="mg-body">
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button className="ct-btn-quiet" onClick={onClose}>Done</button>
        </div>
        {Active && <Active onSentence={onSentence} onOpenRun={onOpenRun} />}
      </div>
    </div>
  );
}
