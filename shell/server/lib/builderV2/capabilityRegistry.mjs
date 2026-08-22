// Capability Registry (finish plan WP-4; master plan Part 6).
//
// The platform's authoritative list of what generated apps may bind: name, version, the
// exported interface the builder codes against, the scaffold package that implements it,
// the entity types it owns, and the UI CONTRACT — the states a screen using it MUST render
// (enforced later by the D1 capability-contract lint). Capabilities are headless by law:
// functions and state enums only, no JSX, no styles — visual identity belongs to the design
// system, which is how two sites sharing every capability still look nothing alike.

const LEGACY_CAPABILITIES = Object.freeze({
  crud: {
    name: "crud",
    version: "1.0.0",
    package: "src/lib/capabilities/crud.js",
    interface: ["makeEntityStore"],
    storeInterface: ["list", "get", "create", "update", "remove", "count", "subscribe"],
    entities: [],            // generic — binds to whatever the contract declares
    uiContract: [],
    upgradePolicy: "replace-on-iterate",
  },
  session: {
    name: "session",
    version: "1.1.0",
    package: "src/lib/capabilities/session.js",
    aliases: ["auth"],
    interface: [
      "ensureSession", "ensureVisitorSession", "currentUser", "signUp", "signIn",
      "signOut", "resetPassword", "confirmReset",
    ],
    entities: [],
    uiContract: [],
    upgradePolicy: "replace-on-iterate",
  },
  roles: {
    name: "roles",
    version: "1.0.0",
    package: "src/lib/capabilities/roles.js",
    interface: ["isOwner", "requireOwner"],
    entities: [],
    uiContract: [],
    upgradePolicy: "replace-on-iterate",
  },
  booking: {
    name: "booking", version: "1.0.0", package: "src/lib/capabilities/booking.js",
    interface: ["makeBookingSystem"],
    systemInterface: ["createBooking", "getBooking", "listBookings", "cancelBooking", "remaining"],
    entities: ["booking"],
    // The states a booking UI MUST render — the exact behaviours the 32.65-credit run lacked.
    uiContract: ["idle", "invalid", "over_capacity", "confirmed_with_reference", "cancel_confirm_prompt", "cancelled"],
    upgradePolicy: "replace-on-iterate",
  },
  wizard: {
    name: "wizard", version: "1.0.0", package: "src/lib/capabilities/wizard.js",
    interface: ["makeWizardMachine", "makeWizardPersistence"],
    systemInterface: ["getState", "subscribe", "hydrate", "restore", "setValue", "select", "validateCurrent", "next", "back", "goTo", "confirm", "cancel", "reset"],
    entities: [],
    uiContract: ["step_progress", "selection", "validation", "confirmation", "cancelled", "restored"],
    upgradePolicy: "replace-on-iterate",
  },
  contact: {
    name: "contact", version: "1.0.0", package: "src/lib/capabilities/forms.js",
    interface: ["makeContactForm"], entities: ["contactMessage"],
    uiContract: ["idle", "invalid", "sent"], upgradePolicy: "replace-on-iterate",
  },
  newsletter: {
    name: "newsletter", version: "1.0.0", package: "src/lib/capabilities/forms.js",
    interface: ["makeNewsletter"], entities: ["newsletterSignup"],
    uiContract: ["idle", "invalid", "success", "duplicate"], upgradePolicy: "replace-on-iterate",
  },
});

const metadata = Object.freeze({
  crud: {
    supportedOperations: ["list", "get", "create", "update", "remove", "count", "subscribe"],
    requiredInputs: { factory: ["entityType"], operations: { get: ["id"], create: ["values"], update: ["id", "partialValues"], remove: ["id"] } },
    outputs: { records: "flat entity records", mutations: "persisted entity record or void" },
    stateOwnership: { owns: "entity records", scope: "application and authenticated or visitor owner" },
    persistenceSemantics: { durable: true, owner: "generated backend entity API", mergeUpdates: true, browserStorage: false },
    dependencies: ["session"], compatibleUiInteractionPrimitives: ["field", "selection", "action", "status"],
    verificationSemantics: { actions: ["create", "read", "update", "delete"], stateChange: "entity record mutation", durableMutation: true, observe: ["returned record", "reload or reopen read"] },
    testContract: ["create", "read", "update", "delete"],
  },
  session: {
    supportedOperations: ["ensure", "recover", "current", "signUp", "signIn", "signOut", "resetPassword", "confirmReset"],
    requiredInputs: { factory: [], operations: {
      signUp: ["email", "password"], signIn: ["email", "password"],
      resetPassword: ["email"], confirmReset: ["email", "code", "newPassword"],
    } },
    operationOutputs: {
      ensure: ["session"], recover: ["session"], current: ["current"],
      signUp: ["session"], signIn: ["session"], signOut: ["signedOut"],
      resetPassword: ["resetRequested"], confirmReset: ["session"],
    },
    outputs: { session: "authenticated user or app-scoped visitor", current: "user or null", signedOut: "signed-out session state", resetRequested: "password reset request accepted" },
    stateOwnership: { owns: "authentication and session identity", scope: "browser and generated backend" },
    persistenceSemantics: { durable: true, owner: "generated auth runtime", browserStorage: "runtime-owned only" },
    dependencies: [], compatibleUiInteractionPrimitives: ["field", "action", "status"],
    verificationSemantics: { actions: ["establish", "recover", "signUp", "signIn", "signOut", "resetPassword", "confirmReset"], stateChange: "session identity", durableMutation: false, observe: ["authorized operation succeeds", "current user", "signed-out state"] },
    testContract: ["current", "ensure", "recover", "signUp", "signIn", "signOut", "resetPassword", "confirmReset"],
  },
  roles: {
    supportedOperations: ["isOwner", "requireOwner"],
    requiredInputs: { factory: [], operations: { isOwner: ["record", "user"], requireOwner: ["record", "user"] } },
    outputs: { authorization: "boolean or authorized record" }, stateOwnership: { owns: "no state", scope: "record ownership decision" },
    persistenceSemantics: { durable: false, owner: "RLS enforcement with a matching UI helper", browserStorage: false },
    dependencies: ["session"], compatibleUiInteractionPrimitives: ["action"],
    verificationSemantics: { actions: ["authorize", "reject"], stateChange: "none", durableMutation: false, observe: ["allowed action", "permission error"] },
    testContract: ["owner allowed", "non-owner rejected"],
  },
  booking: {
    supportedOperations: ["createBooking", "getBooking", "listBookings", "cancelBooking", "remaining"],
    requiredInputs: { factory: ["entity", "slots"], operations: { createBooking: ["date", "slotId", "name", "email"], getBooking: ["reference"], cancelBooking: ["reference"] } },
    outputs: { booking: "booking with stable reference and status", capacity: "remaining quantity or unknown", result: "ok, invalid, or over_capacity" },
    stateOwnership: { owns: "booking records, capacity admission, reference and cancellation status", scope: "configured booking entity" },
    persistenceSemantics: { durable: true, owner: "booking capability through generated backend", conflictPolicy: "deterministic admission rank", browserStorage: false },
    dependencies: ["session"], compatibleUiInteractionPrimitives: ["field", "selection", "action", "status"],
    verificationSemantics: { actions: ["create", "lookup", "list", "cancel", "check_capacity"], stateChange: "booking status, reference, and capacity", durableMutation: true, observe: ["reference", "capacity refusal", "cancelled status", "reload lookup"] },
    testContract: ["invalid refused", "create and lookup", "capacity race", "cancel and recover"],
  },
  wizard: {
    supportedOperations: ["getState", "subscribe", "hydrate", "restore", "setValue", "select", "validateCurrent", "next", "back", "goTo", "confirm", "cancel", "reset", "save", "load", "clear"],
    requiredInputs: { factory: ["id", "steps"], operations: { setValue: ["field", "value"], goTo: ["stepId"], restore: ["optionalState"] } },
    outputs: { state: "immutable workflow snapshot", confirmation: "terminal confirmation payload", persistence: "saved or restored workflow state" },
    stateOwnership: { owns: "workflow draft, step, validation, and terminal state", scope: "stable flow id" },
    persistenceSemantics: { durable: true, owner: "wizard persistence through generated backend", orderedWrites: true, browserStorage: false },
    dependencies: ["session"], compatibleUiInteractionPrimitives: ["field", "selection", "flow_advance", "action", "status"],
    verificationSemantics: { actions: ["transition", "review", "confirm", "cancel", "restore", "reset"], stateChange: "workflow snapshot and terminal status", durableMutation: true, observe: ["step and progress", "review values", "terminal state", "reload restore"] },
    testContract: ["transition", "review", "terminal state", "restore", "reset"],
  },
  contact: {
    supportedOperations: ["submitContact"], requiredInputs: { factory: ["entity"], operations: { submitContact: ["name", "email", "message"] } },
    outputs: { result: "sent or invalid", message: "persisted contact record" }, stateOwnership: { owns: "contact validation and record", scope: "configured contact entity" },
    persistenceSemantics: { durable: true, owner: "contact capability through generated backend", browserStorage: false },
    dependencies: ["session"], compatibleUiInteractionPrimitives: ["field", "action", "status"],
    verificationSemantics: { actions: ["validate", "submit"], stateChange: "contact result and record", durableMutation: true, observe: ["field problems", "sent state", "persisted record"] },
    testContract: ["invalid refused", "valid persisted", "sent observed"],
  },
  newsletter: {
    supportedOperations: ["subscribe"], requiredInputs: { factory: ["entity"], operations: { subscribe: ["email"] } },
    outputs: { result: "success, invalid, or duplicate", signup: "persisted signup record" }, stateOwnership: { owns: "newsletter validation, duplicate policy, and record", scope: "configured signup entity" },
    persistenceSemantics: { durable: true, owner: "newsletter capability through generated backend", duplicatePolicy: "normalized email", browserStorage: false },
    dependencies: ["session"], compatibleUiInteractionPrimitives: ["field", "action", "status"],
    verificationSemantics: { actions: ["validate", "subscribe", "reject_duplicate"], stateChange: "signup result and record", durableMutation: true, observe: ["invalid", "success", "duplicate"] },
    testContract: ["invalid refused", "valid persisted", "duplicate refused"],
  },
  "interaction-primitives": {
    supportedOperations: ["subscribe_state", "run_action", "field", "selection", "action", "flow_advance", "status"],
    requiredInputs: { factory: [], operations: { field: ["name", "value", "onChange"], selection: ["name", "value", "onSelect"], action: ["name", "onActivate"] } },
    outputs: { bindings: "accessible props with stable machine identity", state: "reactive capability snapshot or action state" },
    stateOwnership: { owns: "ephemeral React action status only", scope: "rendered component" },
    persistenceSemantics: { durable: false, owner: "none", browserStorage: false },
    dependencies: [], compatibleUiInteractionPrimitives: ["field", "selection", "action", "flow_advance", "status"],
    verificationSemantics: { actions: ["fill", "select", "activate", "advance", "observe"], stateChange: "control value, selection, or action result", durableMutation: false, observe: ["opaque control identity", "accessible name", "selected, value, or status transition"] },
    testContract: ["field accepts value", "selection becomes observable", "action changes state", "status announced"],
  },
});

const interactionPrimitives = Object.freeze({
  name: "interaction-primitives", version: "1.0.0", package: "src/lib/capabilities/react.js",
  interface: ["useCapabilityState", "useCapabilityAction", "useSemanticField", "useSemanticSelection", "useSemanticAction", "useFlowAdvance", "useStatusRegion"],
  entities: [], uiContract: [], upgradePolicy: "replace-on-iterate",
});

// A method name is not enough to establish semantic ownership. In particular, CRUD's `update`
// persists values supplied by its caller; it does not calculate, generate or otherwise produce
// those values. Capability-graph derivation consults this declaration before it lets a registered
// capability satisfy a functional responsibility.
const RESPONSIBILITY_SEMANTICS = Object.freeze({
  crud: Object.freeze({
    persistence: Object.freeze(["list", "get", "create", "update", "remove", "count", "subscribe"]),
    functional: Object.freeze([]),
  }),
  session: Object.freeze({
    persistence: Object.freeze(["signUp", "signIn", "signOut", "resetPassword", "confirmReset"]),
    functional: Object.freeze(["ensure", "recover", "current", "signUp", "signIn", "signOut", "resetPassword", "confirmReset"]),
  }),
  roles: Object.freeze({ persistence: Object.freeze([]), functional: Object.freeze(["isOwner", "requireOwner"]) }),
  booking: Object.freeze({
    persistence: Object.freeze(["createBooking", "getBooking", "listBookings", "cancelBooking"]),
    functional: Object.freeze(["createBooking", "getBooking", "listBookings", "cancelBooking", "remaining"]),
  }),
  wizard: Object.freeze({
    persistence: Object.freeze(["hydrate", "restore", "save", "load", "clear"]),
    functional: Object.freeze(["getState", "subscribe", "hydrate", "restore", "setValue", "select", "validateCurrent", "next", "back", "goTo", "confirm", "cancel", "reset", "save", "load", "clear"]),
  }),
  contact: Object.freeze({ persistence: Object.freeze(["submitContact"]), functional: Object.freeze(["submitContact"]) }),
  newsletter: Object.freeze({ persistence: Object.freeze(["subscribe"]), functional: Object.freeze(["subscribe"]) }),
  "interaction-primitives": Object.freeze({
    persistence: Object.freeze([]),
    functional: Object.freeze(["subscribe_state", "run_action", "field", "selection", "action", "flow_advance", "status"]),
  }),
});

/** The one machine-readable inventory of reusable behavior that actually ships. */
export const CAPABILITIES = Object.freeze(Object.fromEntries(
  Object.entries({ ...LEGACY_CAPABILITIES, "interaction-primitives": interactionPrimitives })
    .map(([id, entry]) => [id, Object.freeze({
      id, ...entry, ...metadata[id],
      responsibilitySemantics: RESPONSIBILITY_SEMANTICS[id],
      implementation: Object.freeze({ mode: "deterministic", proven: true, protected: true }),
    })]),
));

const CAPABILITY_ALIASES = new Map(Object.entries(CAPABILITIES).flatMap(([id, entry]) => [
  [id.toLowerCase(), id],
  ...(entry.aliases || []).map((alias) => [String(alias).toLowerCase(), id]),
]));

/** Resolve a structured contract capability name to the one registry-owned capability id. */
export function canonicalCapabilityId(value) {
  return CAPABILITY_ALIASES.get(String(value || "").trim().toLowerCase()) || null;
}

/** Validate a contract's capability bindings against the registry. */
export function validateBindings(bindings = []) {
  const problems = [];
  for (const binding of bindings) {
    const entry = CAPABILITIES[binding.name];
    if (!entry) { problems.push(`unknown capability "${binding.name}"`); continue; }
    const wantedMajor = String(binding.version || entry.version).split(".")[0];
    const haveMajor = entry.version.split(".")[0];
    if (wantedMajor !== haveMajor) {
      problems.push(`capability "${binding.name}" wants major ${wantedMajor}, platform ships ${entry.version}`);
    }
  }
  return { ok: problems.length === 0, problems };
}

// The EXACT methods each factory's instance exposes — one source of truth with the D1
// usage lint (capabilityLint.mjs pins the same table; a drift test compares both against
// the real factories). Live run 3 failed on contactForm.submit vs submitContact because
// the brief named the factories but never their methods.
// React bindings for the stores above. Advertised so generated code assembles the wiring
// instead of reinventing it — and so a capability method may simply be HANDED to a hook.
export const REACT_BINDINGS = [
  "useCapabilityState(store, selector?) → live state via useSyncExternalStore(store.subscribe, store.getState)",
  "useCapabilityAction(fn) → { run, pending, error, result } with stale-result protection",
  "useSemanticField({ name, label, value, onChange, type }) → { labelProps, inputProps } with a guaranteed accessible name",
  "useSemanticSelection({ name, value, onSelect }) → { groupProps, optionProps(option) }; keeps the native button role and reports selection via aria-pressed",
  "useSemanticAction({ name, label, onActivate }) → { buttonProps } for a contracted action; label freely",
  "useFlowAdvance({ label, onActivate, disabled }) → { buttonProps } for the control that moves a multi-step flow FORWARD; label freely",
  "useStatusRegion({ label }) → { statusProps } announcing a state transition",
];

/**
 * PREFERRED ASSEMBLY PATTERNS — the shortest correct way to build each shape this contract
 * actually needs. Selected from the contract, never dumped wholesale.
 *
 * A live qualification hand-wired a selection control whose clicked option never gained an
 * observable selected state; the value never propagated and review, confirmation and recovery
 * all failed behind it. The binding that prevents that already existed and was listed as an
 * API. Listing an API is not the same as showing the assembly, so each pattern below is a
 * complete, copyable few lines. None of them constrains layout, styling or markup.
 */
const ASSEMBLY_PATTERNS = Object.freeze({
  selection: {
    when: "the contract has selectable choices (a size, tier, variant, stage, status, method, slot…)",
    lines: [
      "SELECTABLE STATE — selected state must be observable, or the choice cannot be verified:",
      '  const choice = useSemanticSelection({ name: "<field>", value: state.<field>, onSelect: (v) => store.select("<field>", v) });',
      "  <div {...choice.groupProps}>",
      "    {options.map((o) => <button key={o} {...choice.optionProps(o)}>{label(o)}</button>)}",
      "  </div>",
      "  // optionProps supplies the accessible name and aria-pressed; the element stays a button. Style it however you like.",
    ],
  },
  flowAdvance: {
    when: "a flow spans more than one step or screen, so later controls are reached by advancing",
    lines: [
      "FORWARD CONTROL — if the flow spans screens, every later control is behind this one:",
      '  const advance = useFlowAdvance({ label: "<any wording>", disabled: !canContinue, onActivate: () => <next>() });',
      '  <button {...advance.buttonProps}>{/* any label, icon or language */}</button>   // FORWARD only: back and commit stay useSemanticAction({ name })',
    ],
  },
  capabilityState: {
    when: "a capability store holds state a screen renders",
    lines: [
      "CAPABILITY STORE STATE — one source of truth, no local mirror of store state:",
      "  const state = useCapabilityState(<store>);           // or (<store>, (s) => s.values)",
      "  // Re-renders on every store change. Never copy store state into useState.",
    ],
  },
  field: {
    when: "the contract collects typed input",
    lines: [
      "FORM FIELD — an accessible name is what makes a field findable:",
      '  const field = useSemanticField({ name: "<field>", value: draft.<field>, type: "<text|email|tel|number>", onChange: (v) => setDraft({ ...draft, <field>: v }) });',
      "  <label {...field.labelProps} /> <input {...field.inputProps} />",
    ],
  },
  entities: {
    when: "the app reads or writes contracted records",
    lines: [
      "ENTITY ACCESS — call the capability directly:",
      "  await store.create(values) / store.get(id) / store.list({ filters }) / store.update(id, values)",
      "  // The runtime establishes the app's visitor session before any protected operation.",
      "  // Do NOT call ensureVisitorSession() first, and do NOT use db.entity() for a capability-owned type.",
    ],
  },
  status: {
    when: "a state transition must become visible",
    lines: [
      "ANNOUNCED OUTCOME — a transition the browser can observe:",
      '  const status = useStatusRegion({ label: "<what this reports>" });',
      "  <p {...status.statusProps}>{message}</p>",
    ],
  },
  terminalReset: {
    when: "a durable flow can finish (confirmed) or be abandoned (cancelled)",
    lines: [
      "FINISHED FLOW — a confirmed or cancelled flow is TERMINAL: it refuses further edits, and it",
      "is restored in that state on the next visit. Render the outcome, and give an explicit way to",
      "begin a new one — otherwise a returning visitor is stuck on the finished record:",
      "  const state = useCapabilityState(<flowStore>);",
      "  const finished = state.status === \"confirmed\" || state.status === \"cancelled\";",
      "  {finished && <>",
      "    <p>…show the reference and its final status…</p>",
      "    <button onClick={() => <flowStore>.reset()}>Start a new <thing></button>",
      "  </>}",
      "  // reset() clears the durable record and returns the flow to its first step.",
      "  // Never reset implicitly on load: that would silently discard a real outcome.",
    ],
  },
});

/**
 * The short, contract-derived assembly brief. Only the shapes this build needs appear, so the
 * prompt grows by a few lines rather than another instruction block.
 *
 * `needs` is a plain fact set derived upstream from the interaction contract — no domain words.
 */
export function preferredAssemblyBrief(needs = {}) {
  const selected = Object.entries(ASSEMBLY_PATTERNS)
    .filter(([key]) => needs[key])
    .map(([, pattern]) => pattern.lines.join("\n"));
  if (!selected.length) return "";
  return [
    "PREFERRED ASSEMBLY (supported bindings from ./lib/capabilities — shortest correct path;",
    "visual design remains entirely yours):",
    ...selected,
  ].join("\n");
}

const INSTANCE_METHODS = Object.freeze({
  crud: "makeEntityStore(type) → { list, get, create, update, remove, count, subscribe }",
  booking: "makeBookingSystem(...) → { createBooking, getBooking, listBookings, cancelBooking, remaining }",
  wizard: "makeWizardMachine({ id, steps, onConfirm }) → durable app-scoped state that HYDRATES ITSELF on first subscribe; getState()/subscribe snapshots expose canonical { stepId, stepIndex, values } plus compatible step/currentStep/current aliases; restore() reloads durable state and restore({ stepId, values, ... }) atomically adopts and saves a compatible state; methods { getState, subscribe, hydrate, restore, setValue, select, validateCurrent, next, back, goTo, confirm, cancel, reset }",
  contact: "makeContactForm(...) → { submitContact(fields) }   // NOT .submit",
  newsletter: "makeNewsletter(...) → { subscribe(email) }",
});

/** The interface brief a build prompt carries — small, byte-stable, sorted. */
export function capabilityBrief(names = Object.keys(CAPABILITIES)) {
  const lines = ["CAPABILITIES (import from ./lib/capabilities — never reimplement):"];
  for (const name of [...names].sort()) {
    const entry = CAPABILITIES[name];
    if (!entry) continue;
    lines.push(`  ${entry.name}@${entry.version}: ${entry.interface.join(", ")}`);
    if (INSTANCE_METHODS[name]) lines.push(`    ${INSTANCE_METHODS[name]}`);
    if (entry.uiContract.length) lines.push(`    UI must render states: ${entry.uiContract.join(", ")}`);
  }
  lines.push("REACT BINDINGS (import from ./lib/capabilities — assemble, do not reinvent):");
  for (const binding of REACT_BINDINGS) lines.push(`  ${binding}`);
  lines.push("  A capability method may be CALLED or PASSED as a reference; both are correct usage.");
  return lines.join("\n");
}
