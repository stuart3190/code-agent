import { applicationRegistry, getApplication } from "../apps/registry.js";

export const TASKBAR_SIZE = 64;
export const DESKTOP_HEADER_SIZE = 44;

export function clampBounds(bounds, viewport, minimumSize) {
  const availableWidth = Math.max(320, viewport.width - 122);
  const availableHeight = Math.max(260, viewport.height - TASKBAR_SIZE - DESKTOP_HEADER_SIZE - 18);
  const width = Math.min(Math.max(bounds.width, minimumSize.width), availableWidth);
  const height = Math.min(Math.max(bounds.height, minimumSize.height), availableHeight);
  const minX = 112;
  const maxX = Math.max(minX, viewport.width - width - 14);
  const minY = DESKTOP_HEADER_SIZE + 10;
  const maxY = Math.max(minY, viewport.height - TASKBAR_SIZE - height - 10);
  return {
    x: Math.min(Math.max(bounds.x, minX), maxX),
    y: Math.min(Math.max(bounds.y, minY), maxY),
    width,
    height,
  };
}

export function snapBounds(mode, viewport) {
  const workX = 122;
  const workY = DESKTOP_HEADER_SIZE + 8;
  const workWidth = viewport.width - workX - 12;
  const workHeight = viewport.height - TASKBAR_SIZE - workY - 8;
  if (mode === "left") return { x: workX, y: workY, width: Math.floor(workWidth / 2) - 4, height: workHeight };
  if (mode === "right") return { x: workX + Math.floor(workWidth / 2) + 4, y: workY, width: Math.ceil(workWidth / 2) - 4, height: workHeight };
  return { x: workX, y: workY, width: workWidth, height: workHeight };
}

export function createWindowState(applicationId, zIndex, viewport) {
  const application = getApplication(applicationId);
  if (!application) throw new Error(`Unknown cloud desktop application: ${applicationId}`);
  return {
    applicationId,
    isOpen: true,
    minimized: false,
    maximized: false,
    snap: null,
    bounds: clampBounds(application.defaultBounds, viewport, application.minimumSize),
    restoreBounds: null,
    zIndex,
  };
}

export function createWindowMap(openApplications, focusedApplication, viewport) {
  const openSet = new Set(openApplications);
  const windows = {};
  let zIndex = 10;
  for (const application of applicationRegistry) {
    const isOpen = openSet.has(application.id);
    windows[application.id] = {
      ...createWindowState(application.id, isOpen ? zIndex++ : 0, viewport),
      isOpen,
    };
  }
  if (windows[focusedApplication]?.isOpen) windows[focusedApplication].zIndex = zIndex + 1;
  return windows;
}

export function highestZ(windows) {
  return Math.max(10, ...Object.values(windows).map((windowState) => windowState.zIndex || 0));
}

export function getTopVisibleWindow(windows, excludedApplicationId) {
  return Object.values(windows)
    .filter((windowState) => windowState.isOpen && !windowState.minimized && windowState.applicationId !== excludedApplicationId)
    .sort((left, right) => right.zIndex - left.zIndex)[0]?.applicationId ?? null;
}

export function updateWindow(windows, applicationId, update) {
  return { ...windows, [applicationId]: { ...windows[applicationId], ...update } };
}

export function constrainAllWindows(windows, viewport) {
  return Object.fromEntries(Object.entries(windows).map(([applicationId, windowState]) => {
    const application = getApplication(applicationId);
    if (!application) return [applicationId, windowState];
    const nextBounds = windowState.snap || windowState.maximized
      ? snapBounds(windowState.snap ?? "maximize", viewport)
      : clampBounds(windowState.bounds, viewport, application.minimumSize);
    return [applicationId, { ...windowState, bounds: nextBounds }];
  }));
}
