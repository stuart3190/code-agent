// Settings → Preferences.
//
// Only preferences with something behind them. A toggle that stores a value nothing ever reads is
// worse than no toggle: it promises behaviour the product does not have, and the customer only
// finds out when it fails to happen.
//
// So: theme (applied before first paint and synced to the account), the AI connection, downloads,
// and signing out. Default model is deliberately absent — model preference is per conversation,
// chosen in the composer, and there is no account-level default for it to write to.

import React from "react";

const THEMES = [["light", "Light"], ["dark", "Dark"], ["system", "System"]];

export default function PreferencesTab({
  user, theme, setTheme, data, onSection, onPreviewPlan,
}) {
  return (
    <div className="st-tab">
      <div className="st-headline">
        <div>
          <div className="st-headline-plan">{user.email}</div>
          <div className="ct-hint">
            {data.ownerAccount ? "Owner account — limits are never enforced" : `${data.plan.name} plan`}
          </div>
        </div>
        {/* Logging out lives in the account menu on the avatar, where people look for it — and
            where it is reachable from every screen rather than three clicks into Settings. Two
            sign-outs that end the session differently is exactly the drift this codebase removes
            elsewhere, so there is one. */}
      </div>

      <div className="st-section">
        <h3>Appearance</h3>
        <div className="st-row">
          <div>
            Theme
            <div className="ct-hint">
              Applied before the page paints and saved to your account, so a new device opens the
              way you left it.
            </div>
          </div>
          <div className="ct-toggle" role="group" aria-label="Theme">
            {THEMES.map(([id, label]) => (
              <button key={id} className={theme === id ? "on" : ""} aria-pressed={theme === id}
                onClick={() => setTheme(id)}>{label}</button>
            ))}
          </div>
        </div>
      </div>

      <div className="st-section">
        <h3>AI</h3>
        <div className="st-rows">
          <div className="st-row">
            <div>
              Model access
              <div className="ct-hint">Thrallo's managed models, your own API key, or ChatGPT Codex.</div>
            </div>
            <button className="ct-btn-quiet" onClick={() => onSection("ai")}>Manage</button>
          </div>
          {/* Which model runs a given conversation is chosen in the composer, per conversation.
              There is no account-level default to set here, so none is offered. */}
          <p className="ct-hint st-note">
            The model for a piece of work is chosen in the composer, per conversation.
          </p>
        </div>
      </div>

      <div className="st-section">
        <h3>Thrallo everywhere</h3>
        <div className="st-row">
          <div>
            Editor, CLI and desktop
            <div className="ct-hint">Bring Thrallo where you already work.</div>
          </div>
          <button className="ct-btn-quiet" onClick={() => onSection("downloads")}>Downloads</button>
        </div>
      </div>

      {data.ownerAccount && (
        <div className="st-section">
          <h3>Owner tools</h3>
          <div className="st-row">
            <div>
              View as
              <div className="ct-hint">
                See the product on a customer plan. Usage still records and nothing ever blocks you.
              </div>
            </div>
            <div className="ct-toggle" role="group" aria-label="View as plan">
              {[["actual", "Owner"], ["free", "Free"], ["starter", "Starter"], ["pro", "Pro"]].map(([id, label]) => (
                <button key={id} className={(data.previewPlan || "actual") === id ? "on" : ""}
                  aria-pressed={(data.previewPlan || "actual") === id}
                  onClick={() => onPreviewPlan(id === "actual" ? null : id)}>{label}</button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
