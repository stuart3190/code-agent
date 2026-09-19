// Catalogue migration and qualification (WP15).
//
// The audit's acceptance for the whole migration is three claims, and this is where they become
// checkable rather than asserted:
//
//   1. ALL SELECTED REPEATABLE OPERATIONS ARE MODULE-OWNED. Every operation a contract declares
//      that a registered module implements is owned by that module, not generated. What remains
//      generated must be genuinely application-specific.
//   2. ALL REQUESTED JOURNEYS PASS. Unchanged from before: the migration adds modules, it does not
//      change what a journey has to do.
//   3. NO REMAINING GENERIC FALLTHROUGH. Nothing standard is silently reimplemented because a
//      module was unavailable. An unavailable module BLOCKS; it never degrades to generated code.
//
// This file answers those questions about a derived build spec, without a provider call, so the
// catalogue can be qualified per contract and the answer is the same every time.

export const QUALIFICATION_VERSION = 1;

const listOf = (value) => (Array.isArray(value) ? value : []);
const lower = (value) => String(value || "").trim().toLowerCase();

/**
 * The repeatable operation kinds a module owns wherever one is installed. An operation of one of
 * these kinds that stays generated is the "generic fallthrough" the audit forbids — unless the
 * contract gave it a genuinely custom responsibility, which the report records separately.
 */
export const REPEATABLE_KINDS = Object.freeze([
  "create", "read", "get", "list", "search", "query", "update", "edit", "delete", "remove",
  "signin", "signup", "signout", "export",
]);

const kindOf = (operation) => lower(operation?.kind || operation?.type || operation?.action || operation?.id)
  .split(/[^a-z0-9]+/).filter(Boolean)[0] || "";

/**
 * Qualify one derived build spec.
 * @param {object} spec deriveBuildSpec() output
 * @returns {object} a report that says, per claim, whether it holds and exactly what fails it
 */
export function qualifyBuildSpec(spec) {
  const operations = listOf(spec?.contract?.operations);
  const modules = listOf(spec?.moduleLock?.modules).map((row) => row.id);
  const installed = new Set(modules);

  // 1. Repeatable operations that stayed generated.
  const fallthrough = [];
  const customRetained = [];
  for (const operation of operations) {
    if (operation?.owner === "module") continue;
    const kind = kindOf(operation);
    if (!REPEATABLE_KINDS.includes(kind)) continue;
    // An operation that DECLARES custom work — a domain calculation, a document whose layout is
    // the product — is what "generated" is for, and the audit says so outright: format and layout
    // vary, and unique document design stays the application's. The declared behaviour is the
    // evidence, so it is recorded rather than counted as a failure.
    const bindings = listOf(operation?.moduleBindings);
    const customBehaviours = listOf(operation?.responsibilities)
      .filter((row) => !row?.capability && !row?.capabilityId && row?.type !== "persistence")
      .map((row) => String(row?.behavior || "").trim())
      .filter(Boolean);
    if (customBehaviours.length) {
      customRetained.push({
        id: operation.id, kind, boundTo: bindings.map((row) => row.module),
        behaviours: customBehaviours,
      });
      continue;
    }
    // Plumbing with no module owner and nothing custom to say for itself. This is the generic
    // fallthrough: a standard operation reimplemented because nothing claimed it.
    fallthrough.push({
      id: operation.id, kind, entity: operation.entity || null,
      reason: bindings.length ? "generated with a module binding and no custom responsibility"
        : "a repeatable operation with no module owner and no declared custom behaviour",
    });
  }

  // 2. Journeys. The spec's own verdict already answers this; qualification restates it in one
  // place rather than inventing a second opinion about it.
  const journeys = {
    ok: spec?.verdict?.ok === true,
    problems: listOf(spec?.verdict?.problems),
  };

  // 3. Degradation. A requirement that named a module and did not resolve is the one thing this
  // migration must never allow: standard behaviour quietly regenerated because a service was off.
  const requirements = listOf(spec?.contract?.ownership?.platformRequirements);
  const degraded = requirements
    .filter((row) => row?.status !== "resolved" && row?.enforcement === "block")
    .map((row) => ({ type: row.type, source: row.source }));
  const unresolvedWarnings = requirements
    .filter((row) => row?.status !== "resolved" && row?.enforcement !== "block")
    .map((row) => ({ type: row.type, source: row.source }));
  // A module the contract asked for that the deployment could not provide must have BLOCKED the
  // build. If it did not, something fell back.
  const unavailable = listOf(spec?.moduleResolution?.problems)
    .filter((row) => row?.code === "module_unavailable")
    .map((row) => ({ module: row.module, configurationRequired: row.configurationRequired === true }));
  const blockedProperly = unavailable.length === 0 || spec?.verdict?.ok === false;

  return {
    version: QUALIFICATION_VERSION,
    modules,
    moduleOwnedOperations: operations.filter((operation) => operation?.owner === "module").map((row) => row.id),
    generatedOperations: operations.filter((operation) => operation?.owner !== "module").map((row) => row.id),
    claims: {
      repeatableOperationsModuleOwned: { ok: fallthrough.length === 0, fallthrough, customRetained },
      journeysPass: journeys,
      noGenericFallthrough: { ok: degraded.length === 0 && blockedProperly, degraded, unavailable, unresolvedWarnings },
    },
    ok: fallthrough.length === 0 && journeys.ok && degraded.length === 0 && blockedProperly,
    installedModuleCount: installed.size,
  };
}

/**
 * Qualify a corpus. Per-contract opt-in is the point: a project is migrated when its own
 * qualification passes, not when the catalogue average looks acceptable.
 */
export function qualifyCorpus(entries = []) {
  const results = listOf(entries).map(({ id, spec }) => ({ id: String(id), ...qualifyBuildSpec(spec) }));
  return {
    version: QUALIFICATION_VERSION,
    total: results.length,
    passing: results.filter((row) => row.ok).map((row) => row.id),
    failing: results.filter((row) => !row.ok).map((row) => ({
      id: row.id,
      fallthrough: row.claims.repeatableOperationsModuleOwned.fallthrough,
      journeyProblems: row.claims.journeysPass.problems.slice(0, 3),
      degraded: row.claims.noGenericFallthrough.degraded,
    })),
    results,
    ok: results.every((row) => row.ok),
  };
}

/**
 * The compatibility matrix: which module versions a stored lock pins, and whether the current
 * registry still offers them. A snapshot must keep replaying at the versions it recorded, so a
 * module version that has left the registry is a compatibility break, not an upgrade.
 */
export function compatibilityMatrix(locks = [], registry = {}) {
  const rows = [];
  for (const lock of listOf(locks)) {
    for (const module of listOf(lock?.modules)) {
      const available = listOf(registry[module.id]).map((row) => row.version);
      rows.push({
        lock: lock?.contractDigest || lock?.id || "unnamed",
        module: module.id,
        pinned: module.version,
        stillOffered: available.includes(module.version),
        newest: available.at(-1) || null,
      });
    }
  }
  return {
    version: QUALIFICATION_VERSION,
    rows,
    breaks: rows.filter((row) => !row.stillOffered),
    ok: rows.every((row) => row.stillOffered),
  };
}
