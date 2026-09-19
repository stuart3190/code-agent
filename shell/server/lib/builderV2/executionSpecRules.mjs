// The static rule text every generation prompt states ONCE beneath its canonical sections.
// Kept import-free so the brief renderers of the derived views and the execution specification
// can share it without a module cycle.

export const CAPABILITY_COMPOSITION_RULES = Object.freeze([
  "Known behavior is already implemented behind these interfaces. Build unique UI, layout, copy,",
  "domain configuration, integrations, and only the explicit custom_behavior extension modules.",
]);

export const SCAFFOLD_COMPOSITION_RULES = Object.freeze([
  "The protected router already mounts every screen above. Implement visual/domain composition inside",
  "those existing screen slots and only the declared custom extension files. Do not write App.jsx,",
  "the composed scaffold root, a competing router, or a free-form replacement application shell.",
  "ROUTING: react-router-dom is NOT installed and must not be imported. Read route parameters with",
  "useRouteParams() (alias useParams), navigate with useNavigate() or <RouteLink to=\"/path\"> (alias Link),",
  "NavLink, useLocation() and <Navigate to> are also provided - all from",
  "../../lib/scaffolds/composed/primitives.jsx; parameterised routes such as /projects/:projectId",
  "are already mounted and their params arrive through useRouteParams(). Never declare Routes/Route/",
  "BrowserRouter or any nested router inside a screen: the composed shell owns the router.",
  "Select each custom-extension operation with a literal second-argument context such as",
  "{ operation: \"<operationId>\" }. The explicit legacy key operationId is also supported.",
  "At every custom-extension call site, pass the selected operation's declared inputKeys as explicit",
  "object properties. An object spread is not proof that a differently named domain field satisfies the interface.",
]);

export const MODULE_CONTRACT_RULES = Object.freeze([
  "ENFORCED: capability-owned operations may not be reimplemented through a lower-level persistence API,",
  "and contracted durable state may not live in browser or process-local storage. These are checked before compilation.",
  "GUIDANCE: module paths, where a capability is instantiated, and how a required method is reached",
  "(called directly or passed as a reference, e.g. useSyncExternalStore) are yours to decide — the browser",
  "journeys decide whether the result is correct.",
  "Semantic controls may use any standards-compliant accessible HTML/ARIA shape; visual design is unrestricted.",
  "A sharedCustomOperations group is ONE runtime action projected into several contracted journeys, not a pipeline of independent fallbacks.",
  "Delegate to one implementation, or pass the same canonical source data explicitly through every implementation's declared runtime inputs; never recreate controller-owned domain collections independently inside extensions.",
  "Declared runtime inputs are authoritative. Collection add/remove/toggle operations must transform the passed collection using the passed identifier and must not reject that identifier against private module-local records unless those records are themselves a declared input. Merge equivalent outputs without allowing an empty/default result from a missing input to overwrite a valid result.",
]);

export const INTERACTION_CONTRACT_RULES = Object.freeze([
  "Every contracted control must be present, editable when it accepts input, semantically identifiable through standard HTML/ARIA, connected to its declared state owner, and propagated to downstream review/confirmation consumers.",
  "Every non-null control.machineId is also mandatory runtime identity: emit it through the matching platform semantic helper, or as data-thrallo-control for input/selection controls and data-thrallo-action for action/flow-entry controls. An accessible label does not replace this identity.",
  "When a control carries control.scope, its identity is scope.logicalField (control.qualifiedName): bind it with useSemanticField({ name: logicalField, scope }) or useSemanticSelection({ name: logicalField, scope }). The same field name without that scope is a DIFFERENT control (another entity's), never a substitute.",
  "Use label/htmlFor, a wrapping label, aria-label, or aria-labelledby for accessible names; name/id/placeholder may assist location but do not replace an accessible name.",
  "Visual design remains unrestricted.",
]);

