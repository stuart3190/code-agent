import { useEffect, useState } from "react";
import { ArrowSquareOut, Check, Cloud, Moon, PaintBrush, Receipt, Sun, TextAa, UserCircle } from "@phosphor-icons/react";

export function SettingsApp({ state, actions, onFixtureNotice }) {
  const [workspaceName, setWorkspaceName] = useState(state.workspaceName);
  useEffect(() => setWorkspaceName(state.workspaceName), [state.workspaceName]);
  return (
    <div className="app-view settings-app" data-testid="settings-app">
      <aside className="settings-sidebar">
        <strong>Settings</strong>
        <button className="is-selected"><PaintBrush /> Appearance</button>
        <button><Cloud /> Workspace</button>
        <button><UserCircle /> Account</button>
      </aside>
      <section className="settings-main">
        <header><span className="eyebrow">Desktop preferences</span><h2>Make the workspace yours</h2><p>These choices are stored only in this browser fixture.</p></header>
        <div className="setting-group">
          <div className="setting-copy"><strong>Appearance</strong><small>Light is the Thrallo default. Dark remains available.</small></div>
          <div className="segmented-control" role="group" aria-label="Appearance"><button aria-pressed={state.appearance === "light"} onClick={() => actions.setAppearance("light")}><Sun /> Light{state.appearance === "light" && <Check />}</button><button aria-pressed={state.appearance === "dark"} onClick={() => actions.setAppearance("dark")}><Moon /> Dark{state.appearance === "dark" && <Check />}</button></div>
        </div>
        <div className="setting-group">
          <div className="setting-copy"><strong>Interface density</strong><small>Choose how much information fits into app windows.</small></div>
          <div className="segmented-control" role="group" aria-label="Interface density"><button aria-pressed={state.density === "compact"} onClick={() => actions.setDensity("compact")}><TextAa /> Compact</button><button aria-pressed={state.density === "comfortable"} onClick={() => actions.setDensity("comfortable")}><TextAa /> Comfortable</button></div>
        </div>
        <label className="setting-row"><span><strong>Reduce motion</strong><small>Keep transitions short and steady.</small></span><input type="checkbox" checked={state.reduceMotion} onChange={(event) => actions.setReduceMotion(event.target.checked)} /></label>
        <label className="setting-row"><span><strong>Show app labels</strong><small>Keep names visible on the desktop shelf.</small></span><input type="checkbox" checked={state.taskbarLabels} onChange={(event) => actions.setTaskbarLabels(event.target.checked)} /></label>
        <form className="workspace-name-setting" onSubmit={(event) => { event.preventDefault(); actions.setWorkspaceName(workspaceName); }}><label><strong>Workspace name</strong><small>Shown in the desktop status rail.</small><input value={workspaceName} onChange={(event) => setWorkspaceName(event.target.value)} /></label><button className="secondary-button">Save</button></form>
        <div className="portal-handoffs"><div><Receipt /><span><strong>Account and billing</strong><small>Managed later through app.thrallo.com.</small></span></div><button onClick={() => onFixtureNotice("Portal handoff unavailable", "C1 records no portal call and sends no account data.")}><ArrowSquareOut /> Open portal fixture</button></div>
        <button className="reset-button" onClick={actions.reset}>Reset C1 fixture desktop</button>
      </section>
    </div>
  );
}
