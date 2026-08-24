// Authoritative generic application-structure registry for Builder V2.
//
// Capability modules own behaviour. Scaffold families own only the reusable application
// structure around that behaviour: mounting, navigation, screen/state boundaries and extension
// seams. Entries are deliberately domain-neutral; no family describes a product vertical.

export const SCAFFOLD_REGISTRY_VERSION = 1;

const family = (entry) => Object.freeze({
  version: "1.0.0",
  optionalCapabilities: [],
  expectedEntities: [],
  expectedState: [],
  routes: [],
  screens: [],
  extensionPoints: [],
  protectedModules: ["src/lib/scaffolds/composed/ScaffoldApp.jsx"],
  compositionConstraints: [],
  compatibleWith: ["*"],
  deterministicTests: [],
  status: "proven",
  ...entry,
});

export const SCAFFOLDS = Object.freeze({
  app_shell: family({
    scaffoldId: "app_shell",
    purpose: "Mount the application, resolve routes, and contain render/loading failures.",
    supportedInteractionPatterns: ["route_mount", "screen_render", "error_boundary", "loading_boundary"],
    requiredCapabilities: [],
    expectedState: ["active route", "render failure"],
    routes: ["all contracted routes"], screens: ["one mounted slot per contracted route"],
    stateOwnership: { owns: ["active route"], excludes: ["domain state", "durable records"] },
    persistenceOwnership: { owns: [], delegatesToCapabilities: true },
    extensionPoints: ["mounted_screen", "navigation_chrome"],
    compositionConstraints: ["exactly one app_shell", "every contracted route has one screen owner"],
    verificationContract: { routeReachable: true, screenMounted: true, errorContained: true },
    deterministicTests: ["route-resolution", "screen-mount", "render-boundary"],
  }),
  content_navigation: family({
    scaffoldId: "content_navigation",
    purpose: "Provide reachable navigation across independently composed screens.",
    supportedInteractionPatterns: ["navigate", "list_routes", "responsive_navigation"],
    requiredCapabilities: [],
    expectedState: ["current route"], routes: ["two or more contracted routes"],
    screens: ["navigation shell"],
    stateOwnership: { owns: ["navigation presentation"], excludes: ["screen state"] },
    persistenceOwnership: { owns: [] }, extensionPoints: ["navigation_item", "navigation_visuals"],
    compositionConstraints: ["route targets must exist in app_shell"],
    verificationContract: { navigationTargetsMountedRoutes: true },
    deterministicTests: ["navigation-targets"],
  }),
  crud_resource: family({
    scaffoldId: "crud_resource",
    purpose: "Structure resource list, detail and mutation surfaces around the proven CRUD capability.",
    supportedInteractionPatterns: ["list", "detail", "create", "update", "delete", "reload"],
    requiredCapabilities: ["crud"], optionalCapabilities: ["session", "roles"],
    expectedEntities: ["one or more contract entities"],
    expectedState: ["record collection", "selected record", "mutation status"],
    routes: ["resource list or detail route"], screens: ["resource shell"],
    stateOwnership: { owns: ["resource UI selection"], delegates: ["durable entity records"] },
    persistenceOwnership: { owns: [], delegatesToCapabilities: ["crud"] },
    extensionPoints: ["resource_list", "resource_detail", "resource_form", "resource_actions"],
    compositionConstraints: ["durable mutations use the composed CRUD interface"],
    verificationContract: { actions: ["create", "read", "update", "delete"], reloadWhenContracted: true },
    deterministicTests: ["crud-slot-composition", "persistence-delegation"],
  }),
  catalogue_detail: family({
    scaffoldId: "catalogue_detail",
    purpose: "Structure collection browsing and mounted item detail navigation.",
    supportedInteractionPatterns: ["browse", "filter", "select_item", "view_detail"],
    requiredCapabilities: [], optionalCapabilities: ["crud", "interaction-primitives"],
    expectedState: ["collection", "selected item"], routes: ["catalogue", "detail"],
    screens: ["catalogue shell", "detail shell"],
    stateOwnership: { owns: ["selection and presentation"], delegates: ["durable records"] },
    persistenceOwnership: { owns: [], delegatesToCapabilities: ["crud"] },
    extensionPoints: ["catalogue_item", "catalogue_filter", "detail_body"],
    compositionConstraints: ["detail navigation resolves to a mounted route or mounted screen state"],
    verificationContract: { listReachable: true, detailReachable: true },
    deterministicTests: ["list-detail-reachability"],
  }),
  dashboard: family({
    scaffoldId: "dashboard",
    purpose: "Provide a composable summary/list/detail workspace without owning domain calculations.",
    supportedInteractionPatterns: ["summary", "filter", "list", "drill_down"],
    requiredCapabilities: [], optionalCapabilities: ["crud"],
    expectedState: ["summary view", "active filter"], routes: ["dashboard or overview"],
    screens: ["dashboard shell"],
    stateOwnership: { owns: ["dashboard presentation and filters"], excludes: ["domain metrics"] },
    persistenceOwnership: { owns: [], delegatesToCapabilities: ["crud"] },
    extensionPoints: ["summary_panel", "metric_calculation", "dashboard_section"],
    compositionConstraints: ["domain metrics remain capability or custom-extension outputs"],
    verificationContract: { summaryMounted: true, drillDownReachable: true },
    deterministicTests: ["dashboard-slots"],
  }),
  workflow: family({
    scaffoldId: "workflow",
    purpose: "Provide ordered multi-step mechanics, review and confirmation slots.",
    supportedInteractionPatterns: ["step", "back", "advance", "review", "confirm", "restore"],
    requiredCapabilities: [], optionalCapabilities: ["wizard", "crud", "interaction-primitives"],
    expectedState: ["current step", "draft values", "review state", "completion state"],
    routes: ["workflow entry"], screens: ["workflow shell"],
    stateOwnership: { owns: ["ephemeral step presentation"], delegates: ["workflow machine", "durable result"] },
    persistenceOwnership: { owns: [], delegatesToCapabilities: ["wizard", "crud"] },
    extensionPoints: ["workflow_step", "workflow_review", "workflow_confirmation", "workflow_rule"],
    compositionConstraints: ["consumers follow declared state producers", "confirmation remains reachable"],
    verificationContract: { orderedSteps: true, reviewObservable: true, confirmationObservable: true },
    deterministicTests: ["workflow-order", "review-confirmation-mount"],
  }),
  project_workspace: family({
    scaffoldId: "project_workspace",
    purpose: "Structure project create/open/save lifecycle around durable capability ownership.",
    supportedInteractionPatterns: ["create_project", "open_project", "save_project", "reopen_project"],
    requiredCapabilities: ["crud"], optionalCapabilities: ["session", "interaction-primitives"],
    expectedEntities: ["project-like contract entity"],
    expectedState: ["active project identity", "working draft", "save status"],
    routes: ["project list", "workspace"], screens: ["project workspace shell"],
    stateOwnership: { owns: ["active project selection", "working draft"], delegates: ["durable project"] },
    persistenceOwnership: { owns: [], delegatesToCapabilities: ["crud"] },
    extensionPoints: ["workspace_toolbar", "workspace_surface", "project_configuration"],
    compositionConstraints: ["save/reopen uses the same durable entity identity"],
    verificationContract: { createOpenSave: true, reopenWhenContracted: true },
    deterministicTests: ["project-lifecycle", "save-reopen"],
  }),
  canvas_editor: family({
    scaffoldId: "canvas_editor",
    purpose: "Provide editor/tool/surface boundaries for interactive object manipulation.",
    supportedInteractionPatterns: ["select_object", "manipulate_object", "tool_action", "inspect_state"],
    requiredCapabilities: ["interaction-primitives"], optionalCapabilities: ["crud"],
    expectedState: ["selection", "tool state", "viewport state", "object presentation"],
    routes: ["workspace"], screens: ["editor shell"],
    stateOwnership: { owns: ["editor UI state"], excludes: ["domain calculations", "durable objects"] },
    persistenceOwnership: { owns: [], delegatesToCapabilities: ["crud"] },
    extensionPoints: ["editor_toolbar", "editor_surface", "property_panel", "calculation_adapter"],
    compositionConstraints: ["domain transforms are bounded capability/custom-extension calls"],
    verificationContract: { objectStateObservable: true, controlsMounted: true },
    deterministicTests: ["editor-slot-composition", "object-state-observation"],
  }),
  scheduling: family({
    scaffoldId: "scheduling",
    purpose: "Structure availability selection and confirmation around the proven booking capability.",
    supportedInteractionPatterns: ["availability", "select_slot", "confirm", "cancel", "restore"],
    requiredCapabilities: ["booking"], optionalCapabilities: ["wizard", "session"],
    expectedEntities: ["booking-owned entity"],
    expectedState: ["availability", "selection", "confirmation", "cancellation"],
    routes: ["schedule entry or status"], screens: ["scheduling shell"],
    stateOwnership: { owns: ["schedule presentation"], delegates: ["booking state"] },
    persistenceOwnership: { owns: [], delegatesToCapabilities: ["booking"] },
    extensionPoints: ["availability_view", "slot_visual", "schedule_rule"],
    compositionConstraints: ["booking mutations use the composed booking interface"],
    verificationContract: { availabilityObservable: true, confirmationReference: true },
    deterministicTests: ["booking-shell-composition"],
  }),
  auth_account: family({
    scaffoldId: "auth_account",
    purpose: "Structure account/session screens around the protected session capability.",
    supportedInteractionPatterns: ["sign_up", "sign_in", "recover_session", "sign_out"],
    requiredCapabilities: ["session"], optionalCapabilities: ["roles"],
    expectedState: ["session status", "account action status"],
    routes: ["account route when contracted"], screens: ["account shell"],
    stateOwnership: { owns: ["account presentation"], delegates: ["session identity"] },
    persistenceOwnership: { owns: [], delegatesToCapabilities: ["session"] },
    extensionPoints: ["account_form", "account_profile"],
    compositionConstraints: ["credentials and session state remain capability-owned"],
    verificationContract: { sessionActionObservable: true },
    deterministicTests: ["account-shell-composition"],
  }),
  admin_management: family({
    scaffoldId: "admin_management",
    purpose: "Provide protected management surface boundaries around roles and resource capabilities.",
    supportedInteractionPatterns: ["authorize", "manage", "moderate", "audit_view"],
    requiredCapabilities: ["roles"], optionalCapabilities: ["crud", "session"],
    expectedState: ["authorization state", "management selection"],
    routes: ["admin route"], screens: ["admin shell"],
    stateOwnership: { owns: ["management presentation"], delegates: ["authorization", "records"] },
    persistenceOwnership: { owns: [], delegatesToCapabilities: ["crud", "roles"] },
    extensionPoints: ["management_table", "management_action", "audit_panel"],
    compositionConstraints: ["privileged actions require declared authorization capability"],
    verificationContract: { authorizationEnforced: true, actionObservable: true },
    deterministicTests: ["admin-authorization-boundary"],
  }),
  export_output: family({
    scaffoldId: "export_output",
    purpose: "Provide an observable output/download seam without inventing serialization logic.",
    supportedInteractionPatterns: ["prepare_output", "download", "print", "share"],
    requiredCapabilities: [], optionalCapabilities: ["crud", "interaction-primitives"],
    expectedState: ["output readiness", "output result"], routes: ["source or output route"],
    screens: ["export shell"],
    stateOwnership: { owns: ["output presentation"], excludes: ["domain serialization"] },
    persistenceOwnership: { owns: [] },
    extensionPoints: ["output_serializer", "output_preview", "output_action"],
    compositionConstraints: ["novel serialization is a bounded custom extension"],
    verificationContract: { outputActionMounted: true, resultObservable: true },
    deterministicTests: ["export-extension-seam"],
  }),
});

const REQUIRED_FIELDS = [
  "scaffoldId", "version", "purpose", "supportedInteractionPatterns", "requiredCapabilities",
  "optionalCapabilities", "expectedEntities", "expectedState", "routes", "screens",
  "stateOwnership", "persistenceOwnership", "extensionPoints", "protectedModules",
  "compositionConstraints", "compatibleWith", "verificationContract", "deterministicTests", "status",
];

export function scaffoldEntry(scaffoldId) {
  return SCAFFOLDS[String(scaffoldId || "")] || null;
}

export function validateScaffoldRegistry(registry = SCAFFOLDS) {
  const problems = [];
  for (const [id, entry] of Object.entries(registry || {})) {
    if (entry?.scaffoldId !== id) problems.push(`${id}: scaffoldId must match registry key`);
    for (const field of REQUIRED_FIELDS) {
      if (entry?.[field] === undefined || entry?.[field] === null) problems.push(`${id}: missing ${field}`);
    }
    if (!["proven", "experimental", "unavailable"].includes(entry?.status)) {
      problems.push(`${id}: invalid status ${entry?.status}`);
    }
  }
  return { ok: problems.length === 0, problems, version: SCAFFOLD_REGISTRY_VERSION };
}

export function scaffoldRegistrySummary(ids = Object.keys(SCAFFOLDS)) {
  return ids.map((id) => {
    const entry = scaffoldEntry(id);
    return entry ? { scaffoldId: id, version: entry.version, purpose: entry.purpose,
      status: entry.status, requiredCapabilities: entry.requiredCapabilities,
      extensionPoints: entry.extensionPoints } : null;
  }).filter(Boolean);
}
