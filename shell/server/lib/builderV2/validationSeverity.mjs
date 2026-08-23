// Validation severity — the single authority for "does this finding stop a build?".
//
// Builder V2 accumulated ~25 deterministic rejection codes, every one terminal and every one
// ahead of the compiler. Four consecutive live qualifications spent their whole budget being
// rejected for implementation SHAPE and never compiled, so no run produced evidence about
// whether the generated application actually worked.
//
// The rule this module encodes:
//
//   BLOCKING  = a finding that proves the application is unsafe, dishonest or unrunnable.
//               Static analysis is the right authority; no execution can make it acceptable.
//
//   ADVISORY  = a finding that says the implementation does not have the shape Thrallo
//               expected. The browser is a strictly better authority for every one of these,
//               so they inform repair and diagnostics but never fail a runnable candidate.
//
// Advisory findings are never discarded: they are recorded on the candidate, surfaced in
// diagnostics, and briefed into a later targeted repair. The final quality bar is unchanged —
// a build still cannot go green unless every required contracted journey passes in a browser.

export const SEVERITY = Object.freeze({ BLOCKING: "blocking", ADVISORY: "advisory" });

/**
 * Genuine correctness / security / integrity. These stay terminal before execution.
 *
 * Each entry records WHY static analysis is the right authority — if a reason cannot be
 * written, the code belongs in ADVISORY_CODES instead.
 */
export const BLOCKING_CODES = Object.freeze({
  // ── tree integrity: the candidate cannot be executed at all ──
  patch_application_failed: "structured patches did not apply; there is no tree to run",
  tree_integrity_invalid: "the candidate tree is malformed or incoherent",
  protected_path_violation: "platform infrastructure (backend SDK, visitor session, capabilities) was rewritten",
  build_config_invalid: "the build manifest/entry point cannot produce a running app",
  compile_failed: "the candidate does not compile",
  source_parse_error: "generated source is not parseable, so no gate downstream can be trusted",
  persistence_ast_parse_error: "generated source is not parseable, so no gate downstream can be trusted",
  scaffold_placeholder_unreplaced: "the mounted default route is still the empty scaffold placeholder",

  // ── honesty: the app would appear to work while losing customer data ──
  forbidden_persistence: "browser/process-local storage is holding contracted durable business state",
  capability_owner_bypassed: "a capability-owned contracted entity is written through a raw persistence API",
  // `sessionless_mutation` was removed: establishing the app-scoped visitor session is a RUNTIME
  // invariant (createSupabaseBackend gates every protected entity operation), not something
  // generated application source is responsible for. Requiring it here rejected working code.

  // ── capability integrity: provably broken at runtime, not merely unusual ──
  capability_method_unknown: "a method is called that the capability demonstrably does not export",
  unknown_capability_factory: "an unrecognised capability factory is bound",
  required_factory_missing: "a contract-required capability is absent from the whole tree",
  capability_composition_invalid: "the canonical graph is missing a protected capability module or a declared custom extension interface",
  contract_control_binding_conflict: "the same contracted control is proven machine-bound in one place and hand-wired at another exact journey-facing identity",

  // ── platform ──
  runtime_configuration_invalid: "the generated runtime cannot reach its backend",
  required_runtime_dependency_missing: "the contract requires a runtime that is not present in the isolated compiler",
  required_runtime_capability_missing: "the generated app claims a required specialist capability without using its approved runtime",
  required_runtime_capability_incomplete: "the approved runtime is imported but the contracted specialist capability is not implemented",
  dependency_manifest_invalid: "the dependency manifest cannot be evaluated safely",
});

/**
 * Implementation-shape findings. Recorded, briefed, never terminal.
 *
 * Each entry records the authority that supersedes it. Every one of these is a static proxy
 * for something the browser tests directly and better.
 */
export const ADVISORY_CODES = Object.freeze({
  // ADDRESSABILITY. A contracted control with no machine identity is invisible to the browser's
  // mechanics probe, so its defects can only surface part-way through a paid journey — run #8 died
  // on step 2 of 8 exactly that way, and detecting it offline is worth having.
  //
  // These were built to BLOCK, and measurement said no. Against `builder-v2-false-rejection`, the
  // corpus of known-WORKING implementations this platform keeps precisely to answer this question,
  // blocking rejected 7 of 7. The binding inference is not accurate enough to gate a build: a
  // correct app may bind through a wrapper, a store, a loop, or a component this walker cannot
  // follow. Reported, therefore, and not enforced — until that suite scores zero.
  contract_control_unbound: "a contracted control appears hand-wired; verification may not be able to address it",
  contract_control_missing: "no element in the tree names this contracted control",
  contract_control_coverage_undetermined: "the tree binds controls dynamically, so coverage cannot be decided offline",
  uncontracted_control_unbound: "an interactive element carries no machine identity and matches no contracted control",
  required_method_unbound: "browser journeys prove whether the behaviour exists; AST cannot prove absence of use",
  required_method_uninvoked: "a method may legitimately be passed as a reference (useSyncExternalStore); the browser decides",
  required_method_unexported: "export shape is not behaviour",
  module_factory_placement: "which module instantiates a capability is architecture preference, not correctness",
  required_module_missing: "literal module paths are a naming preference; the journey decides",
  module_plan_violation: "literal module paths are a naming preference; the journey decides",
  required_import_missing: "import shape is not behaviour; the compiler catches real missing bindings",
  required_export_missing: "export shape is not behaviour; the compiler catches real missing bindings",
  module_size_exceeded: "module size is a maintenance/cost preference, not a correctness property",
  monolith_size: "module size is a maintenance/cost preference, not a correctness property",
  invalid_factory_configuration: "proximity-regex config matching cannot see a config object built in a variable",
  interaction_control_undriveable: "the browser verifier drives controls directly and is authoritative",
  selection_state_unobservable: "the browser observes selected state directly",
  review_data_flow_missing: "substring matching on source cannot prove what a rendered review shows",
  confirmation_data_flow_missing: "substring matching on source cannot prove what a rendered confirmation shows",
  fabricated_confirmation_reference: "reload recovery in the browser proves durability; Date.now() alone does not prove fabrication",
  durable_cancellation_missing: "the cancellation journey proves durable cancellation in the browser",
  process_memory: "a mutable module binding is only a defect if reload recovery actually fails",
});

/** Codes that must never be demoted, even by an explicit override. */
const UNDEMOTABLE = Object.freeze(new Set([
  "forbidden_persistence", "capability_owner_bypassed",
  "protected_path_violation", "compile_failed", "patch_application_failed",
  "tree_integrity_invalid", "build_config_invalid", "source_parse_error",
  "scaffold_placeholder_unreplaced",
  "runtime_configuration_invalid",
  "capability_composition_invalid",
  "required_runtime_dependency_missing", "required_runtime_capability_missing",
  "required_runtime_capability_incomplete", "dependency_manifest_invalid",
]));

/**
 * Severity for one finding code. Unknown codes fail SAFE-FOR-PROGRESS as advisory: a validator
 * added later must make an explicit, reviewed claim to be able to stop a build. That is the
 * inversion this module exists to enforce.
 */
export function severityOf(code) {
  if (!code) return SEVERITY.ADVISORY;
  if (Object.hasOwn(BLOCKING_CODES, code)) return SEVERITY.BLOCKING;
  return SEVERITY.ADVISORY;
}

export function isBlocking(finding) {
  return severityOf(typeof finding === "string" ? finding : finding?.code) === SEVERITY.BLOCKING;
}

/** Why a finding blocks (or does not) — carried into diagnostics so the decision is auditable. */
export function severityRationale(code) {
  return BLOCKING_CODES[code] || ADVISORY_CODES[code]
    || "unclassified finding: advisory by default until explicitly reviewed";
}

/**
 * Split a validator's findings into the set that stops the build and the set that informs it.
 * Both halves keep their full structure; nothing is summarised away here.
 */
export function partitionFindings(findings = []) {
  const blocking = [];
  const advisory = [];
  for (const raw of findings || []) {
    const finding = { ...raw, severity: severityOf(raw?.code), rationale: severityRationale(raw?.code) };
    if (finding.severity === SEVERITY.BLOCKING) blocking.push(finding);
    else advisory.push(finding);
  }
  return { blocking, advisory, ok: blocking.length === 0 };
}

/** Machine-readable advisory evidence for diagnostics and repair briefs. */
export function advisoryMessages(advisory = []) {
  return (advisory || []).map((finding) => JSON.stringify({
    severity: SEVERITY.ADVISORY,
    code: finding.code,
    module: finding.module || finding.file || null,
    message: finding.message || null,
    rationale: finding.rationale || severityRationale(finding.code),
  }));
}

/** Assert the two tables stay disjoint — a code with two severities has no single authority. */
export function assertSeverityTablesDisjoint() {
  const overlap = Object.keys(BLOCKING_CODES).filter((code) => Object.hasOwn(ADVISORY_CODES, code));
  if (overlap.length) throw new Error(`severity tables overlap: ${overlap.join(", ")}`);
  const demoted = [...UNDEMOTABLE].filter((code) => !Object.hasOwn(BLOCKING_CODES, code));
  if (demoted.length) throw new Error(`undemotable codes must stay blocking: ${demoted.join(", ")}`);
  return true;
}
