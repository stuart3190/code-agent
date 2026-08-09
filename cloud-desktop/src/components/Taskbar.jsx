import { AppWindow, CloudCheck, DotsNine, HardDrive, UserCircle } from "@phosphor-icons/react";
import { applicationRegistry } from "../apps/registry.js";
import { storageFixtures } from "../fixtures/data.js";
import { AppIcon } from "./AppIcon.jsx";

const connectionLabels = {
  connected: "Workspace connected",
  reconnecting: "Workspace reconnecting",
  offline: "Offline · layout preserved",
  recovered: "Workspace recovered",
  unavailable: "Workspace unavailable",
  ready: "Workspace ready",
};

export function Taskbar({ state, actions, viewportMode }) {
  const storage = storageFixtures[state.storageState];
  const runningCount = Object.values(state.windows).filter((windowState) => windowState.isOpen).length;

  return (
    <>
      <nav className="app-shelf" aria-label="Applications" data-taskbar data-labels={state.taskbarLabels}>
        <div className="shelf-brand" aria-label="Thrallo Cloud Desktop"><AppIcon name="cloud" size={23} /><span>Cloud</span></div>
        <div className="shelf-apps">
          {applicationRegistry.map((application) => {
            const windowState = state.windows[application.id];
            const active = state.focusedApplication === application.id && !windowState.minimized;
            return (
              <button
                key={application.id}
                className={`shelf-app ${active ? "is-active" : ""} ${windowState.isOpen ? "is-running" : ""} ${windowState.minimized ? "is-minimized" : ""}`}
                aria-label={`${application.title}${active ? ", focused" : windowState.minimized ? ", minimized" : windowState.isOpen ? ", running" : ""}`}
                aria-pressed={active}
                data-taskbar-app={application.id}
                onClick={() => actions.open(application.id)}
              >
                <span className={`shelf-icon app-tone-${application.id}`}><AppIcon name={application.icon} size={26} /></span>
                <span className="shelf-label">{application.title}</span>
                {windowState.isOpen && <span className="running-indicator"><span className="sr-only">Running</span></span>}
              </button>
            );
          })}
        </div>
      </nav>
      <footer className="status-rail" aria-label="Workspace status">
        <button className="workspace-menu" data-launcher-button aria-expanded={state.launcherOpen} onClick={() => actions.toggleLauncher()}>
          <DotsNine size={20} weight="bold" />
          <span>{viewportMode === "mobile" ? "Apps" : state.workspaceName}</span>
        </button>
        <div className="status-spacer" />
        <div className="system-status running-status"><AppWindow /><span>{runningCount} {runningCount === 1 ? "app" : "apps"} running</span></div>
        <div className={`system-status connection-${state.connection}`}><CloudCheck /><span>{connectionLabels[state.connection] ?? "Workspace status unavailable"}</span></div>
        <button className={`system-status storage-status tone-${storage.tone}`} onClick={() => actions.open("storage")}><HardDrive /><span>{storage.used} GB of {storage.total} GB</span></button>
        <button className="account-status" aria-label="Open account settings for Taylor" onClick={() => actions.open("settings")}><UserCircle size={24} weight="duotone" /><span>Taylor</span></button>
      </footer>
    </>
  );
}
