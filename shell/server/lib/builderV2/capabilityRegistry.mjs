// Capability Registry (finish plan WP-4; master plan Part 6).
//
// The platform's authoritative list of what generated apps may bind: name, version, the
// exported interface the builder codes against, the scaffold package that implements it,
// the entity types it owns, and the UI CONTRACT — the states a screen using it MUST render
// (enforced later by the D1 capability-contract lint). Capabilities are headless by law:
// functions and state enums only, no JSX, no styles — visual identity belongs to the design
// system, which is how two sites sharing every capability still look nothing alike.

export const CAPABILITIES = Object.freeze({
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
    version: "1.0.0",
    package: "src/lib/capabilities/session.js",
    interface: ["ensureSession", "ensureVisitorSession", "currentUser", "signOut"],
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
    systemInterface: ["getState", "subscribe", "restore", "setValue", "select", "validateCurrent", "next", "back", "goTo", "confirm", "cancel", "reset"],
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
  wizard: "makeWizardMachine({ id, steps, onConfirm }) → durable app-scoped state + { getState, subscribe, restore, setValue, select, validateCurrent, next, back, goTo, confirm, cancel, reset }",
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
