import { useEffect, useMemo, useReducer } from "react";
import { createDesktopState, desktopReducer } from "../state/desktopReducer.js";
import { clearDesktopState, loadPersistedDesktopState, saveDesktopState } from "../state/persistence.js";

function currentViewport() {
  if (typeof window === "undefined") return { width: 1440, height: 900 };
  return { width: window.innerWidth, height: window.innerHeight };
}

export function getViewportMode(width) {
  if (width < 768) return "mobile";
  if (width < 1180) return "tablet";
  return "desktop";
}

export function useDesktop({ storage = typeof window === "undefined" ? null : window.localStorage } = {}) {
  const [state, dispatch] = useReducer(desktopReducer, null, () => createDesktopState({
    scenarioId: new URLSearchParams(typeof window === "undefined" ? "" : window.location.search).get("scenario") ?? "normal-active",
    viewport: currentViewport(),
    persisted: loadPersistedDesktopState(storage),
  }));

  useEffect(() => {
    const handleResize = () => dispatch({ type: "SET_VIEWPORT", viewport: currentViewport() });
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  useEffect(() => {
    saveDesktopState(storage, state);
  }, [state, storage]);

  const actions = useMemo(() => ({
    open: (applicationId) => dispatch({ type: "OPEN_APP", applicationId }),
    focus: (applicationId) => dispatch({ type: "FOCUS_APP", applicationId }),
    minimize: (applicationId) => dispatch({ type: "MINIMIZE_APP", applicationId }),
    maximize: (applicationId) => dispatch({ type: "TOGGLE_MAXIMIZE", applicationId }),
    snap: (applicationId, mode) => dispatch({ type: "SNAP_APP", applicationId, mode }),
    close: (applicationId) => dispatch({ type: "CLOSE_APP", applicationId }),
    move: (applicationId, x, y) => dispatch({ type: "MOVE_APP", applicationId, x, y }),
    resize: (applicationId, width, height) => dispatch({ type: "RESIZE_APP", applicationId, width, height }),
    toggleLauncher: (open) => dispatch({ type: "TOGGLE_LAUNCHER", open }),
    setModal: (modal) => dispatch({ type: "SET_MODAL", modal }),
    setAppearance: (appearance) => dispatch({ type: "SET_APPEARANCE", appearance }),
    setDensity: (density) => dispatch({ type: "SET_DENSITY", density }),
    setReduceMotion: (value) => dispatch({ type: "SET_REDUCE_MOTION", value }),
    setTaskbarLabels: (value) => dispatch({ type: "SET_TASKBAR_LABELS", value }),
    setWorkspaceName: (value) => dispatch({ type: "SET_WORKSPACE_NAME", value }),
    loadScenario: (scenarioId) => {
      clearDesktopState(storage);
      dispatch({ type: "LOAD_SCENARIO", scenarioId });
    },
    reset: () => {
      clearDesktopState(storage);
      dispatch({ type: "LOAD_SCENARIO", scenarioId: "normal-active" });
    },
  }), [storage]);

  return { state, actions, viewportMode: getViewportMode(state.viewport.width) };
}
