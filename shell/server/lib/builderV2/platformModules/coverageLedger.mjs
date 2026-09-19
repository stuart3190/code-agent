// WP0 — the frozen baseline and coverage ledger of the modular-capability migration.
//
// The audit (THRALLO-MODULAR-AUDIT, 2026-09-18) inspected revision e83d4ef and found that Thrallo
// already supplies most low-level runtime deterministically, but that capability coverage,
// contract semantics and generated UI wiring do not share one ownership boundary. The migration
// that follows (WP1–WP15) must never lose a behaviour on the way, so this file pins:
//
//   1. the exact source revision and every versioned artefact format the migration starts from;
//   2. one ledger row for EVERY current registry, scaffold, SDK, runtime-operation and platform
//      entry, each mapped to the module that will own it and the work package that moves it;
//   3. the prompt literal measurements the audit quoted, re-measured here so later work packages
//      report a change in size against a pinned number rather than a remembered one.
//
// Nothing here changes behaviour. A row is a promise about ownership, not an implementation, and
// a later work package that retires or re-versions an entry must update this ledger in the same
// commit — the regression suite compares the ledger against the live registries.

export const COVERAGE_LEDGER_VERSION = 1;

/** The revision the audit inspected and the migration starts from. */
export const BASELINE = Object.freeze({
  revision: "e83d4ef212b08fc2aa9d9ddc0937cd279ad8d042",
  branch: "astra/execution-authority-20260907",
  capturedAt: "2026-09-18",
  audit: "THRALLO-MODULAR-AUDIT (2026-09-18)",
});

/** Every versioned artefact format that a historical contract or snapshot may carry. */
export const BASELINE_FORMAT_VERSIONS = Object.freeze({
  implementationContract: 2,
  buildProfile: 1,
  buildSpec: 3,
  capabilityGraph: 2,
  scaffoldRegistry: 1,
  scaffoldGraph: 3,
  scaffoldComposition: 3,
  capabilityComposition: 1,
  executionProvenance: 2,
  executionSpec: 1,
  routeResolution: 1,
});

/**
 * The formats the CURRENT source emits. Every difference from the baseline is a versioned
 * migration recorded here in the same commit that made it, with the work package that owns it.
 */
export const CURRENT_FORMAT_VERSIONS = Object.freeze({
  ...BASELINE_FORMAT_VERSIONS,
  buildSpec: 4,          // WP1: additive moduleResolution/moduleLock fields; v3 consumers unaffected
  moduleManifest: 1,     // WP1: new
  moduleLock: 1,         // WP1: new
  moduleResolution: 1,   // WP1: new
  deploymentAvailability: 1, // WP1: new
  identityPlan: 1,       // WP3: new — rendered into the composed identity module
  abiLint: 1,            // WP3: new — public-ABI import lint
  accountPolicy: 1,      // WP4: new — app_account_policies row / composed policy
  accountService: 1,     // WP4: new — app-accounts Edge Function + shell service
  entitySchema: 1,       // WP5: new — compiled entity schema carried on the build spec
  recordShapeLint: 1,    // WP5: new — generated record-shape wrapper lint
  routePlan: 1,          // WP6: new — typed route plan stamped onto the scaffold graph
  platformSelection: 1,  // WP6: new — contract-structure selection of non-capability modules
  queryLint: 1,          // WP7: new — generated query-binding lint
  settingsPlan: 1,       // WP8: new — typed settings keys, scopes and defaults
  platformStateService: 1, // WP8: new — app_settings/app_audit_events service and audit config
  behaviourPlan: 1,      // WP9: new — declared workflow graphs, workspace roots and editor surfaces
  deliveryPlan: 1,       // WP10: new — declared file policy, notification events and realtime topics
  insightPlan: 1,        // WP11: new — declared telemetry events, domain metrics and exports
  billingPlan: 1,        // WP12: new — declared plan catalogue and entitlements
  billingService: 1,     // WP12: new — app_subscriptions/app_billing_events lifecycle
  automationPlan: 1,     // WP13: new — declared actions, schedules and connectors
});

/** The immutable snapshot row as written by snapshotStore.createSnapshot(). */
export const BASELINE_SNAPSHOT_ROW_FIELDS = Object.freeze([
  "owner", "project_id", "build_id", "parent_snapshot", "tree_hash", "reason", "state",
  "file_count", "total_tokens", "asset_manifest", "created_at",
]);

/** Protected write-guard patterns at the baseline (patchEngine.PROTECTED_PATHS). */
export const BASELINE_PROTECTED_PATH_SOURCES = Object.freeze([
  "^src\\/lib\\/backend\\/",
  "^src\\/lib\\/visitorSession\\.js$",
  "^src\\/lib\\/capabilities\\/",
  "^src\\/lib\\/scaffolds\\/composed\\/",
]);

/** Runtime paths the orchestrator refreshes from the worker on every checkpoint (audit P1). */
export const BASELINE_RUNTIME_REFRESH_PATTERN = "^src\\/lib\\/(?:capabilities\\/|backend\\/|visitorSession\\.js$|assets\\.js$)";

/** The current write guard and refresh seam: baseline plus the module runtime and app facade (WP3). */
export const CURRENT_PROTECTED_PATH_SOURCES = Object.freeze([
  ...BASELINE_PROTECTED_PATH_SOURCES,
  "^src\\/lib\\/modules\\/",
  "^src\\/lib\\/app\\/",
]);
export const CURRENT_RUNTIME_REFRESH_PATTERN = "^src\\/lib\\/(?:capabilities\\/|backend\\/|modules\\/|visitorSession\\.js$|assets\\.js$)";

/**
 * Literal-text sizes of the prompt constants, measured at the baseline revision. These are the
 * numbers the audit reported (its 12,104 for the contract prompt was measured one edit earlier;
 * 12,115 is the exact length at e83d4ef). They are literal lengths, never dispatched wire sizes.
 */
export const BASELINE_PROMPT_MEASUREMENTS = Object.freeze({
  contractSystemPrompt: 12115,
  patchSystemPrompt: 4995,
  compileCorrectionSystemPrompt: 627,
  headroomFragmentSystemPrompt: 692,
});

/** Retained corpora the migration must keep replaying without provider calls. */
export const BASELINE_RETAINED_FIXTURES = Object.freeze([
  "test/code-agent/fixtures/retained/advanced-20260916",
  "test/code-agent/fixtures/retained/advanced-20260917-fresh",
  "test/code-agent/fixtures/retained/medium-20260917-recessed",
  "test/code-agent/fixtures/retained/medium-20260918-recessed",
  "test/code-agent/fixtures/retained/lumen-advanced-20260916-contract.json",
]);

// Current status vocabulary (audit §4):
//   D — deterministic platform implementation
//   S — deterministically scaffolded into generated applications
//   P — platform primitive plus generated binding/configuration/UI
//   G — generated application behaviour
export const STATUS = Object.freeze({ D: "D", S: "S", P: "P", G: "G" });

/** The full proposed module catalogue (audit §7), keyed by the id its manifest will carry. */
export const MODULE_CATALOGUE = Object.freeze({
  "thrallo.core": { title: "Runtime core", workPackage: 1, difficulty: "M" },
  "thrallo.identity": { title: "Identity/session", workPackage: 3, difficulty: "M" },
  "thrallo.accounts": { title: "Accounts/profiles", workPackage: 4, difficulty: "H" },
  "thrallo.authorization": { title: "Authorization", workPackage: 4, difficulty: "H" },
  "thrallo.fixtures": { title: "Verification/demo fixtures", workPackage: 4, difficulty: "M" },
  "thrallo.schema": { title: "Schema", workPackage: 5, difficulty: "H" },
  "thrallo.entities": { title: "Entities", workPackage: 5, difficulty: "H" },
  "thrallo.query": { title: "Query/collections", workPackage: 7, difficulty: "M" },
  "thrallo.forms": { title: "Forms/interactions", workPackage: 7, difficulty: "M" },
  "thrallo.async": { title: "Async resource state", workPackage: 7, difficulty: "M" },
  "thrallo.routing": { title: "Routing", workPackage: 6, difficulty: "M" },
  "thrallo.realtime": { title: "Realtime", workPackage: 10, difficulty: "M/H" },
  "thrallo.workflow": { title: "Workflow", workPackage: 9, difficulty: "M" },
  "thrallo.workspace": { title: "Workspace lifecycle", workPackage: 9, difficulty: "M" },
  "thrallo.editor": { title: "Editor state/history", workPackage: 9, difficulty: "M" },
  "thrallo.browser3d": { title: "Browser 3D", workPackage: 9, difficulty: "M" },
  "thrallo.booking": { title: "Booking", workPackage: 9, difficulty: "M" },
  "thrallo.contact": { title: "Contact capture", workPackage: 9, difficulty: "L" },
  "thrallo.newsletter": { title: "Newsletter capture", workPackage: 9, difficulty: "L" },
  "thrallo.settings": { title: "Settings/preferences", workPackage: 8, difficulty: "M" },
  "thrallo.audit": { title: "Audit/history", workPackage: 8, difficulty: "H" },
  "thrallo.admin": { title: "Admin management", workPackage: 4, difficulty: "H" },
  "thrallo.exports": { title: "Exports/artifacts", workPackage: 11, difficulty: "M" },
  "thrallo.files": { title: "Files/storage", workPackage: 10, difficulty: "M" },
  "thrallo.notifications": { title: "Notifications", workPackage: 10, difficulty: "M" },
  "thrallo.analyticsEvents": { title: "Analytics events", workPackage: 11, difficulty: "L/M" },
  "thrallo.analyticsQueries": { title: "Analytics queries", workPackage: 11, difficulty: "M" },
  "thrallo.billing": { title: "Billing/entitlements", workPackage: 12, difficulty: "H" },
  "thrallo.jobs": { title: "Jobs/usage", workPackage: 13, difficulty: "M" },
  "thrallo.schedules": { title: "Scheduled actions", workPackage: 13, difficulty: "M" },
  "thrallo.httpConnectors": { title: "HTTP connectors", workPackage: 13, difficulty: "M" },
  "thrallo.aiActions": { title: "AI/provider actions", workPackage: 13, difficulty: "M" },
  "thrallo.media": { title: "Media processing", workPackage: 13, difficulty: "M" },
  "thrallo.documents": { title: "Document processing", workPackage: 13, difficulty: "M" },
  "thrallo.knowledge": { title: "Knowledge", workPackage: 13, difficulty: "M/H" },
  "thrallo.metaConnector": { title: "Meta connector", workPackage: 13, difficulty: "M" },
  "thrallo.assets": { title: "Asset delivery", workPackage: 13, difficulty: "L" },
});

export const LEDGER_KINDS = Object.freeze([
  "capability", "scaffold_family", "scaffold_primitive", "sdk_surface", "runtime_operation_family",
  "platform_service", "requirement_signal", "execution_control",
]);

const row = (kind, id, fields) => Object.freeze({ kind, id, removed: false, ...fields });

/**
 * One row per current entry. `status` is what ships today; `targetModule` is the module that
 * will own it; `workPackage` is where that move lands; `retains` names the current export or path
 * that must keep working through an adapter until the move is complete.
 */
export const COVERAGE_LEDGER = Object.freeze([
  // ── 4.2 the eight registered Builder V2 capabilities ─────────────────────────────────────
  row("capability", "crud", { status: "D/S", targetModule: "thrallo.entities", workPackage: 5,
    retains: "src/lib/capabilities/crud.js makeEntityStore",
    disposition: "expand into schema, entity, query and reactive-data modules; flat-record adapter retained" }),
  row("capability", "session", { status: "D/S", targetModule: "thrallo.identity", workPackage: 3,
    retains: "src/lib/capabilities/session.js ensureSession/currentUser/signUp/signIn/signOut/resetPassword/confirmReset; alias auth",
    disposition: "identity/session module with explicit visitor/member modes and a reactive controller" }),
  row("capability", "roles", { status: "D/S", targetModule: "thrallo.authorization", workPackage: 4,
    retains: "src/lib/capabilities/roles.js isOwner/requireOwner",
    disposition: "preserve ownership adapter; add a genuine server authorization module" }),
  row("capability", "booking", { status: "D/S/P", targetModule: "thrallo.booking", workPackage: 9,
    retains: "src/lib/capabilities/booking.js makeBookingSystem",
    disposition: "versioned booking module; slots/configuration stay declarative" }),
  row("capability", "wizard", { status: "D/S/P", targetModule: "thrallo.workflow", workPackage: 9,
    retains: "src/lib/capabilities/wizard.js makeWizardMachine/makeWizardPersistence",
    disposition: "workflow module with explicit persistence mode" }),
  row("capability", "contact", { status: "D/S/P", targetModule: "thrallo.contact", workPackage: 9,
    retains: "src/lib/capabilities/forms.js makeContactForm",
    disposition: "contact capture module; persistence distinct from delivery" }),
  row("capability", "newsletter", { status: "D/S/P", targetModule: "thrallo.newsletter", workPackage: 9,
    retains: "src/lib/capabilities/forms.js makeNewsletter",
    disposition: "subscription capture module; delivery separate" }),
  // WP4 — real accounts (added; the audit's P0 "application roles/admin exceed the roles capability")
  row("capability", "accounts", { status: "D/S", targetModule: "thrallo.accounts", workPackage: 4,
    retains: "src/lib/modules/accounts.js createAccountsController; app-accounts Edge Function",
    disposition: "profile reads/updates and membership state through the accounts service; replaces generic appUser records" }),
  row("capability", "authorization", { status: "D/S", targetModule: "thrallo.authorization", workPackage: 4,
    retains: "src/lib/modules/accounts.js createAuthorization + policy.js; roles.js ownership adapter retained",
    disposition: "policy over server-derived memberships; client evaluation shapes UI only" }),
  row("capability", "admin", { status: "D/S", targetModule: "thrallo.admin", workPackage: 4,
    retains: "src/lib/modules/accounts.js createAdmin; app-accounts commands invite/provision/setRole/setStatus",
    disposition: "authorized admin commands; replaces fake user CRUD and generated authority checks" }),
  // WP15 — query (added; the last generic fallthrough: a filtered read written as generated
  // client-side filtering over whatever page happened to be loaded)
  row("capability", "query", { status: "D/S", targetModule: "thrallo.query", workPackage: 15,
    retains: "src/lib/modules/query.js compileQuery/createCollection; src/lib/modules/collections.js",
    disposition: "a compiled query the backend executes across pages; replaces generated client-side filtering" }),
  // WP8 — settings and audit (added; the audit's "settings singleton inferred from prose")
  row("capability", "settings", { status: "D/S", targetModule: "thrallo.settings", workPackage: 8,
    retains: "src/lib/modules/settings.js compileSettings/createSettingsController; app-accounts settings commands",
    disposition: "typed keys with declared scopes and defaults; replaces the fabricated settings record and its default glue" }),
  row("capability", "audit", { status: "D/S", targetModule: "thrallo.audit", workPackage: 8,
    retains: "src/lib/modules/audit.js createHistoryController; app-accounts history command",
    disposition: "platform-appended, authorised, redacted history; the application reads and never writes it" }),
  row("capability", "interaction-primitives", { status: "D/S", targetModule: "thrallo.forms", workPackage: 7,
    retains: "src/lib/capabilities/react.js useCapabilityState/useCapabilityAction/useSemanticField/useSemanticSelection/useSemanticAction/useFlowAdvance/useStatusRegion",
    disposition: "headless form/action/semantic-binding module" }),

  // ── 4.3 the twelve scaffold families ─────────────────────────────────────────────────────
  row("scaffold_family", "app_shell", { status: "S", targetModule: "thrallo.routing", workPackage: 6,
    disposition: "keep mounting mechanics; presentation becomes app-owned layout with an outlet" }),
  row("scaffold_family", "content_navigation", { status: "S/P", targetModule: "thrallo.routing", workPackage: 6,
    disposition: "route metadata modular; navigation design generated" }),
  row("scaffold_family", "crud_resource", { status: "S/P", targetModule: "thrallo.entities", workPackage: 5,
    disposition: "promote behaviour into entity hooks" }),
  row("scaffold_family", "catalogue_detail", { status: "S/P", targetModule: "thrallo.query", workPackage: 7,
    disposition: "query/routing modules" }),
  row("scaffold_family", "dashboard", { status: "S/P", targetModule: "thrallo.analyticsQueries", workPackage: 11,
    disposition: "no general analytics engine is supplied today; aggregate engine plus generated formulas" }),
  row("scaffold_family", "workflow", { status: "S/P", targetModule: "thrallo.workflow", workPackage: 9,
    disposition: "workflow module" }),
  row("scaffold_family", "project_workspace", { status: "S/P", targetModule: "thrallo.workspace", workPackage: 9,
    disposition: "workspace lifecycle module" }),
  row("scaffold_family", "canvas_editor", { status: "S/P", targetModule: "thrallo.editor", workPackage: 9,
    disposition: "editor primitives; domain transforms stay generated" }),
  row("scaffold_family", "scheduling", { status: "S/P", targetModule: "thrallo.booking", workPackage: 9,
    disposition: "booking module" }),
  row("scaffold_family", "auth_account", { status: "S/P", targetModule: "thrallo.identity", workPackage: 3,
    disposition: "identity/accounts modules" }),
  row("scaffold_family", "admin_management", { status: "S/P", targetModule: "thrallo.admin", workPackage: 4,
    disposition: "currently insufficient to establish real RBAC/admin capability; real admin operation API" }),
  row("scaffold_family", "export_output", { status: "S/P", targetModule: "thrallo.exports", workPackage: 11,
    disposition: "serialization often generated; artifact/serialization service" }),

  // ── 4.3 reusable primitives the scaffold composer emits ──────────────────────────────────
  row("scaffold_primitive", "useFormState", { status: "S", targetModule: "thrallo.forms", workPackage: 7,
    retains: "src/lib/scaffolds/composed/primitives.jsx", disposition: "headless form runtime" }),
  row("scaffold_primitive", "useWorkflowState", { status: "S", targetModule: "thrallo.workflow", workPackage: 9,
    retains: "src/lib/scaffolds/composed/primitives.jsx", disposition: "workflow module" }),
  row("scaffold_primitive", "useResourceState", { status: "S", targetModule: "thrallo.async", workPackage: 7,
    retains: "src/lib/scaffolds/composed/primitives.jsx",
    disposition: "basic list/mutation state today; full query cache, conflict protocol and pagination belong to async/query modules" }),
  row("scaffold_primitive", "useCatalogueState", { status: "S", targetModule: "thrallo.query", workPackage: 7,
    retains: "src/lib/scaffolds/composed/primitives.jsx", disposition: "query specification and engine" }),
  row("scaffold_primitive", "useProjectWorkspace", { status: "S", targetModule: "thrallo.workspace", workPackage: 9,
    retains: "src/lib/scaffolds/composed/primitives.jsx", disposition: "workspace lifecycle module" }),
  row("scaffold_primitive", "useCanvasState", { status: "S", targetModule: "thrallo.editor", workPackage: 9,
    retains: "src/lib/scaffolds/composed/primitives.jsx", disposition: "editor state/history module" }),
  row("scaffold_primitive", "matchRouteParams", { status: "S", targetModule: "thrallo.routing", workPackage: 6,
    retains: "src/lib/scaffolds/composed/primitives.jsx", disposition: "route compiler" }),
  row("scaffold_primitive", "ScaffoldRouteContext", { status: "S", targetModule: "thrallo.routing", workPackage: 6,
    retains: "src/lib/scaffolds/composed/primitives.jsx", disposition: "route context provided by the compiled router" }),
  row("scaffold_primitive", "useRoute", { status: "S", targetModule: "thrallo.routing", workPackage: 6,
    retains: "src/lib/scaffolds/composed/primitives.jsx", disposition: "typed useRoute" }),
  row("scaffold_primitive", "useRouteParams", { status: "S", targetModule: "thrallo.routing", workPackage: 6,
    retains: "src/lib/scaffolds/composed/primitives.jsx; alias useParams", disposition: "typed route parameters" }),
  row("scaffold_primitive", "useNavigate", { status: "S", targetModule: "thrallo.routing", workPackage: 6,
    retains: "src/lib/scaffolds/composed/primitives.jsx", disposition: "history navigation" }),
  row("scaffold_primitive", "useLocation", { status: "S", targetModule: "thrallo.routing", workPackage: 6,
    retains: "src/lib/scaffolds/composed/primitives.jsx", disposition: "route compiler" }),
  row("scaffold_primitive", "RouteLink", { status: "S", targetModule: "thrallo.routing", workPackage: 6,
    retains: "src/lib/scaffolds/composed/primitives.jsx; alias Link", disposition: "link bindings require bound parameters" }),
  row("scaffold_primitive", "NavLink", { status: "S", targetModule: "thrallo.routing", workPackage: 6,
    retains: "src/lib/scaffolds/composed/primitives.jsx", disposition: "link bindings" }),
  row("scaffold_primitive", "Navigate", { status: "S", targetModule: "thrallo.routing", workPackage: 6,
    retains: "src/lib/scaffolds/composed/primitives.jsx", disposition: "redirect binding" }),
  row("scaffold_primitive", "ScaffoldLoadingBoundary", { status: "S", targetModule: "thrallo.routing", workPackage: 6,
    retains: "src/lib/scaffolds/composed/primitives.jsx", disposition: "loading boundary; presentation generated" }),
  row("scaffold_primitive", "ScaffoldErrorBoundary", { status: "S", targetModule: "thrallo.routing", workPackage: 6,
    retains: "src/lib/scaffolds/composed/primitives.jsx", disposition: "error boundary; presentation generated" }),
  row("scaffold_primitive", "AppShell", { status: "S", targetModule: "thrallo.routing", workPackage: 6,
    retains: "src/lib/scaffolds/composed/primitives.jsx",
    disposition: "outer navigation wrapper becomes an app-owned layout with an outlet" }),
  row("scaffold_primitive", "NavigationShell", { status: "S", targetModule: "thrallo.routing", workPackage: 6,
    retains: "src/lib/scaffolds/composed/primitives.jsx", disposition: "optional presentation only" }),
  row("scaffold_primitive", "ResourceShell", { status: "S", targetModule: null, workPackage: 15,
    retains: "src/lib/scaffolds/composed/primitives.jsx", disposition: "optional presentation primitive; never behavioural authority" }),
  row("scaffold_primitive", "CatalogueDetailShell", { status: "S", targetModule: null, workPackage: 15,
    retains: "src/lib/scaffolds/composed/primitives.jsx", disposition: "optional presentation primitive" }),
  row("scaffold_primitive", "DashboardShell", { status: "S", targetModule: null, workPackage: 15,
    retains: "src/lib/scaffolds/composed/primitives.jsx", disposition: "optional presentation primitive" }),
  row("scaffold_primitive", "WorkflowShell", { status: "S", targetModule: null, workPackage: 15,
    retains: "src/lib/scaffolds/composed/primitives.jsx", disposition: "optional presentation primitive" }),
  row("scaffold_primitive", "ProjectWorkspaceShell", { status: "S", targetModule: null, workPackage: 15,
    retains: "src/lib/scaffolds/composed/primitives.jsx", disposition: "optional presentation primitive" }),
  row("scaffold_primitive", "CanvasEditorShell", { status: "S", targetModule: null, workPackage: 15,
    retains: "src/lib/scaffolds/composed/primitives.jsx", disposition: "optional presentation primitive" }),
  row("scaffold_primitive", "SchedulingShell", { status: "S", targetModule: null, workPackage: 15,
    retains: "src/lib/scaffolds/composed/primitives.jsx", disposition: "optional presentation primitive" }),
  row("scaffold_primitive", "AuthAccountShell", { status: "S", targetModule: null, workPackage: 15,
    retains: "src/lib/scaffolds/composed/primitives.jsx", disposition: "optional presentation primitive" }),
  row("scaffold_primitive", "AdminManagementShell", { status: "S", targetModule: null, workPackage: 15,
    retains: "src/lib/scaffolds/composed/primitives.jsx", disposition: "optional presentation primitive" }),
  row("scaffold_primitive", "ExportOutputShell", { status: "S", targetModule: null, workPackage: 15,
    retains: "src/lib/scaffolds/composed/primitives.jsx", disposition: "optional presentation primitive" }),

  // ── 4.4 backend SDK surfaces (src/lib/backend/index.js) ──────────────────────────────────
  row("sdk_surface", "auth", { status: "D/S", targetModule: "thrallo.identity", workPackage: 3,
    members: ["signUp", "signIn", "currentUser", "signOut", "resetPassword", "confirmReset"],
    retains: "src/lib/backend/index.js auth", disposition: "app-scoped authentication (app-auth Edge Function; app_users, auth identities, reset/event tables)" }),
  row("sdk_surface", "visitorSession", { status: "D/S", targetModule: "thrallo.identity", workPackage: 3,
    members: ["ensureAppVisitorSession", "invalidateAppVisitorSession"],
    retains: "src/lib/visitorSession.js ensureVisitorSession", disposition: "explicit visitor mode" }),
  row("sdk_surface", "db.entity", { status: "D/S", targetModule: "thrallo.entities", workPackage: 5,
    // updateVersioned is the WP5 addition: a conditional update on the stored version, which is
    // what makes an atomic merge possible without leaving the generic JSONB table.
    members: ["create", "get", "list", "count", "update", "updateVersioned", "delete", "subscribe"],
    retains: "src/lib/backend/index.js db.entity(type)", disposition: "generic entities JSONB table behind an adapter; typed record shape" }),
  row("sdk_surface", "db.entity.list-options", { status: "D/S/P", targetModule: "thrallo.query", workPackage: 7,
    members: ["filters", "order", "ascending", "limit", "cursor"],
    retains: "backend entity-list implementation", disposition: "query module: validated AST, stable composite cursor" }),
  row("sdk_surface", "db.entity.subscribe", { status: "D/S/P", targetModule: "thrallo.realtime", workPackage: 10,
    members: ["subscribe"], retains: "SDK Postgres change subscription", disposition: "explicit realtime module" }),
  row("sdk_surface", "storage", { status: "D/S/P", targetModule: "thrallo.files", workPackage: 10,
    members: ["upload", "uploadMany", "getUrl", "createSignedUrl", "list", "remove"],
    retains: "src/lib/backend/index.js storage", disposition: "files module; not a V2 capability entry today" }),
  row("sdk_surface", "payments", { status: "D/S/P", targetModule: "thrallo.billing", workPackage: 12,
    members: ["checkout"], retains: "app-payments Edge Function, payment_products",
    disposition: "billing module with subscription coverage explicitly added" }),
  row("sdk_surface", "notifications", { status: "D/S/P", targetModule: "thrallo.notifications", workPackage: 10,
    members: ["list", "unreadCount", "markRead", "markAllRead", "notifySelf", "emailSelf", "emit"],
    retains: "app_notifications, app-actions Edge Function", disposition: "notifications module; no matching V2 registry entry today" }),
  row("sdk_surface", "analytics", { status: "D/S/P", targetModule: "thrallo.analyticsEvents", workPackage: 11,
    members: ["track", "page"], retains: "app-analytics Edge Function, app_analytics_events",
    disposition: "event module; separate from domain metrics" }),
  row("sdk_surface", "actions", { status: "D/S/P", targetModule: "thrallo.jobs", workPackage: 13,
    members: ["invoke", "getJob", "listJobs", "cancel", "subscribe", "wait"],
    retains: "app-runtime Edge Function, project_actions, app_jobs", disposition: "jobs module" }),
  row("sdk_surface", "usage", { status: "D/S", targetModule: "thrallo.jobs", workPackage: 13,
    members: ["getBalance"], retains: "app_usage_ledger, runtime accounting",
    disposition: "module service, separate from Thrallo build-credit accounting" }),
  row("sdk_surface", "knowledge", { status: "D/S/P", targetModule: "thrallo.knowledge", workPackage: 13,
    members: ["search"], retains: "SDK search plus server ingest/search", disposition: "knowledge module" }),
  row("sdk_surface", "accounts", { status: "D/S", targetModule: "thrallo.accounts", workPackage: 4,
    members: ["me", "updateMe", "permissions", "member", "members", "invite", "provision", "setRole", "setStatus"],
    retains: "src/lib/backend/index.js accounts → app-accounts Edge Function", disposition: "WP4 addition: the authoritative account/membership surface" }),
  row("sdk_surface", "integrations.meta", { status: "D/S/P", targetModule: "thrallo.metaConnector", workPackage: 13,
    members: ["overview", "start", "connect", "select", "disconnect"],
    retains: "SDK connection flow and metaConnector.mjs", disposition: "connector module" }),

  // ── 4.4 server runtime operation families (capabilityRuntime.RUNTIME_CAPABILITY_OPERATIONS) ─
  row("runtime_operation_family", "openai", { status: "D", targetModule: "thrallo.aiActions", workPackage: 13,
    members: ["text", "structured", "image", "embeddings"], disposition: "AI actions behind server execution; provider-disabled contract tests first" }),
  row("runtime_operation_family", "replicate", { status: "D", targetModule: "thrallo.aiActions", workPackage: 13,
    members: ["prediction"], disposition: "AI/provider actions" }),
  row("runtime_operation_family", "http", { status: "D", targetModule: "thrallo.httpConnectors", workPackage: 13,
    members: ["request"], disposition: "HTTP connector" }),
  row("runtime_operation_family", "media", { status: "D", targetModule: "thrallo.media", workPackage: 13,
    members: ["compose", "image_convert"], disposition: "media processing" }),
  row("runtime_operation_family", "document", { status: "D", targetModule: "thrallo.documents", workPackage: 13,
    members: ["pdf_extract", "pdf_merge", "archive"], disposition: "document processing" }),
  row("runtime_operation_family", "knowledge", { status: "D", targetModule: "thrallo.knowledge", workPackage: 13,
    members: ["ingest", "search"], disposition: "knowledge" }),
  row("runtime_operation_family", "meta", { status: "D", targetModule: "thrallo.metaConnector", workPackage: 13,
    members: ["accounts", "page_post", "create_ad"], disposition: "Meta connector" }),

  // ── 4.4 platform services without a client SDK surface ───────────────────────────────────
  row("platform_service", "appUsers", { status: "D", targetModule: "thrallo.accounts", workPackage: 4,
    retains: "app-auth Edge Function; public.app_users (app_id, email, auth_user_id, status)",
    disposition: "authoritative account mapping; profile reads/updates through accounts module, never generic appUser records" }),
  row("platform_service", "scheduledActions", { status: "D", targetModule: "thrallo.schedules", workPackage: 13,
    retains: "capabilityRuntime.enqueueDueSchedules(), action_schedules", disposition: "scheduling module" }),
  row("platform_service", "projectSecrets", { status: "D", targetModule: "thrallo.httpConnectors", workPackage: 13,
    retains: "shell/server/lib/projectSecrets.mjs", disposition: "internal module service; never generated credentials" }),
  row("platform_service", "assets", { status: "D/S", targetModule: "thrallo.assets", workPackage: 13,
    retains: "builderV2/assets, src/lib/assets.js", disposition: "retain asset service and typed asset manifest" }),
  row("platform_service", "teardown", { status: "D", targetModule: "thrallo.core", workPackage: 1,
    retains: "projectTeardown.mjs, erasureService.mjs", disposition: "modules register cleanup ownership" }),
  row("platform_service", "schemaAvailability", { status: "D", targetModule: "thrallo.core", workPackage: 1,
    retains: "shell/server/lib/schemaCapability.mjs", disposition: "explicit module availability" }),
  row("platform_service", "runtimePreflight", { status: "D", targetModule: "thrallo.core", workPackage: 1,
    retains: "runtimeEnv.mjs, appRuntimeStatus.mjs", disposition: "installation proof" }),
  row("platform_service", "domainAnalytics", { status: "G/P", targetModule: "thrallo.analyticsQueries", workPackage: 11,
    retains: "generated calculations and dashboard seams", disposition: "generic aggregation module plus generated formulas" }),

  // ── 4.1 requirement signals — every repeatable signal needs a resolved module or an explicit unavailable result ─
  row("requirement_signal", "user_accounts", { status: "D/S", targetModule: "thrallo.identity", workPackage: 3, disposition: "identity + accounts" }),
  row("requirement_signal", "saved_data", { status: "D/S", targetModule: "thrallo.entities", workPackage: 5, disposition: "schema + entities" }),
  row("requirement_signal", "payments", { status: "P", targetModule: "thrallo.billing", workPackage: 12,
    disposition: "extension seam today (scaffoldGraph); must resolve to a qualified billing module or an explicit unavailable result" }),
  row("requirement_signal", "file_uploads", { status: "P", targetModule: "thrallo.files", workPackage: 10,
    disposition: "extension seam today; must resolve to files module or explicit unavailable result" }),
  row("requirement_signal", "custom_logic", { status: "G", targetModule: null, workPackage: 14,
    disposition: "genuinely app-specific generated behaviour; stays generated" }),
  row("requirement_signal", "interactive_workspace", { status: "S/P", targetModule: "thrallo.editor", workPackage: 9, disposition: "editor/workspace primitives" }),
  row("requirement_signal", "realtime", { status: "P", targetModule: "thrallo.realtime", workPackage: 10,
    disposition: "extension seam today; must resolve to realtime module or explicit unavailable result" }),
  row("requirement_signal", "admin", { status: "S/P", targetModule: "thrallo.admin", workPackage: 4, disposition: "authorization + admin management" }),
  row("requirement_signal", "export", { status: "S/P", targetModule: "thrallo.exports", workPackage: 11, disposition: "exports/artifacts" }),

  // ── 4.1 execution controls that stay outside application module semantics ───────────────
  row("execution_control", "buildType", { status: "D", targetModule: null, workPackage: 2, disposition: "intent only; never a visual template selector" }),
  row("execution_control", "applicationSubtype", { status: "D", targetModule: null, workPackage: 2, disposition: "capability suggestions, not runtime modules" }),
  row("execution_control", "complexity", { status: "D", targetModule: null, workPackage: 2, disposition: "budget/custom-work sizing; same correctness standards" }),
  row("execution_control", "dependencySelection.browser_3d", { status: "D", targetModule: "thrallo.browser3d", workPackage: 9, disposition: "pinned three as a module runtime dependency" }),
  row("execution_control", "v2Availability", { status: "D", targetModule: null, workPackage: 1, disposition: "platform controls (THRALLO_BV2_KILL, worker admission); not app modules" }),
  row("execution_control", "budgetRecovery", { status: "D", targetModule: null, workPackage: 1, disposition: "preserved outside module semantics; approvals and reservations unchanged" }),
  row("execution_control", "optionalServiceFlags", { status: "D", targetModule: "thrallo.core", workPackage: 1, disposition: "deployment availability feeds module resolution; never assumed enabled" }),
  row("execution_control", "runtimeRefresh", { status: "D", targetModule: "thrallo.core", workPackage: 1,
    retains: "orchestrator.refreshPlatformRuntime()", disposition: "replaced by a lock-aware upgrade candidate (audit §16); never a silent upgrade" }),
]);

export function ledgerRows(kind) {
  return COVERAGE_LEDGER.filter((entry) => entry.kind === kind);
}

export function ledgerEntry(kind, id) {
  return COVERAGE_LEDGER.find((entry) => entry.kind === kind && entry.id === id) || null;
}

/** Structural validation of the ledger itself — independent of any live registry. */
export function validateCoverageLedger(ledger = COVERAGE_LEDGER) {
  const problems = [];
  const seen = new Set();
  for (const entry of ledger) {
    const key = `${entry.kind}:${entry.id}`;
    if (seen.has(key)) problems.push(`duplicate ledger row ${key}`);
    seen.add(key);
    if (!LEDGER_KINDS.includes(entry.kind)) problems.push(`${key}: unknown kind`);
    if (!/^[A-Z](?:\/[A-Z])*$/.test(String(entry.status || ""))) problems.push(`${key}: status must be D/S/P/G combinations`);
    for (const part of String(entry.status || "").split("/")) {
      if (!STATUS[part]) problems.push(`${key}: unknown status ${part}`);
    }
    if (entry.targetModule !== null && !MODULE_CATALOGUE[entry.targetModule]) {
      problems.push(`${key}: target module ${entry.targetModule} is not in the catalogue`);
    }
    if (!Number.isInteger(entry.workPackage) || entry.workPackage < 0 || entry.workPackage > 15) {
      problems.push(`${key}: work package must be 0..15`);
    }
    if (entry.removed !== false) problems.push(`${key}: WP0 removes no behaviour`);
    if (!entry.disposition) problems.push(`${key}: disposition required`);
  }
  return { ok: problems.length === 0, problems };
}

/**
 * Compare the ledger against the live registries. Every live entry must have a row (unmapped)
 * and every row must still name a live entry (stale). A later work package that retires an entry
 * marks the row rather than deleting it, so the history of ownership stays legible.
 */
export function coverageLedgerReport({
  capabilities = [], scaffolds = [], scaffoldPrimitives = [], sdkSurfaces = [],
  runtimeOperationFamilies = {}, requirementSignals = [],
} = {}) {
  const unmapped = [];
  const stale = [];
  const check = (kind, liveIds) => {
    const live = new Set(liveIds);
    for (const id of live) if (!ledgerEntry(kind, id)) unmapped.push(`${kind}:${id}`);
    for (const entry of ledgerRows(kind)) if (!live.has(entry.id)) stale.push(`${kind}:${entry.id}`);
  };
  check("capability", capabilities);
  check("scaffold_family", scaffolds);
  check("scaffold_primitive", scaffoldPrimitives);
  check("sdk_surface", sdkSurfaces);
  check("runtime_operation_family", Object.keys(runtimeOperationFamilies));
  check("requirement_signal", requirementSignals);
  for (const [family, operations] of Object.entries(runtimeOperationFamilies)) {
    const entry = ledgerEntry("runtime_operation_family", family);
    if (!entry) continue;
    for (const operation of operations) {
      if (!entry.members?.includes(operation)) unmapped.push(`runtime_operation_family:${family}.${operation}`);
    }
    for (const member of entry.members || []) {
      if (!operations.includes(member)) stale.push(`runtime_operation_family:${family}.${member}`);
    }
  }
  return {
    ok: unmapped.length === 0 && stale.length === 0,
    unmapped, stale,
    counts: Object.fromEntries(LEDGER_KINDS.map((kind) => [kind, ledgerRows(kind).length])),
    modulesReferenced: [...new Set(COVERAGE_LEDGER.map((entry) => entry.targetModule).filter(Boolean))].sort(),
  };
}

/** Which ledger rows a work package moves — the checklist each WP must close. */
export function workPackageScope(workPackage) {
  return COVERAGE_LEDGER.filter((entry) => entry.workPackage === workPackage);
}
