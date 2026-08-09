import { APPLICATION_CONTRACT_VERSION } from "./applicationContract.js";

const defineApplication = (application) => Object.freeze({
  instancePolicy: "single",
  requiredCapabilities: Object.freeze(["fixture"]),
  pinned: true,
  recent: false,
  ...application,
  minimumSize: Object.freeze(application.minimumSize),
  defaultBounds: Object.freeze(application.defaultBounds),
});

export const applicationRegistry = Object.freeze([
  defineApplication({ id: "thrallo", title: "Thrallo", icon: "thrallo", description: "Your AI software-building workspace", recent: true, minimumSize: { width: 440, height: 390 }, defaultBounds: { x: 176, y: 88, width: 540, height: 620 } }),
  defineApplication({ id: "browser", title: "Browser", icon: "browser", description: "Browse safe workspace pages", recent: true, minimumSize: { width: 560, height: 410 }, defaultBounds: { x: 420, y: 76, width: 840, height: 690 } }),
  defineApplication({ id: "files", title: "Files", icon: "files", description: "Organise fixture cloud files", recent: true, minimumSize: { width: 540, height: 390 }, defaultBounds: { x: 332, y: 130, width: 820, height: 610 } }),
  defineApplication({ id: "terminal", title: "Terminal", icon: "terminal", description: "Try deterministic commands", minimumSize: { width: 520, height: 330 }, defaultBounds: { x: 530, y: 238, width: 710, height: 440 } }),
  defineApplication({ id: "github", title: "GitHub", icon: "github", description: "Review fixture repositories", minimumSize: { width: 560, height: 410 }, defaultBounds: { x: 360, y: 112, width: 790, height: 620 } }),
  defineApplication({ id: "storage", title: "Storage", icon: "storage", description: "Understand workspace storage", minimumSize: { width: 430, height: 380 }, defaultBounds: { x: 760, y: 108, width: 520, height: 540 } }),
  defineApplication({ id: "settings", title: "Settings", icon: "settings", description: "Personalise this fixture desktop", minimumSize: { width: 560, height: 430 }, defaultBounds: { x: 430, y: 100, width: 760, height: 640 } }),
]);

export function getApplication(applicationId) {
  return applicationRegistry.find((application) => application.id === applicationId) ?? null;
}

export function getApplicationRegistry() {
  return Object.freeze({
    contractVersion: APPLICATION_CONTRACT_VERSION,
    applications: applicationRegistry,
  });
}
