import { applicationRegistry } from "../apps/registry.js";

export const PERSISTENCE_KEY = "thrallo.cloudDesktop.fixture.v1";
export const PERSISTENCE_VERSION = 2;

const allowedApplications = new Set(applicationRegistry.map((application) => application.id));
const allowedSnap = new Set(["left", "right", "maximize"]);

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

export function migrateDesktopState(parsed) {
  if (!parsed || typeof parsed !== "object") return null;
  if (parsed.version === PERSISTENCE_VERSION) return parsed;
  if (parsed.version === 1) return { ...parsed, version: PERSISTENCE_VERSION, migratedFrom: 1 };
  return null;
}

export function parseDesktopSession(rawValue) {
  let parsed;
  try {
    parsed = migrateDesktopState(JSON.parse(rawValue));
  } catch {
    return { state: null, recovery: "Saved session was unreadable and has been reset" };
  }
  if (!parsed || !parsed.windows || typeof parsed.windows !== "object") {
    return { state: null, recovery: "Saved session version was unsupported and has been reset" };
  }

  let recovered = Boolean(parsed.migratedFrom);
  const windows = {};
  for (const [id, candidate] of Object.entries(parsed.windows)) {
    if (!allowedApplications.has(id) || !candidate || !validBounds(candidate.bounds)) {
      recovered = true;
      continue;
    }
    const snap = allowedSnap.has(candidate.snap) ? candidate.snap : null;
    const maximized = snap === "maximize" || Boolean(candidate.maximized && !candidate.snap);
    windows[id] = {
      isOpen: Boolean(candidate.isOpen),
      minimized: Boolean(candidate.minimized),
      maximized,
      snap: maximized ? "maximize" : snap,
      bounds: { ...candidate.bounds },
      restoreBounds: validBounds(candidate.restoreBounds) ? { ...candidate.restoreBounds } : null,
      zIndex: Number.isFinite(candidate.zIndex) && candidate.zIndex >= 0 ? candidate.zIndex : 0,
    };
    if (windows[id].zIndex !== candidate.zIndex || snap !== candidate.snap) recovered = true;
  }
  if (Object.keys(parsed.windows).length > 0 && Object.keys(windows).length === 0) {
    return { state: null, recovery: "Saved session contained no supported applications and has been reset" };
  }

  const desktopShortcutPositions = {};
  if (parsed.desktopShortcutPositions && typeof parsed.desktopShortcutPositions === "object") {
    for (const [id, position] of Object.entries(parsed.desktopShortcutPositions)) {
      if (allowedApplications.has(id) && validShortcutPosition(position)) desktopShortcutPositions[id] = { x: position.x, y: position.y };
      else recovered = true;
    }
  } else if (parsed.desktopShortcutPositions !== undefined) recovered = true;

  const focusedApplication = allowedApplications.has(parsed.focusedApplication) && windows[parsed.focusedApplication]?.isOpen && !windows[parsed.focusedApplication]?.minimized
    ? parsed.focusedApplication
    : null;
  if (parsed.focusedApplication && !focusedApplication) recovered = true;

  return {
    state: {
      scenarioId: typeof parsed.scenarioId === "string" ? parsed.scenarioId : "normal-active",
      workspaceName: typeof parsed.workspaceName === "string" && parsed.workspaceName.trim() ? parsed.workspaceName.slice(0, 48) : "My Workspace",
      appearance: parsed.appearance === "dark" ? "dark" : "light",
      density: parsed.density === "comfortable" ? "comfortable" : "compact",
      reduceMotion: Boolean(parsed.reduceMotion),
      taskbarLabels: parsed.taskbarLabels !== false,
      focusedApplication,
      desktopShortcutPositions,
      windows,
      recoveryNotice: recovered ? "Saved workspace layout was repaired and restored" : undefined,
    },
    recovery: recovered ? "repaired" : null,
  };
}

export function parseDesktopState(rawValue) {
  return parseDesktopSession(rawValue).state;
}

export function loadPersistedDesktopSession(storage) {
  if (!storage) return { state: null, recovery: null };
  const rawValue = storage.getItem(PERSISTENCE_KEY);
  if (!rawValue) return { state: null, recovery: null };
  const result = parseDesktopSession(rawValue);
  if (!result.state) storage.removeItem(PERSISTENCE_KEY);
  return result;
}

export function loadPersistedDesktopState(storage) {
  return loadPersistedDesktopSession(storage).state;
}

export function saveDesktopState(storage, state) {
  if (!storage) return;
  storage.setItem(PERSISTENCE_KEY, serializeDesktopState(state));
}

export function clearDesktopState(storage) {
  storage?.removeItem(PERSISTENCE_KEY);
}
