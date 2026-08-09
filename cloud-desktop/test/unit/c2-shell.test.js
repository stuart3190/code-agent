import { describe, expect, it } from "vitest";
import { createDesktopState, desktopReducer } from "../../src/state/desktopReducer.js";
import { PERSISTENCE_VERSION, parseDesktopSession, serializeDesktopState } from "../../src/state/persistence.js";
import { normalizeZOrder, resizeBounds, snapBounds, Z_INDEX_NORMALIZE_AT } from "../../src/state/windowManager.js";

const viewport = { width: 1440, height: 900 };

describe("C2 hardened cloud desktop shell", () => {
  it("normalizes repeated focus while preserving visible stacking order", () => {
    let state = createDesktopState({ scenarioId: "several-apps", viewport });
    state.windows.browser.zIndex = Z_INDEX_NORMALIZE_AT - 1;
    state = desktopReducer(state, { type: "FOCUS_APP", applicationId: "files" });
    const open = Object.values(state.windows).filter((windowState) => windowState.isOpen);
    expect(Math.max(...open.map((windowState) => windowState.zIndex))).toBeLessThan(32);
    expect(state.windows.files.zIndex).toBe(Math.max(...open.map((windowState) => windowState.zIndex)));
    const normalized = normalizeZOrder(state.windows);
    expect(normalized.files.zIndex).toBe(state.windows.files.zIndex);
  });

  it("resizes from every edge without invalid or unreachable geometry", () => {
    const bounds = { x: 300, y: 180, width: 700, height: 500 };
    for (const edge of ["n", "e", "s", "w", "ne", "nw", "se", "sw"]) {
      const result = resizeBounds(bounds, edge, -9999, 9999, viewport, { width: 560, height: 410 });
      expect(Object.values(result).every(Number.isFinite)).toBe(true);
      expect(result.width).toBeGreaterThanOrEqual(560);
      expect(result.height).toBeGreaterThanOrEqual(410);
      expect(result.x).toBeGreaterThanOrEqual(10);
      expect(result.y).toBeGreaterThanOrEqual(10);
    }
  });

  it("restores exact floating bounds after left, right and maximize snaps", () => {
    for (const mode of ["left", "right", "maximize"]) {
      let state = createDesktopState({ scenarioId: "normal-active", viewport });
      state = desktopReducer(state, { type: "MOVE_APP", applicationId: "browser", x: 460, y: 160 });
      const before = state.windows.browser.bounds;
      state = desktopReducer(state, { type: "SNAP_APP", applicationId: "browser", mode });
      expect(state.windows.browser.bounds).toEqual(snapBounds(mode, viewport));
      state = desktopReducer(state, { type: "TOGGLE_MAXIMIZE", applicationId: "browser" });
      expect(state.windows.browser.bounds).toEqual(before);
    }
  });

  it("migrates v1 sessions and repairs mixed stale state without losing valid windows", () => {
    const state = createDesktopState({ scenarioId: "normal-active", viewport });
    const persisted = JSON.parse(serializeDesktopState(state));
    persisted.version = 1;
    persisted.focusedApplication = "unknown-app";
    persisted.windows.unknown = { bounds: { x: -1, y: -1, width: 1, height: 1 }, isOpen: true, zIndex: 99999 };
    persisted.windows.browser.bounds = { x: -9999, y: 9999, width: 99999, height: -2 };
    const result = parseDesktopSession(JSON.stringify(persisted));
    expect(PERSISTENCE_VERSION).toBe(2);
    expect(result.recovery).toBe("repaired");
    expect(result.state.windows.unknown).toBeUndefined();
    expect(result.state.windows.files).toBeDefined();
    const restored = createDesktopState({ viewport: { width: 800, height: 1000 }, persisted: result.state });
    expect(restored.focusedApplication).not.toBe("unknown-app");
    expect(restored.windows.browser.bounds.width).toBeGreaterThan(0);
  });

  it("recovers malformed and unsupported sessions deterministically", () => {
    expect(parseDesktopSession("{bad").state).toBeNull();
    expect(parseDesktopSession(JSON.stringify({ version: 999, windows: {} })).state).toBeNull();
    expect(parseDesktopSession(JSON.stringify({ version: 2, windows: { unknown: { bounds: { x: 1, y: 1, width: 1, height: 1 } } } })).state).toBeNull();
  });

  it("re-constrains visible geometry across dramatic viewport changes without destroying restore bounds", () => {
    let state = createDesktopState({ scenarioId: "normal-active", viewport });
    state = desktopReducer(state, { type: "SNAP_APP", applicationId: "browser", mode: "left" });
    const restore = state.windows.browser.restoreBounds;
    state = desktopReducer(state, { type: "SET_VIEWPORT", viewport: { width: 780, height: 1040 } });
    expect(state.windows.browser.restoreBounds).toEqual(restore);
    expect(state.windows.browser.bounds.width).toBeLessThan(780);
  });

  it("models every fixture lifecycle and recovers locally without network behavior", () => {
    for (const scenarioId of ["workspace-saving", "workspace-waking", "workspace-reconnecting", "workspace-degraded", "workspace-suspended", "recovery-required"]) {
      expect(createDesktopState({ scenarioId, viewport }).lifecycle).not.toBe("ready");
    }
    let state = createDesktopState({ scenarioId: "workspace-waking", viewport });
    state = desktopReducer(state, { type: "SET_LIFECYCLE", lifecycle: "ready", connection: "recovered" });
    expect(state).toMatchObject({ lifecycle: "ready", connection: "recovered" });
  });
});
