// Project Settings for a published project.
//
// Only things that genuinely exist appear here. A custom domain is connected conversationally in
// Thrallo, so this says the sentence rather than duplicating the capability behind a form that
// could drift from it. Downloading the source uses the same export route and the same secret
// scrubbing as every other export.

import React, { useState } from "react";
import { exportProjectZip } from "../lib/codeAgentApi.js";
import { displayUrl, relativeTime } from "./publishState.js";
import DomainsSection from "./DomainsSection.jsx";

export default function ProjectSettings({ site, onClose, onSentence }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!site) return null;

  async function download() {
    setBusy(true); setError("");
    try {
      const { blob, filename } = await exportProjectZip(site.projectId);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e.message || "The download did not start. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside className="ct-sheet show" aria-label="Project settings">
      <div className="ct-sheet-head">
        <h2>Project settings</h2>
        <button className="ct-btn-quiet" onClick={onClose}>Done</button>
      </div>
      <div className="ct-sheet-body">
        <div className="ct-set-group">
          <div className="ct-set-label">Live site</div>
          <div className="ct-set-row">
            <div>
              {displayUrl(site.url)}
              <div className="ct-hint">
                Production · last published {relativeTime(site.publishedAt)}
                {site.updateAvailable && " · changes are waiting to be published"}
              </div>
            </div>
            <a className="ct-btn-quiet" href={site.url} target="_blank" rel="noopener noreferrer">Open</a>
          </div>
        </div>

        <DomainsSection site={site} />

        <div className="ct-set-group">
          <div className="ct-set-label">Source code</div>
          <div className="ct-set-row">
            <div>Download this project<div className="ct-hint">A ZIP of the app, with no keys or platform secrets in it.</div></div>
            <button className="ct-btn-quiet" disabled={busy} onClick={download}>
              {busy ? "Preparing…" : "Download"}
            </button>
          </div>
          {error && <div className="mg-error">{error}</div>}
        </div>
      </div>
    </aside>
  );
}
