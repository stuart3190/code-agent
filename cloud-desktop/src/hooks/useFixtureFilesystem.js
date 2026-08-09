import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { createFixtureFilesystemProvider, deriveStorageSnapshot } from "../filesystem/fixtureProvider.js";
import { loadFilesystemSession, saveFilesystemSession } from "../filesystem/persistence.js";

function requestedScenario(shellStorageState) {
  if (typeof window !== "undefined") {
    const explicit = new URLSearchParams(window.location.search).get("filesScenario");
    if (explicit) return { scenario: explicit, explicit: true };
  }
  if (shellStorageState === "warning") return { scenario: "storage-warning", explicit: false };
  if (shellStorageState === "near-full") return { scenario: "storage-exhausted", explicit: false };
  return { scenario: "normal-files", explicit: false };
}

function initialPathForScenario(scenario) {
  if (scenario === "large-folder") return "/Downloads/Large Archive";
  if (scenario === "empty-folder") return "/My Files/Empty";
  if (scenario.includes("trash") || scenario.startsWith("restore")) return "/Trash";
  return "/My Files";
}

export function useFixtureFilesystem({ storage = typeof window === "undefined" ? null : window.localStorage, shellStorageState = "normal" } = {}) {
  const request = requestedScenario(shellStorageState);
  const persisted = useMemo(() => loadFilesystemSession(storage), [storage]);
  const scenario = request.explicit || shellStorageState !== "normal" ? request.scenario : (persisted.session?.scenario ?? request.scenario);
  const provider = useMemo(() => createFixtureFilesystemProvider({
    scenario,
    seed: `thrallo-c3:${scenario}`,
    journal: persisted.session?.scenario === scenario ? persisted.session.journal : [],
  }), [scenario]);
  const snapshot = useSyncExternalStore(provider.subscribe, provider.getSnapshot, provider.getSnapshot);
  const initialPath = persisted.session?.scenario === scenario ? persisted.session.ui.currentPath : initialPathForScenario(scenario);
  const [ui, setUiState] = useState(() => ({
    currentPath: initialPath,
    view: persisted.session?.scenario === scenario ? persisted.session.ui.view : "list",
    sort: persisted.session?.scenario === scenario ? persisted.session.ui.sort : "name-asc",
    query: "",
    page: 1,
    selectedIds: [],
    history: [initialPath],
    historyIndex: 0,
  }));

  useEffect(() => {
    const nextInitialPath = persisted.session?.scenario === scenario
      ? persisted.session.ui.currentPath
      : initialPathForScenario(scenario);
    setUiState((current) => ({
      ...current,
      currentPath: nextInitialPath,
      query: "",
      page: 1,
      selectedIds: [],
      history: [nextInitialPath],
      historyIndex: 0,
    }));
  }, [provider, scenario]);

  useEffect(() => {
    saveFilesystemSession(storage, scenario, snapshot.journal, ui);
  }, [storage, scenario, snapshot.journal, ui.currentPath, ui.view, ui.sort]);

  const api = useMemo(() => ({
    provider,
    snapshot,
    storage: deriveStorageSnapshot(snapshot),
    scenario,
    recovery: scenario === "corrupted-fixture-recovery" ? "repaired" : persisted.recovery,
    ui,
    setUi(update) { setUiState((current) => ({ ...current, ...(typeof update === "function" ? update(current) : update) })); },
    navigate(path) {
      setUiState((current) => {
        if (current.currentPath === path) return current;
        const nextHistory = [...current.history.slice(0, current.historyIndex + 1), path];
        return { ...current, currentPath: path, query: "", page: 1, selectedIds: [], history: nextHistory, historyIndex: nextHistory.length - 1 };
      });
    },
    back() {
      setUiState((current) => current.historyIndex <= 0 ? current : {
        ...current,
        currentPath: current.history[current.historyIndex - 1],
        historyIndex: current.historyIndex - 1,
        selectedIds: [],
        page: 1,
      });
    },
    forward() {
      setUiState((current) => current.historyIndex >= current.history.length - 1 ? current : {
        ...current,
        currentPath: current.history[current.historyIndex + 1],
        historyIndex: current.historyIndex + 1,
        selectedIds: [],
        page: 1,
      });
    },
  }), [provider, snapshot, scenario, persisted.recovery, ui]);
  return api;
}
