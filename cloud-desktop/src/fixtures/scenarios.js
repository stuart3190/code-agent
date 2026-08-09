const freeze = (value) => Object.freeze(value);

export const SCENARIO_IDS = freeze([
  "first-launch",
  "normal-active",
  "several-apps",
  "storage-warning",
  "offline-recovery",
  "dark-compatibility",
]);

const scenarios = {
  "first-launch": {
    label: "First launch",
    workspaceName: "My workspace",
    connection: "ready",
    storageState: "normal",
    appearance: "light",
    openApps: ["thrallo"],
    focusedApp: "thrallo",
  },
  "normal-active": {
    label: "Normal active workspace",
    workspaceName: "Atlas",
    connection: "connected",
    storageState: "normal",
    appearance: "light",
    openApps: ["thrallo", "browser"],
    focusedApp: "browser",
  },
  "several-apps": {
    label: "Several apps running",
    workspaceName: "Atlas",
    connection: "connected",
    storageState: "normal",
    appearance: "light",
    openApps: ["thrallo", "browser", "files", "terminal", "github"],
    focusedApp: "files",
  },
  "storage-warning": {
    label: "Storage warning",
    workspaceName: "Atlas",
    connection: "connected",
    storageState: "warning",
    appearance: "light",
    openApps: ["files", "storage"],
    focusedApp: "storage",
  },
  "offline-recovery": {
    label: "Offline and recovery",
    workspaceName: "Atlas recovery",
    connection: "offline",
    storageState: "normal",
    appearance: "light",
    openApps: ["files", "settings"],
    focusedApp: "files",
  },
  "dark-compatibility": {
    label: "Dark theme compatibility",
    workspaceName: "Night workspace",
    connection: "connected",
    storageState: "near-full",
    appearance: "dark",
    openApps: ["browser", "terminal"],
    focusedApp: "terminal",
  },
};

export function getScenario(scenarioId = "normal-active") {
  const scenario = scenarios[scenarioId] ?? scenarios["normal-active"];
  return freeze({
    id: SCENARIO_IDS.includes(scenarioId) ? scenarioId : "normal-active",
    ...scenario,
    openApps: freeze([...scenario.openApps]),
  });
}

export function listScenarios() {
  return SCENARIO_IDS.map((id) => getScenario(id));
}
