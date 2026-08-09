const freeze = (value) => Object.freeze(value);

export const SCENARIO_IDS = freeze([
  "first-launch",
  "normal-active",
  "several-apps",
  "storage-warning",
  "offline-recovery",
  "dark-compatibility",
]);

export const C2_LIFECYCLE_SCENARIO_IDS = freeze([
  "workspace-saving",
  "workspace-waking",
  "workspace-reconnecting",
  "workspace-degraded",
  "workspace-suspended",
  "recovery-required",
]);

const scenarios = {
  "first-launch": {
    label: "First launch",
    workspaceName: "My Workspace",
    connection: "ready",
    lifecycle: "ready",
    storageState: "normal",
    appearance: "light",
    openApps: ["thrallo"],
    focusedApp: "thrallo",
  },
  "normal-active": {
    label: "Normal active workspace",
    workspaceName: "My Workspace",
    connection: "connected",
    lifecycle: "ready",
    storageState: "normal",
    appearance: "light",
    openApps: ["thrallo", "browser"],
    focusedApp: "browser",
  },
  "several-apps": {
    label: "Several apps running",
    workspaceName: "My Workspace",
    connection: "connected",
    lifecycle: "ready",
    storageState: "normal",
    appearance: "light",
    openApps: ["thrallo", "browser", "files", "terminal", "github"],
    focusedApp: "files",
  },
  "storage-warning": {
    label: "Storage warning",
    workspaceName: "My Workspace",
    connection: "connected",
    lifecycle: "ready",
    storageState: "warning",
    appearance: "light",
    openApps: ["files", "storage"],
    focusedApp: "storage",
  },
  "offline-recovery": {
    label: "Offline and recovery",
    workspaceName: "My Workspace",
    connection: "offline",
    lifecycle: "recovery_required",
    storageState: "normal",
    appearance: "light",
    openApps: ["files", "settings"],
    focusedApp: "files",
  },
  "workspace-saving": {
    label: "Workspace saving",
    workspaceName: "My Workspace",
    connection: "connected",
    lifecycle: "saving",
    storageState: "normal",
    appearance: "light",
    openApps: ["files", "browser"],
    focusedApp: "files",
  },
  "workspace-waking": {
    label: "Workspace waking",
    workspaceName: "My Workspace",
    connection: "reconnecting",
    lifecycle: "waking",
    storageState: "normal",
    appearance: "light",
    openApps: ["thrallo"],
    focusedApp: "thrallo",
  },
  "workspace-reconnecting": {
    label: "Workspace reconnecting",
    workspaceName: "My Workspace",
    connection: "reconnecting",
    lifecycle: "reconnecting",
    storageState: "normal",
    appearance: "light",
    openApps: ["browser", "files"],
    focusedApp: "browser",
  },
  "workspace-degraded": {
    label: "Workspace degraded",
    workspaceName: "My Workspace",
    connection: "unavailable",
    lifecycle: "degraded",
    storageState: "warning",
    appearance: "light",
    openApps: ["storage", "settings"],
    focusedApp: "storage",
  },
  "workspace-suspended": {
    label: "Workspace suspended",
    workspaceName: "My Workspace",
    connection: "offline",
    lifecycle: "suspended",
    storageState: "normal",
    appearance: "light",
    openApps: ["thrallo"],
    focusedApp: "thrallo",
  },
  "recovery-required": {
    label: "Recovery required",
    workspaceName: "My Workspace",
    connection: "offline",
    lifecycle: "recovery_required",
    storageState: "normal",
    appearance: "light",
    openApps: ["files", "settings"],
    focusedApp: "files",
  },
  "dark-compatibility": {
    label: "Dark theme compatibility",
    workspaceName: "My Workspace",
    connection: "connected",
    lifecycle: "ready",
    storageState: "near-full",
    appearance: "dark",
    openApps: ["browser", "terminal"],
    focusedApp: "terminal",
  },
};

export function getScenario(scenarioId = "normal-active") {
  const scenario = scenarios[scenarioId] ?? scenarios["normal-active"];
  return freeze({
    id: [...SCENARIO_IDS, ...C2_LIFECYCLE_SCENARIO_IDS].includes(scenarioId) ? scenarioId : "normal-active",
    ...scenario,
    openApps: freeze([...scenario.openApps]),
  });
}

export function listScenarios() {
  return SCENARIO_IDS.map((id) => getScenario(id));
}

export function listDevelopmentScenarios() {
  return [...SCENARIO_IDS, ...C2_LIFECYCLE_SCENARIO_IDS].map((id) => getScenario(id));
}
