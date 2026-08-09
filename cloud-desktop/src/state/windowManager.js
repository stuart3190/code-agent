import { applicationRegistry, getApplication } from "../apps/registry.js";

export const TASKBAR_SIZE = 54;
export const DESKTOP_HEADER_SIZE = 44;
export const Z_INDEX_BASE = 10;
export const Z_INDEX_NORMALIZE_AT = 512;

const finite = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;

export function usableArea(viewport) {
  const width = Math.max(320, finite(viewport?.width, 1440));
  const height = Math.max(420, finite(viewport?.height, 900));
  const x = 10;
  const y = 10;
  return {
    x,
    y,
    width: Math.max(320, width - 112 - x - 10),
    height: Math.max(260, height - DESKTOP_HEADER_SIZE - TASKBAR_SIZE - y - 10),
  };
}

export function clampBounds(bounds, viewport, minimumSize) {
  const area = usableArea(viewport);
  const minimumWidth = Math.min(area.width, Math.max(320, finite(minimumSize?.width, 320)));
  const minimumHeight = Math.min(area.height, Math.max(260, finite(minimumSize?.height, 260)));
  const width = Math.min(Math.max(finite(bounds?.width, minimumWidth), minimumWidth), area.width);
  const height = Math.min(Math.max(finite(bounds?.height, minimumHeight), minimumHeight), area.height);
  const maxX = area.x + area.width - width;
  const maxY = area.y + area.height - height;
  return {
    x: Math.min(Math.max(finite(bounds?.x, area.x), area.x), maxX),
    y: Math.min(Math.max(finite(bounds?.y, area.y), area.y), maxY),
    width,
    height,
  };
}

export function snapBounds(mode, viewport) {
  const area = usableArea(viewport);
  const gap = 8;
  if (mode === "left") return { x: area.x, y: area.y, width: Math.floor((area.width - gap) / 2), height: area.height };
  if (mode === "right") {
    const leftWidth = Math.floor((area.width - gap) / 2);
    return { x: area.x + leftWidth + gap, y: area.y, width: area.width - leftWidth - gap, height: area.height };
  }
  return { x: area.x, y: area.y, width: area.width, height: area.height };
}

export function resizeBounds(bounds, edge, deltaX, deltaY, viewport, minimumSize) {
  const area = usableArea(viewport);
  const source = clampBounds(bounds, viewport, minimumSize);
  const minWidth = Math.min(area.width, Math.max(320, finite(minimumSize?.width, 320)));
  const minHeight = Math.min(area.height, Math.max(260, finite(minimumSize?.height, 260)));
  let left = source.x;
  let top = source.y;
  let right = source.x + source.width;
  let bottom = source.y + source.height;
  const dx = finite(deltaX);
  const dy = finite(deltaY);
  if (edge.includes("w")) left = Math.min(right - minWidth, Math.max(area.x, left + dx));
  if (edge.includes("e")) right = Math.max(left + minWidth, Math.min(area.x + area.width, right + dx));
  if (edge.includes("n")) top = Math.min(bottom - minHeight, Math.max(area.y, top + dy));
  if (edge.includes("s")) bottom = Math.max(top + minHeight, Math.min(area.y + area.height, bottom + dy));
  return clampBounds({ x: left, y: top, width: right - left, height: bottom - top }, viewport, minimumSize);
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
  let zIndex = Z_INDEX_BASE;
  for (const application of applicationRegistry) {
    const isOpen = openSet.has(application.id);
    windows[application.id] = { ...createWindowState(application.id, isOpen ? zIndex++ : 0, viewport), isOpen };
  }
  if (windows[focusedApplication]?.isOpen) windows[focusedApplication].zIndex = zIndex + 1;
  return normalizeZOrder(windows);
}

export function highestZ(windows) {
  return Math.max(Z_INDEX_BASE, ...Object.values(windows).map((windowState) => finite(windowState.zIndex)));
}

export function normalizeZOrder(windows) {
  const ranked = Object.values(windows)
    .filter((windowState) => windowState.isOpen)
    .sort((left, right) => finite(left.zIndex) - finite(right.zIndex) || left.applicationId.localeCompare(right.applicationId));
  const ranks = new Map(ranked.map((windowState, index) => [windowState.applicationId, Z_INDEX_BASE + index]));
  return Object.fromEntries(Object.entries(windows).map(([id, windowState]) => [id, {
    ...windowState,
    zIndex: ranks.get(id) ?? 0,
  }]));
}

export function raiseWindow(windows, applicationId) {
  let next = updateWindow(windows, applicationId, { zIndex: highestZ(windows) + 1 });
  if (highestZ(next) >= Z_INDEX_NORMALIZE_AT) next = normalizeZOrder(next);
  return next;
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
  const constrained = Object.fromEntries(Object.entries(windows).map(([applicationId, windowState]) => {
    const application = getApplication(applicationId);
    if (!application) return [applicationId, windowState];
    const nextBounds = windowState.snap || windowState.maximized
      ? snapBounds(windowState.snap ?? "maximize", viewport)
      : clampBounds(windowState.bounds, viewport, application.minimumSize);
    return [applicationId, { ...windowState, bounds: nextBounds }];
  }));
  return normalizeZOrder(constrained);
}
