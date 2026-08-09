import { describe, expect, it } from "vitest";
import { evaluateFixtureCommand } from "../../src/apps/TerminalApp.jsx";
import { applicationRegistry } from "../../src/apps/registry.js";
import { getScenario, listScenarios } from "../../src/fixtures/scenarios.js";
import { createDesktopState, desktopReducer } from "../../src/state/desktopReducer.js";
import { parseDesktopState, serializeDesktopState } from "../../src/state/persistence.js";
import { clampDesktopShortcutPosition, createDesktopShortcutPositions } from "../../src/state/desktopShortcuts.js";
import { clampBounds, snapBounds } from "../../src/state/windowManager.js";

const viewport = { width: 1440, height: 900 };

describe("C1 deterministic cloud desktop state", () => {
  it("provides the six required deterministic scenarios", () => {
    expect(listScenarios().map((scenario) => scenario.id)).toEqual([
      "first-launch", "normal-active", "several-apps", "storage-warning", "offline-recovery", "dark-compatibility",
    ]);
    expect(getScenario("storage-warning")).toEqual(getScenario("storage-warning"));
  });

  it("opens, focuses, minimizes, restores, and closes one window per app", () => {
    let state = createDesktopState({ scenarioId: "first-launch", viewport });
    state = desktopReducer(state, { type: "OPEN_APP", applicationId: "files" });
    const zAfterOpen = state.windows.files.zIndex;
    expect(state.focusedApplication).toBe("files");
    expect(state.windows.files.isOpen).toBe(true);
    state = desktopReducer(state, { type: "MINIMIZE_APP", applicationId: "files" });
    expect(state.windows.files.minimized).toBe(true);
    state = desktopReducer(state, { type: "OPEN_APP", applicationId: "files" });
    expect(state.windows.files.minimized).toBe(false);
    expect(state.windows.files.zIndex).toBeGreaterThan(zAfterOpen);
    state = desktopReducer(state, { type: "CLOSE_APP", applicationId: "files" });
    expect(state.windows.files.isOpen).toBe(false);
    expect(Object.keys(state.windows)).toHaveLength(applicationRegistry.length);
  });

  it("moves, resizes, snaps, maximizes and restores safely", () => {
    let state = createDesktopState({ scenarioId: "normal-active", viewport });
    const original = state.windows.browser.bounds;
    state = desktopReducer(state, { type: "MOVE_APP", applicationId: "browser", x: 600, y: 180 });
    state = desktopReducer(state, { type: "RESIZE_APP", applicationId: "browser", width: 700, height: 500 });
    const movedAndResized = state.windows.browser.bounds;
    expect(movedAndResized).toMatchObject({ width: 700, height: 500 });
    expect(movedAndResized.x).toBeGreaterThan(original.x);
    expect(movedAndResized.y).toBeGreaterThan(original.y);
    state = desktopReducer(state, { type: "SNAP_APP", applicationId: "browser", mode: "left" });
    expect(state.windows.browser.bounds).toEqual(snapBounds("left", viewport));
    state = desktopReducer(state, { type: "TOGGLE_MAXIMIZE", applicationId: "browser" });
    expect(state.windows.browser.snap).toBeNull();
    expect(state.windows.browser.bounds).toEqual(movedAndResized);
    expect(original).not.toEqual(state.windows.browser.bounds);
  });

  it("keeps off-screen windows reachable and honors minimum sizes", () => {
    const constrained = clampBounds({ x: -900, y: 5000, width: 20, height: 20 }, viewport, { width: 560, height: 410 });
    expect(constrained.x).toBeGreaterThanOrEqual(112);
    expect(constrained.y).toBeLessThan(900);
    expect(constrained.width).toBeGreaterThanOrEqual(560);
    expect(constrained.height).toBeGreaterThanOrEqual(410);
  });

  it("round-trips versioned persistence and rejects corrupt or incompatible state", () => {
    let state = createDesktopState({ scenarioId: "several-apps", viewport });
    state = desktopReducer(state, { type: "MOVE_DESKTOP_SHORTCUT", applicationId: "settings", x: 412, y: 288 });
    const parsed = parseDesktopState(serializeDesktopState(state));
    expect(parsed.workspaceName).toBe("My Workspace");
    expect(parsed.windows.terminal.isOpen).toBe(true);
    expect(parsed.desktopShortcutPositions.settings).toEqual({ x: 412, y: 288 });
    expect(parseDesktopState("not-json")).toBeNull();
    expect(parseDesktopState(JSON.stringify({ version: 99, windows: {} }))).toBeNull();
    expect(parseDesktopState(JSON.stringify({ version: 1, windows: { intruder: { bounds: { x: 0, y: 0, width: 1, height: 1 } } } }))).toBeNull();
  });

  it("creates a compact deterministic shortcut grid and keeps moved icons reachable", () => {
    const positions = createDesktopShortcutPositions();
    expect(Object.keys(positions)).toEqual(applicationRegistry.map((application) => application.id));
    expect(positions.thrallo).toEqual({ x: 16, y: 18 });
    expect(positions.settings).toEqual({ x: 16, y: 246 });
    expect(clampDesktopShortcutPosition({ x: 9999, y: 9999 }, viewport)).toEqual({ x: 1244, y: 718 });

    let state = createDesktopState({ scenarioId: "first-launch", viewport });
    state = desktopReducer(state, { type: "MOVE_DESKTOP_SHORTCUT", applicationId: "browser", x: -200, y: 6000 });
    expect(state.desktopShortcutPositions.browser).toEqual({ x: 16, y: 718 });
  });

  it("executes only deterministic fixture terminal commands", () => {
    expect(evaluateFixtureCommand("pwd").lines.map((line) => line.text)).toEqual(["/workspace/my-workspace"]);
    expect(evaluateFixtureCommand("git   status").lines[0].text).toBe("On branch main");
    expect(evaluateFixtureCommand("clear").clear).toBe(true);
    expect(evaluateFixtureCommand("curl production.example").lines[0].text).toContain("not available");
  });
});
