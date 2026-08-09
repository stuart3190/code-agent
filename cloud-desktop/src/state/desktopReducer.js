import { getApplication } from "../apps/registry.js";
import { getScenario } from "../fixtures/scenarios.js";
import { clampDesktopShortcutPosition, constrainDesktopShortcutPositions, createDesktopShortcutPositions } from "./desktopShortcuts.js";
import { clampBounds, constrainAllWindows, createWindowMap, getTopVisibleWindow, raiseWindow, resizeBounds, snapBounds, updateWindow } from "./windowManager.js";

export function createDesktopState({ scenarioId = "normal-active", viewport = { width: 1440, height: 900 }, persisted = null } = {}) {
  const scenario = getScenario(scenarioId);
  const windows = createWindowMap(scenario.openApps, scenario.focusedApp, viewport);
  const base = {
    scenarioId: scenario.id,
    workspaceName: scenario.workspaceName,
    appearance: scenario.appearance,
    density: "compact",
    reduceMotion: false,
    taskbarLabels: true,
    connection: scenario.connection,
    lifecycle: scenario.lifecycle ?? "ready",
    storageState: scenario.storageState,
    focusedApplication: scenario.focusedApp,
    launcherOpen: false,
    modal: null,
    snapPreview: null,
    announcement: `${scenario.label} loaded`,
    viewport,
    desktopShortcutPositions: createDesktopShortcutPositions(),
    windows,
  };
  if (!persisted) return base;
  const mergedWindows = Object.fromEntries(Object.entries(windows).map(([id, fallback]) => [id, {
    ...fallback,
    ...(persisted.windows?.[id] ?? {}),
    applicationId: id,
  }]));
  const nextWindows = constrainAllWindows(mergedWindows, viewport);
  const preferredFocus = nextWindows[persisted.focusedApplication]?.isOpen && !nextWindows[persisted.focusedApplication].minimized
    ? persisted.focusedApplication
    : getTopVisibleWindow(nextWindows);
  return {
    ...base,
    ...persisted,
    viewport,
    focusedApplication: preferredFocus,
    launcherOpen: false,
    modal: null,
    snapPreview: null,
    connection: scenario.connection,
    lifecycle: scenario.lifecycle ?? "ready",
    storageState: scenario.storageState,
    desktopShortcutPositions: constrainDesktopShortcutPositions(persisted.desktopShortcutPositions, viewport),
    windows: nextWindows,
    announcement: persisted.recoveryNotice ?? "Saved workspace layout restored",
  };
}

function activateWindow(state, applicationId, extra = {}) {
  const current = state.windows[applicationId];
  if (!current) return state;
  let windows = updateWindow(state.windows, applicationId, { isOpen: true, minimized: false, ...extra });
  windows = raiseWindow(windows, applicationId);
  return {
    ...state,
    focusedApplication: applicationId,
    launcherOpen: false,
    announcement: `${getApplication(applicationId)?.title ?? applicationId} focused`,
    windows,
  };
}

export function desktopReducer(state, action) {
  switch (action.type) {
    case "OPEN_APP":
    case "FOCUS_APP":
      return activateWindow(state, action.applicationId);
    case "MINIMIZE_APP": {
      const nextFocus = getTopVisibleWindow(state.windows, action.applicationId);
      return { ...state, focusedApplication: nextFocus, announcement: `${getApplication(action.applicationId)?.title} minimized`, windows: updateWindow(state.windows, action.applicationId, { minimized: true }) };
    }
    case "CLOSE_APP": {
      const nextFocus = getTopVisibleWindow(state.windows, action.applicationId);
      return { ...state, focusedApplication: nextFocus, announcement: `${getApplication(action.applicationId)?.title} closed`, windows: updateWindow(state.windows, action.applicationId, { isOpen: false, minimized: false }) };
    }
    case "MOVE_APP": {
      const current = state.windows[action.applicationId];
      const application = getApplication(action.applicationId);
      if (!current || !application || current.maximized || current.snap) return state;
      return { ...state, windows: updateWindow(state.windows, action.applicationId, { bounds: clampBounds({ ...current.bounds, x: action.x, y: action.y }, state.viewport, application.minimumSize) }) };
    }
    case "RESIZE_APP": {
      const current = state.windows[action.applicationId];
      const application = getApplication(action.applicationId);
      if (!current || !application || current.maximized || current.snap) return state;
      const bounds = action.edge
        ? resizeBounds(current.bounds, action.edge, action.deltaX, action.deltaY, state.viewport, application.minimumSize)
        : clampBounds({ ...current.bounds, width: action.width, height: action.height }, state.viewport, application.minimumSize);
      return { ...state, windows: updateWindow(state.windows, action.applicationId, { bounds }) };
    }
    case "RESTORE_FOR_MOVE": {
      const current = state.windows[action.applicationId];
      const application = getApplication(action.applicationId);
      if (!current || !application || (!current.maximized && !current.snap)) return state;
      return activateWindow(state, action.applicationId, {
        bounds: clampBounds(current.restoreBounds ?? application.defaultBounds, state.viewport, application.minimumSize),
        restoreBounds: null,
        maximized: false,
        snap: null,
      });
    }
    case "SNAP_APP": {
      const current = state.windows[action.applicationId];
      if (!current || !["left", "right", "maximize"].includes(action.mode)) return state;
      const restoreBounds = current.snap || current.maximized ? current.restoreBounds : current.bounds;
      return activateWindow(state, action.applicationId, { restoreBounds: restoreBounds ?? current.bounds, bounds: snapBounds(action.mode, state.viewport), maximized: action.mode === "maximize", snap: action.mode });
    }
    case "TOGGLE_MAXIMIZE": {
      const current = state.windows[action.applicationId];
      if (!current) return state;
      if (current.maximized || current.snap) {
        const application = getApplication(action.applicationId);
        return activateWindow(state, action.applicationId, { bounds: clampBounds(current.restoreBounds ?? application.defaultBounds, state.viewport, application.minimumSize), restoreBounds: null, maximized: false, snap: null });
      }
      return desktopReducer(state, { type: "SNAP_APP", applicationId: action.applicationId, mode: "maximize" });
    }
    case "SET_SNAP_PREVIEW":
      return state.snapPreview === action.mode ? state : { ...state, snapPreview: action.mode };
    case "TOGGLE_LAUNCHER":
      return { ...state, launcherOpen: action.open ?? !state.launcherOpen, modal: null };
    case "SET_MODAL":
      return { ...state, modal: action.modal, launcherOpen: false };
    case "MOVE_DESKTOP_SHORTCUT":
      if (!state.desktopShortcutPositions[action.applicationId]) return state;
      return { ...state, desktopShortcutPositions: { ...state.desktopShortcutPositions, [action.applicationId]: clampDesktopShortcutPosition({ x: action.x, y: action.y }, state.viewport) }, announcement: `${getApplication(action.applicationId)?.title} shortcut moved` };
    case "SET_VIEWPORT":
      return { ...state, viewport: action.viewport, desktopShortcutPositions: constrainDesktopShortcutPositions(state.desktopShortcutPositions, action.viewport), windows: constrainAllWindows(state.windows, action.viewport), snapPreview: null };
    case "SET_LIFECYCLE":
      return { ...state, lifecycle: action.lifecycle, connection: action.connection ?? state.connection, announcement: action.announcement ?? `Workspace ${action.lifecycle}` };
    case "SET_APPEARANCE":
      return { ...state, appearance: action.appearance === "dark" ? "dark" : "light", announcement: `${action.appearance} appearance selected` };
    case "SET_DENSITY":
      return { ...state, density: action.density === "comfortable" ? "comfortable" : "compact" };
    case "SET_REDUCE_MOTION":
      return { ...state, reduceMotion: Boolean(action.value) };
    case "SET_TASKBAR_LABELS":
      return { ...state, taskbarLabels: Boolean(action.value) };
    case "SET_WORKSPACE_NAME":
      return { ...state, workspaceName: String(action.value || "Workspace").trim().slice(0, 48) || "Workspace", announcement: "Workspace name updated" };
    case "LOAD_SCENARIO":
      return createDesktopState({ scenarioId: action.scenarioId, viewport: state.viewport });
    default:
      return state;
  }
}
