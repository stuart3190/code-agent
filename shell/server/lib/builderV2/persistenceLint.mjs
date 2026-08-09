// Durable-persistence ownership lint for Builder V2 candidates.
//
// This is deliberately AST-based and contract-scoped. It does not replace the broader honesty
// gate; it gives the orchestrator an early, machine-readable verdict that can drive one bounded
// repair before compilation without weakening the final gate.

import { parse } from "@babel/parser";

import { CAPABILITIES } from "./capabilityRegistry.mjs";
import {
  FORBIDDEN_DURABLE_PERSISTENCE, durablePersistenceJourneys, persistenceOwnershipPlan,
} from "./contractTiering.mjs";

const GENERATED_SOURCE = /^src\/.*\.(?:jsx?|tsx?)$/;
const PLATFORM_SOURCE = /^src\/lib\/(?:capabilities\/|backend\/|visitorSession\.js$|assets\.js$|assetData\.js$)/;
const AST_SKIP = new Set(["loc", "start", "end", "extra", "errors", "comments", "tokens"]);
const BROWSER_STORES = new Set(["localStorage", "sessionStorage", "indexedDB", "IndexedDB"]);
const MEMORY_NAME = /(?:booking|reservation|wizard|persist|record|state|store|cache|database|rows?)/i;
const MUTATING_METHOD = new Set(["add", "clear", "delete", "push", "set", "shift", "splice", "unshift"]);

function walk(node, visit, parent = null) {
  if (!node || typeof node !== "object") return;
  if (typeof node.type === "string") visit(node, parent);
  for (const [key, value] of Object.entries(node)) {
    if (AST_SKIP.has(key)) continue;
    if (Array.isArray(value)) for (const child of value) walk(child, visit, node);
    else if (value && typeof value === "object") walk(value, visit, node);
  }
}

function parserPlugins(path) {
  const plugins = ["jsx", "importAttributes", "topLevelAwait"];
  if (/\.tsx?$/.test(path)) plugins.push("typescript");
  return plugins;
}

function storageIdentifier(node, parent) {
  if (node?.type !== "Identifier" || !BROWSER_STORES.has(node.name)) return null;
  // Property names in `{ localStorage: value }` are not API use; computed/member objects are.
  if ((parent?.type === "ObjectProperty" || parent?.type === "ObjectMethod")
    && parent.key === node && !parent.computed) return null;
  if ((parent?.type === "MemberExpression" || parent?.type === "OptionalMemberExpression")
    && parent.property === node && !parent.computed && !["window", "globalThis"].includes(parent.object?.name)) return null;
  return node.name;
}

function declaredNames(pattern, output = []) {
  if (!pattern) return output;
  if (pattern.type === "Identifier") output.push(pattern.name);
  else if (pattern.type === "ObjectPattern") {
    for (const property of pattern.properties || []) declaredNames(property.value || property.argument, output);
  } else if (pattern.type === "ArrayPattern") {
    for (const value of pattern.elements || []) declaredNames(value, output);
  } else if (pattern.type === "AssignmentPattern") declaredNames(pattern.left, output);
  return output;
}

function mutatedNames(ast) {
  const mutated = new Set();
  walk(ast, (node) => {
    if (["AssignmentExpression", "UpdateExpression"].includes(node.type)) {
      const target = node.left || node.argument;
      if (target?.type === "Identifier") mutated.add(target.name);
      if (target?.type === "MemberExpression" && target.object?.type === "Identifier") mutated.add(target.object.name);
    }
    if (node.type === "CallExpression" && node.callee?.type === "MemberExpression"
      && node.callee.object?.type === "Identifier" && MUTATING_METHOD.has(node.callee.property?.name)) {
      mutated.add(node.callee.object.name);
    }
  });
  return mutated;
}

function requiredOwners(path, plan) {
  const module = (plan?.modules || []).find((row) => row.path === path);
  if (module?.approvedPersistence) return [module.approvedPersistence];
  if (module?.durableStateOwner) return String(module.durableStateOwner).split(/\s*\+\s*/).filter(Boolean);
  return (plan?.owners || []).map((owner) => owner.capability).filter(Boolean);
}

function finding({ code = "forbidden_persistence", path, node, api, journeys, owners, detail }) {
  const line = node?.loc?.start?.line || 0;
  const span = { start: node?.start ?? null, end: node?.end ?? null };
  const message = `${path}:${line} — ${api} cannot own contracted durable state; `
    + `journey(s) [${journeys.join(", ")}] require ${owners.join(" + ") || "platform persistence"}`;
  return {
    code, file: path, line, span, api, journeys, requiredOwners: owners,
    message: detail ? `${message} (${detail})` : message,
  };
}

/**
 * Total, machine-readable validation over generated source. Parse failures are intentional
 * verdicts, never exceptions; the final compiler still remains authoritative for syntax.
 */
export function lintDurablePersistence(tree, { contract = null, journeys = contract?.journeys || [], modulePlan = [] } = {}) {
  const durable = durablePersistenceJourneys(contract, journeys);
  if (!durable.length) return { ok: true, findings: [], plan: null };
  const plan = persistenceOwnershipPlan(contract, journeys, modulePlan);
  const journeyIds = durable.map((journey) => journey.id);
  const findings = [];
  const seen = new Set();

  for (const [path, source] of Object.entries(tree || {})) {
    if (!GENERATED_SOURCE.test(path) || PLATFORM_SOURCE.test(path)) continue;
    let ast;
    try {
      ast = parse(String(source), { sourceType: "module", plugins: parserPlugins(path), errorRecovery: false });
    } catch (error) {
      findings.push({ code: "persistence_ast_parse_error", file: path, line: error.loc?.line || 0,
        span: { start: error.pos ?? null, end: error.pos ?? null }, api: null, journeys: journeyIds,
        requiredOwners: requiredOwners(path, plan), message: `${path}:${error.loc?.line || 0} — persistence AST parse failed: ${error.message}` });
      continue;
    }

    walk(ast, (node, parent) => {
      const api = storageIdentifier(node, parent);
      if (!api) return;
      const key = `${path}:${node.start}:${api}`;
      if (seen.has(key)) return;
      seen.add(key);
      findings.push(finding({ path, node, api, journeys: journeyIds, owners: requiredOwners(path, plan),
        detail: "browser-local storage is forbidden business persistence" }));
    });

    const mutations = mutatedNames(ast);
    for (const statement of ast.program?.body || []) {
      if (statement.type !== "VariableDeclaration") continue;
      for (const declaration of statement.declarations || []) {
        for (const name of declaredNames(declaration.id)) {
          // PascalCase module bindings are commonly React components with a later displayName
          // assignment. They are not process-memory persistence containers.
          if (/^[A-Z]/.test(name) || !MEMORY_NAME.test(name) || !mutations.has(name)) continue;
          const key = `${path}:${declaration.start}:process_memory`;
          if (seen.has(key)) continue;
          seen.add(key);
          // A mutable module-level binding whose NAME suggests state is a guess, not a proof:
          // an ephemeral subscriber registry, memo cache or ref table looks identical to a fake
          // durable store. Reload recovery in the browser is what actually settles it, so this
          // carries its own advisory code rather than the blocking `forbidden_persistence` one.
          findings.push(finding({ code: "process_memory", path, node: declaration, api: "process_memory",
            journeys: journeyIds, owners: requiredOwners(path, plan),
            detail: `module-level ${name} is mutable; if it holds contracted durable state it cannot `
              + "survive process/reload boundaries" }));
        }
      }
    }
  }
  return { ok: findings.length === 0, findings, plan };
}

/** Exact write/retrieval boundary for one pre-compile persistence repair. */
export function persistenceRepairScope(verdict, modulePlan = []) {
  const files = [...new Set((verdict?.findings || []).map((row) => row.file).filter(Boolean))].sort();
  const ownerFactories = [...new Set((verdict?.findings || []).flatMap((row) => row.requiredOwners || []))];
  const adapters = modulePlan.filter((module) => ownerFactories.includes(module.factory)).map((module) => module.path);
  const capabilityPaths = Object.values(CAPABILITIES)
    .filter((capability) => capability.interface.some((factory) => ownerFactories.includes(factory)))
    .map((capability) => capability.package);
  return {
    kind: "precompile_persistence",
    files,
    allowedFiles: [...new Set([...files, ...adapters])].sort(),
    adapterInterfaces: [...new Set(adapters)].sort(),
    capabilityPaths: [...new Set(capabilityPaths)].sort(),
    findings: verdict.findings,
    instruction: "Remove browser/process-local business persistence. Use the existing platform capability owner. Preserve the module plan and working behaviour; do not redesign or regenerate the application.",
  };
}

export function persistenceFindingMessages(verdict) {
  return (verdict?.findings || []).map((row) => JSON.stringify({
    code: row.code, file: row.file, line: row.line, span: row.span, api: row.api,
    journeys: row.journeys, requiredOwners: row.requiredOwners, message: row.message,
  }));
}

export { FORBIDDEN_DURABLE_PERSISTENCE };
