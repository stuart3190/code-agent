// Downloads — a Settings drill-in. Thrallo Desktop ships as a real Windows installer and
// portable ZIP served from /downloads (manifest-driven). The CLI and editor extension
// connect with an API token from the tokens section.

import React, { useEffect, useState } from "react";
import { SkeletonRows, useCopy } from "./shared.jsx";

function formatSize(bytes) {
  return bytes >= 1073741824 ? `${(bytes / 1073741824).toFixed(2)} GB` : `${Math.round(bytes / 1048576)} MB`;
}

export default function DownloadsSettings() {
  const [release, setRelease] = useState(null);
  const [failed, setFailed] = useState(false);
  const [copied, copy] = useCopy();

  useEffect(() => {
    fetch("/api/v1/downloads")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("no release"))))
      .then(setRelease)
      .catch(() => setFailed(true));
  }, []);

  const setup = release?.files?.setup;
  const portable = release?.files?.portable;

  return (
    <div>
      <h3>Downloads</h3>
      <p className="mg-sub">Thrallo on your desktop and in your terminal. The CLI and editor connect with an API token.</p>

      <div className="mg-card">
        <div className="mg-row" style={{ borderBottom: 0, paddingBottom: 4 }}>
          <div>
            Thrallo Desktop
            <div className="ct-hint">The full conversation-first workspace as a native editor — files, terminal, and your team in one window.</div>
          </div>
          <span className="mg-pill"><span className="dot" style={{ background: "var(--good)" }} />Windows x64</span>
        </div>

        {!release && !failed && <SkeletonRows rows={2} />}
        {failed && <div className="ct-hint">Downloads are temporarily unavailable — try again shortly.</div>}

        {setup && (
          <>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", margin: "10px 0 4px" }}>
              <a className="ct-btn" style={{ textDecoration: "none" }} href={setup.url} download>
                Download for Windows
              </a>
              {portable && (
                <a className="ct-btn-quiet" style={{ textDecoration: "none", border: "1px solid var(--line)" }} href={portable.url} download>
                  Portable ZIP · {formatSize(portable.sizeBytes)}
                </a>
              )}
            </div>
            <div className="ct-hint" style={{ margin: "6px 0 2px" }}>
              Version {release.version} · {formatSize(setup.sizeBytes)} · released {new Date(release.releasedAt).toLocaleDateString()} · {release.platform}
            </div>
            {release.notes && <div className="ct-hint" style={{ marginTop: 4 }}>{release.notes}</div>}
            <div className="ct-hint" style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              <span>SHA-256</span>
              <button className="mg-mono" style={{ cursor: "pointer" }} title="Copy installer checksum"
                onClick={() => copy(setup.sha256)}>
                {copied ? "Copied ✓" : `${setup.sha256.slice(0, 20)}…`}
              </button>
              {portable && (
                <span title={`Portable ZIP sha256: ${portable.sha256}`}>· portable {portable.sha256.slice(0, 12)}…</span>
              )}
            </div>
            <div className="ct-hint" style={{ marginTop: 6 }}>
              The installer needs no admin rights and adds a Start menu shortcut (desktop shortcut optional).
              The portable ZIP just extracts and runs. macOS and Linux builds aren't available yet.
            </div>
          </>
        )}
      </div>

      <div className="mg-card">
        <div className="mg-row">
          <div>Thrallo CLI<div className="ct-hint">Runs, reviews, and approvals from the terminal.</div></div>
        </div>
        <pre className="mg-mono" style={{ padding: "10px 12px", margin: "6px 0 0", whiteSpace: "pre-wrap" }}>{`npm install -g github:stuart3190/code-agent
thrallo login    # paste an API token
thrallo run "fix the flaky retry test" --repo you/repo`}</pre>
      </div>

      <div className="mg-card">
        <div className="mg-row">
          <div>Thrallo for VS Code<div className="ct-hint">
            Agents, runs, diffs, approvals, and inline completions inside stock VS Code — Thrallo Desktop
            already includes all of it, so the desktop app is the recommended way to get the editor experience.
          </div></div>
        </div>
      </div>
    </div>
  );
}
