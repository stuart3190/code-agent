// Selection of platform modules that no capability binding names (WP6/WP7).
//
// The eight legacy capabilities are selected by `bindCapabilities` and reach the resolver as
// capability bindings. The modules added by the later work packages — routing, query,
// forms, async state — are not capabilities a contract declares; they are implied by the
// contract's own STRUCTURE: it declares routes, so it needs the route compiler; it declares a
// search or list operation, so it needs the query runtime; it collects typed input, so it needs
// the form runtime. This file is the one place that mapping lives, and every request carries the
// reason it was made so the resolution stays explainable (audit §11).
//
// A request is only emitted for a module the registry actually has, so this file can name the
// whole target catalogue while each work package lands its module.

import { MODULE_REGISTRY } from "./registry.mjs";

export const PLATFORM_SELECTION_VERSION = 1;

const COLLECTION_KINDS = new Set(["list", "search", "query"]);
const MUTATION_KINDS = new Set(["create", "insert", "add", "update", "edit"]);

const kindOf = (operation) => String(operation?.kind || operation?.type || operation?.action || operation?.id || "")
  .toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)[0] || "";

/**
 * @param {object} contract the typed, route-stamped contract
 * @param {object} options
 * @param {object} [options.entitySchema] compiled entity schema (durable domain entities)
 * @param {object} [options.settingsPlan] derived settings/audit plan (WP8)
 * @param {object} [options.registry]
 * @returns {Array<{id: string, range: string, reason: string}>}
 */
export function platformModuleRequests(contract, { entitySchema = null, settingsPlan = null, registry = MODULE_REGISTRY } = {}) {
  const operations = contract?.operations || [];
  const durableEntities = entitySchema?.entities || [];
  const requests = [];
  const request = (id, reason) => {
    if (!registry[id] || requests.some((row) => row.id === id)) return;
    requests.push({ id, range: `^${registry[id].at(-1).version}`, reason });
  };

  // Routing: any declared route needs the compiler that resolves it, its parameters and its guard.
  if ((contract?.routes || []).length) {
    const parameterised = (contract.routes || []).some((route) => String(route?.path || "").includes(":"));
    request("thrallo.routing", parameterised ? "parameterised routes declared" : "routes declared");
  }
  // Query: a collection read over durable records is a validated server query, never a filtered page.
  if (durableEntities.length && operations.some((operation) => COLLECTION_KINDS.has(kindOf(operation)) && durableEntities.includes(operation?.entity))) {
    request("thrallo.query", "collection reads over durable records");
  }
  // Forms: a step that operates a declared field collects typed input.
  const collectsInput = (contract?.journeys || []).some((journey) => (journey?.steps || [])
    .some((step) => (step?.operates || []).some((operand) => !operations.some((operation) => operation?.id === operand))));
  if (collectsInput || operations.some((operation) => MUTATION_KINDS.has(kindOf(operation)))) {
    request("thrallo.forms", collectsInput ? "journey steps collect typed input" : "mutating operations submit values");
  }
  // Async state: every durable read or mutation has loading/error/empty states and cancellation.
  if (durableEntities.length) request("thrallo.async", "durable reads and mutations carry async state");
  // WP8 — settings: a declared settings singleton is typed keys with declared defaults, never a
  // fabricated record. Audit is requested only where the contract's own vocabulary asks to review
  // changes, because history the application never shows is history nobody can check.
  if ((settingsPlan?.declarations || []).length) request("thrallo.settings", "settings singleton declared");
  if (settingsPlan?.audit?.enabled) request("thrallo.audit", "the contract reviews who changed what");

  return requests;
}
