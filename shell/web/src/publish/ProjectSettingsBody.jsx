// Settings for one project, without the sheet chrome — the project dashboard supplies that.
//
// Domains are deliberately absent: they have their own tab, and duplicating them would create two
// places to change the same thing.

import React, { useState } from "react";
import { exportProjectZip } from "../lib/codeAgentApi.js";
import { displayUrl, relativeTime } from "./publishLifecycle.js";

export default function ProjectSettingsBody({ site, onSentence }) {
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
    <>
      <div className="ct-set-group">
        <div className="ct-set-label">Thrallo address</div>
        <div className="ct-set-row">
          <div>
            {displayUrl(site.url)}
            <div className="ct-hint">
              Production · last published {relativeTime(site.publishedAt)}. Always active, even when
              a custom domain is connected.
            </div>
          </div>
          <a className="ct-btn-quiet" href={site.url} target="_blank" rel="noopener noreferrer">Open</a>
        </div>
      </div>

      <div className="ct-set-group">
        <div className="ct-set-label">Source code</div>
        <div className="ct-set-row">
          <div>
            Download this project
            <div className="ct-hint">A ZIP of the app, with no keys or platform secrets in it.</div>
          </div>
          <button className="ct-btn-quiet" disabled={busy} onClick={download}>
            {busy ? "Preparing…" : "Download"}
          </button>
        </div>
        {error && <div className="mg-error">{error}</div>}
      </div>

      <div className="ct-set-group">
        <div className="ct-set-label">Ask Thrallo</div>
        <div className="ct-set-row">
          <div>
            Change anything about this app
            <div className="ct-hint">Describe what you want and the team will build it.</div>
          </div>
          <button className="ct-btn-quiet"
            onClick={() => onSentence("I'd like to make a change to this app.")}>
            Start
          </button>
        </div>
      </div>
    </>
  );
}
