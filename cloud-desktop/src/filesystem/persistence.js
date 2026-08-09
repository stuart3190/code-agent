import { FILESYSTEM_SCENARIO_IDS } from "./fixtures.js";
import { normalizeVirtualPath } from "./virtualPath.js";

export const FILESYSTEM_PERSISTENCE_KEY = "thrallo.cloudDesktop.files.fixture.v1";
export const FILESYSTEM_PERSISTENCE_VERSION = 1;

const allowedOperations = new Set(["createDirectory", "rename", "move", "copy", "trash", "restore", "delete", "beginFixtureUpload", "beginFixtureDownload", "advanceTransfer", "cancelTransfer"]);

export function parseFilesystemSession(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== FILESYSTEM_PERSISTENCE_VERSION) return { session: null, recovery: "unsupported" };
    const journal = Array.isArray(parsed.journal) ? parsed.journal.filter((entry) => entry && allowedOperations.has(entry.operation) && Array.isArray(entry.args)).slice(0, 200) : [];
    const recovered = journal.length !== (parsed.journal?.length ?? 0);
    let currentPath = "/My Files";
    let pathRecovered = false;
    try { currentPath = normalizeVirtualPath(parsed.ui?.currentPath ?? currentPath); }
    catch { pathRecovered = true; }
    return {
      session: {
        version: FILESYSTEM_PERSISTENCE_VERSION,
        scenario: FILESYSTEM_SCENARIO_IDS.includes(parsed.scenario) ? parsed.scenario : "normal-files",
        journal,
        ui: {
          currentPath,
          view: parsed.ui?.view === "grid" ? "grid" : "list",
          sort: ["name-asc", "name-desc", "modified-desc", "size-desc", "type-asc"].includes(parsed.ui?.sort) ? parsed.ui.sort : "name-asc",
        },
      },
      recovery: recovered || pathRecovered ? "repaired" : null,
    };
  } catch {
    return { session: null, recovery: "corrupt" };
  }
}

export function loadFilesystemSession(storage) {
  if (!storage) return { session: null, recovery: null };
  const raw = storage.getItem(FILESYSTEM_PERSISTENCE_KEY);
  if (!raw) return { session: null, recovery: null };
  const result = parseFilesystemSession(raw);
  if (!result.session) storage.removeItem(FILESYSTEM_PERSISTENCE_KEY);
  return result;
}

export function saveFilesystemSession(storage, scenario, journal, ui) {
  storage?.setItem(FILESYSTEM_PERSISTENCE_KEY, JSON.stringify({ version: FILESYSTEM_PERSISTENCE_VERSION, scenario, journal: journal.slice(-200), ui: { currentPath: ui.currentPath, view: ui.view, sort: ui.sort } }));
}

export function clearFilesystemSession(storage) { storage?.removeItem(FILESYSTEM_PERSISTENCE_KEY); }
