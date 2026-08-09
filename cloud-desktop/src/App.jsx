import { useEffect } from "react";
import { BrowserApp } from "./apps/BrowserApp.jsx";
import { FilesApp } from "./apps/FilesApp.jsx";
import { GitHubApp } from "./apps/GitHubApp.jsx";
import { SettingsApp } from "./apps/SettingsApp.jsx";
import { StorageApp } from "./apps/StorageApp.jsx";
import { TerminalApp } from "./apps/TerminalApp.jsx";
import { ThralloApp } from "./apps/ThralloApp.jsx";
import { Launcher } from "./components/Launcher.jsx";
import { DesktopHeader } from "./components/DesktopHeader.jsx";
import { DesktopShortcuts } from "./components/DesktopShortcuts.jsx";
import { ModalLayer } from "./components/ModalLayer.jsx";
import { Taskbar } from "./components/Taskbar.jsx";
import { WindowFrame } from "./components/WindowFrame.jsx";
import { WorkspaceLifecycleOverlay } from "./components/WorkspaceLifecycleOverlay.jsx";
import { useDesktop } from "./hooks/useDesktop.js";
import { useFixtureFilesystem } from "./hooks/useFixtureFilesystem.js";
import { createFixtureProvider } from "./providers/fixtureProvider.js";

const provider = createFixtureProvider({ seed: "thrallo-cloud-desktop-c1", scenario: "normal-active" });
const bootstrap = provider.getBootstrapState();

const applicationComponents = {
  thrallo: ThralloApp,
  browser: BrowserApp,
  files: FilesApp,
  terminal: TerminalApp,
  github: GitHubApp,
  storage: StorageApp,
  settings: SettingsApp,
};

export default function App() {
  const { state, actions, viewportMode } = useDesktop();
  const filesystem = useFixtureFilesystem({ shellStorageState: state.storageState });

  useEffect(() => {
    const handleKey = (event) => {
      if (event.altKey && event.key.toLowerCase() === "l") {
        event.preventDefault();
        actions.toggleLauncher();
      }
      if (event.key === "Escape") {
        actions.toggleLauncher(false);
        actions.setModal(null);
      }
      if (event.altKey && event.key === "F4" && state.focusedApplication) {
        event.preventDefault();
        actions.close(state.focusedApplication);
      }
      if (viewportMode === "desktop" && event.altKey && event.key === "ArrowLeft" && state.focusedApplication) {
        event.preventDefault();
        actions.snap(state.focusedApplication, "left");
      }
      if (viewportMode === "desktop" && event.altKey && event.key === "ArrowRight" && state.focusedApplication) {
        event.preventDefault();
        actions.snap(state.focusedApplication, "right");
      }
      if (viewportMode === "desktop" && event.altKey && event.key === "ArrowUp" && state.focusedApplication) {
        event.preventDefault();
        actions.snap(state.focusedApplication, "maximize");
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [actions, state.focusedApplication, viewportMode]);

  const notice = (title, message, tone = "info") => actions.setModal({ title, message, tone });

  return (
    <main
      className={`cloud-desktop theme-${state.appearance} density-${state.density} ${state.reduceMotion ? "reduce-motion" : ""}`}
      data-desktop-shell
      data-layout={viewportMode}
      data-provider-kind={bootstrap.providerKind}
      data-theme={state.appearance}
    >
      <h1 className="sr-only">Thrallo Cloud Desktop prototype</h1>
      <DesktopHeader state={state} actions={actions} />
      <div className="desktop-canvas" aria-label="Cloud desktop workspace">
        <div className="desktop-watermark" aria-hidden="true"><span>Thrallo</span><small>Cloud workspace</small></div>
        <DesktopShortcuts positions={state.desktopShortcutPositions} windows={state.windows} focusedApplication={state.focusedApplication} actions={actions} />
        <div className="window-layer" aria-live="off">
          {Object.values(state.windows).sort((left, right) => left.zIndex - right.zIndex).map((windowState) => {
            const Component = applicationComponents[windowState.applicationId];
            return (
              <WindowFrame key={windowState.applicationId} windowState={windowState} active={state.focusedApplication === windowState.applicationId} viewportMode={viewportMode} viewport={state.viewport} actions={actions}>
                <Component state={state} actions={actions} storageState={state.storageState} filesystem={filesystem} onFixtureNotice={notice} />
              </WindowFrame>
            );
          })}
        </div>
        {state.snapPreview && <div className={`snap-preview snap-${state.snapPreview}`} data-snap-preview={state.snapPreview} aria-hidden="true" />}
      </div>
      <WorkspaceLifecycleOverlay lifecycle={state.lifecycle} actions={actions} />
      <Launcher open={state.launcherOpen} windows={state.windows} actions={actions} />
      <Taskbar state={state} actions={actions} viewportMode={viewportMode} />
      <ModalLayer modal={state.modal} onClose={() => actions.setModal(null)} />
      <div className="sr-only" aria-live="polite" aria-atomic="true">{state.announcement}</div>
    </main>
  );
}
