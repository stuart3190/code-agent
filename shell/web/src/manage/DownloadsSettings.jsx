// Downloads — a Settings drill-in. Everything authenticates with an API token from the
// tokens section.

import React from "react";

export default function DownloadsSettings() {
  return (
    <div>
      <h3>Downloads</h3>
      <p className="mg-sub">Thrallo in your editor and terminal. Each connects with an API token.</p>
      <div className="mg-card">
        <div className="mg-row">
          <div>Thrallo for VS Code<div className="ct-hint">Agents, runs, diffs, approvals, and inline completions in your editor.</div></div>
        </div>
        <ol className="ct-hint" style={{ margin: "6px 0 0 18px", lineHeight: 1.8 }}>
          <li>Create an API token (Settings → API tokens).</li>
          <li>Package from <span className="mg-mono">editor/vscode</span> with <span className="mg-mono">npx vsce package</span> and install the .vsix.</li>
          <li>Run <b>Thrallo: Connect</b> and paste your token.</li>
        </ol>
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
          <div>Thrallo Desktop<div className="ct-hint">The full conversation-first workspace as a native editor. Windows first — packaging lands after the current milestone. Coming soon to macOS.</div></div>
        </div>
      </div>
    </div>
  );
}
