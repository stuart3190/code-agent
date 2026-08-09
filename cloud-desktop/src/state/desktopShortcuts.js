import { applicationRegistry } from "../apps/registry.js";

export const DESKTOP_SHORTCUT_SIZE = Object.freeze({ width: 68, height: 68 });

const DESKTOP_SHELL_INSETS = Object.freeze({ left: 112, top: 44, right: 0, bottom: 54 });
const DESKTOP_SHORTCUT_PADDING = 16;

export function createDesktopShortcutPositions() {
  return Object.fromEntries(applicationRegistry.map((application, index) => [application.id, {
    x: DESKTOP_SHORTCUT_PADDING + (index % 2) * 78,
    y: 18 + Math.floor(index / 2) * 76,
  }]));
}

export function getDesktopCanvasSize(viewport) {
  return {
    width: Math.max(DESKTOP_SHORTCUT_SIZE.width, viewport.width - DESKTOP_SHELL_INSETS.left - DESKTOP_SHELL_INSETS.right),
    height: Math.max(DESKTOP_SHORTCUT_SIZE.height, viewport.height - DESKTOP_SHELL_INSETS.top - DESKTOP_SHELL_INSETS.bottom),
  };
}

export function clampDesktopShortcutPosition(position, viewport) {
  const canvas = getDesktopCanvasSize(viewport);
  return {
    x: Math.round(Math.min(Math.max(Number(position?.x) || 0, DESKTOP_SHORTCUT_PADDING), Math.max(DESKTOP_SHORTCUT_PADDING, canvas.width - DESKTOP_SHORTCUT_SIZE.width - DESKTOP_SHORTCUT_PADDING))),
    y: Math.round(Math.min(Math.max(Number(position?.y) || 0, DESKTOP_SHORTCUT_PADDING), Math.max(DESKTOP_SHORTCUT_PADDING, canvas.height - DESKTOP_SHORTCUT_SIZE.height - DESKTOP_SHORTCUT_PADDING))),
  };
}

export function constrainDesktopShortcutPositions(positions, viewport) {
  const defaults = createDesktopShortcutPositions();
  return Object.fromEntries(applicationRegistry.map((application) => [
    application.id,
    clampDesktopShortcutPosition(positions?.[application.id] ?? defaults[application.id], viewport),
  ]));
}
