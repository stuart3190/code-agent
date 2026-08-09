import { applicationRegistry } from "../apps/registry.js";

export const PERSISTENCE_KEY = "thrallo.cloudDesktop.fixture.v1";
export const PERSISTENCE_VERSION = 1;

const allowedApplications = new Set(applicationRegistry.map((application) => application.id));

export function serializeDesktopState(state) {
  return JSON.stringify({
    version: PERSISTENCE_VERSION,
    scenarioId: state.scenarioId,
    workspaceName: state.workspaceName,
    appearance: state.appearance,
    density: state.density,
    reduceMotion: state.reduceMotion,
    taskbarLabels: state.taskbarLabels,
    focusedApplication: state.focusedApplication,
    desktopShortcutPositions: state.desktopShortcutPositions,
    windows: Object.fromEntries(Object.entries(state.windows).map(([id, windowState]) => [id, {
      isOpen: windowState.isOpen,
      minimized: windowState.minimized,
      maximized: windowState.maximized,
      snap: windowState.snap,
      bounds: windowState.bounds,
      restoreBounds: windowState.restoreBounds,
      zIndex: windowState.zIndex,
    }])),
  });
}

function validBounds(bounds) {
  return bounds && ["x", "y", "width", "height"].every((key) => Number.isFinite(bounds[key]));
}

function validShortcutPosition(position) {
  return position && Number.isFinite(position.x) && Number.isFinite(position.y);
}

export function parseDesktopState(rawValue) {
  try {
    const parsed = JSON.parse(rawValue);
    if (!parsed || parsed.version !== PERSISTENCE_VERSION || typeof parsed.windows !== "object") return null;
    const windows = {};
    for (const [id, state] of Object.entries(parsed.windows)) {
      if (!allowedApplications.has(id) || !validBounds(state?.bounds)) return null;
      windows[id] = {
        isOpen: Boolean(state.isOpen),
        minimized: Boolean(state.minimized),
        maximized: Boolean(state.maximized),
        snap: ["left", "right", "maximize"].includes(state.snap) ? state.snap : null,
        bounds: { ...state.bounds },
        restoreBounds: validBounds(state.restoreBounds) ? { ...state.restoreBounds } : null,
        zIndex: Number.isFinite(state.zIndex) ? state.zIndex : 0,
      };
    }
    const desktopShortcutPositions = {};
    if (parsed.desktopShortcutPositions !== undefined) {
      if (!parsed.desktopShortcutPositions || typeof parsed.desktopShortcutPositions !== "object") return null;
      for (const [id, position] of Object.entries(parsed.desktopShortcutPositions)) {
        if (!allowedApplications.has(id) || !validShortcutPosition(position)) return null;
        desktopShortcutPositions[id] = { x: position.x, y: position.y };
      }
    }
    return {
      scenarioId: typeof parsed.scenarioId === "string" ? parsed.scenarioId : "normal-active",
      workspaceName: typeof parsed.workspaceName === "string" && parsed.workspaceName.trim() ? parsed.workspaceName.slice(0, 48) : "My Workspace",
      appearance: parsed.appearance === "dark" ? "dark" : "light",
      density: parsed.density === "comfortable" ? "comfortable" : "compact",
      reduceMotion: Boolean(parsed.reduceMotion),
      taskbarLabels: parsed.taskbarLabels !== false,
      focusedApplication: allowedApplications.has(parsed.focusedApplication) ? parsed.focusedApplication : null,
      desktopShortcutPositions,
      windows,
    };
  } catch {
    return null;
  }
}

export function loadPersistedDesktopState(storage) {
  if (!storage) return null;
  const rawValue = storage.getItem(PERSISTENCE_KEY);
  if (!rawValue) return null;
  const parsed = parseDesktopState(rawValue);
  if (!parsed) storage.removeItem(PERSISTENCE_KEY);
  return parsed;
}

export function saveDesktopState(storage, state) {
  if (!storage) return;
  storage.setItem(PERSISTENCE_KEY, serializeDesktopState(state));
}

export function clearDesktopState(storage) {
  storage?.removeItem(PERSISTENCE_KEY);
}
