// Scaffold-aware repair ownership. Pure routing only: it never mutates source or weakens a gate.

import { SCAFFOLD_COMPOSED_ROOT, SCAFFOLD_ENTRY_PATH } from "./scaffoldComposer.mjs";

const unique = (values) => [...new Set((values || []).filter(Boolean))];

export const SCAFFOLD_REPAIR_CLASS = Object.freeze({
  INTERNAL: "scaffold_internal",
  INTEGRATION: "scaffold_integration",
  CUSTOM_EXTENSION: "custom_extension",
  UI_COMPOSITION: "ui_composition",
  UNREACHABLE: "unreachable_module",
  UNATTRIBUTED: "unattributed",
});

export function routeScaffoldDefect(defect, scaffoldGraph) {
  const modules = unique([...(defect?.modules || []), ...(defect?.failureRefs || [])]);
  const protectedInternal = modules.find((path) => path === SCAFFOLD_ENTRY_PATH
    || String(path).startsWith(`${SCAFFOLD_COMPOSED_ROOT}/`));
  if (protectedInternal) return {
    classification: SCAFFOLD_REPAIR_CLASS.INTERNAL,
    owner: "platform", repairableByModel: false, targetFiles: [],
    reason: `failure is inside protected deterministic scaffold module ${protectedInternal}`,
  };
  const extensions = (scaffoldGraph?.extensions || []).filter((extension) => modules.includes(extension.module));
  if (extensions.length) return {
    classification: SCAFFOLD_REPAIR_CLASS.CUSTOM_EXTENSION,
    owner: "app", repairableByModel: true,
    targetFiles: unique(extensions.flatMap((extension) => extension.allowedFiles || [extension.module])),
    reason: "failure belongs to a bounded custom extension contract",
  };
  const owner = (scaffoldGraph?.journeyOwnership || []).find((row) => row.journeyId === defect?.journeyId);
  const unreachable = defect?.evidence?.surfaceIntegration?.unreachableJourneyModules || [];
  if (unreachable.length && owner?.mountedModule) return {
    classification: SCAFFOLD_REPAIR_CLASS.UNREACHABLE,
    owner: "app", repairableByModel: true,
    targetFiles: unique([owner.mountedModule, ...unreachable]),
    reason: "repair the mounted screen integration seam, not an unrendered source file alone",
  };
  if (modules.includes("src/extensions/capabilityConfiguration.js")) return {
    classification: SCAFFOLD_REPAIR_CLASS.INTEGRATION,
    owner: "app", repairableByModel: true,
    targetFiles: unique(["src/extensions/capabilityConfiguration.js", owner?.mountedModule]),
    reason: "failure belongs to model-owned scaffold/capability configuration integration",
  };
  if (owner?.mountedModule) return {
    classification: SCAFFOLD_REPAIR_CLASS.UI_COMPOSITION,
    owner: "app", repairableByModel: true,
    targetFiles: unique([owner.mountedModule, ...modules.filter((path) => path !== SCAFFOLD_ENTRY_PATH
      && !String(path).startsWith(`${SCAFFOLD_COMPOSED_ROOT}/`))]),
    reason: "repair the owning mounted screen/component while preserving scaffold internals",
  };
  return { classification: SCAFFOLD_REPAIR_CLASS.UNATTRIBUTED, owner: "unknown",
    repairableByModel: false, targetFiles: [], reason: "no scaffold journey owner was established" };
}
