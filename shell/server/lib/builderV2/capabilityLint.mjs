// D1 capability-usage lint (master plan Part 9; built after live run 3, diag 31b97b07).
//
// The third live build failed its essential journey because generated code called
// `contactForm.submit(...)` where the contact capability exports `submitContact` — the
// method was undefined, the throw was caught into a silent error state, and the defect
// cost a full browser-verification cycle to even observe. A call to a method a capability
// does not export is DETECTABLE STATICALLY the moment patches apply; this lint fails it
// there, with the real interface in the rejection so the next round cannot miss.
//
// FACTORY_METHODS is pinned statically for byte-stable prompts and lint output; a drift
// test asserts it equals Object.keys() of what the real scaffold factories return.

import path from "node:path";
import { parse } from "@babel/parser";

import { FILE_MAX_TOKENS } from "../appBuild/modularity.mjs";
import { CAPABILITIES } from "./capabilityRegistry.mjs";

export const FACTORY_METHODS = Object.freeze({
  makeEntityStore: ["list", "get", "create", "update", "remove", "count", "subscribe"],
  makeBookingSystem: ["createBooking", "getBooking", "listBookings", "cancelBooking", "remaining"],
  makeWizardMachine: ["getState", "subscribe", "hydrate", "restore", "setValue", "select", "validateCurrent", "next", "back", "goTo", "confirm", "cancel", "reset"],
  makeWizardPersistence: ["save", "load", "clear"],
  makeContactForm: ["submitContact"],
  makeNewsletter: ["subscribe"],
});

/** Every capability factory advertised by the authoritative registry. */
export const RECOGNIZED_CAPABILITY_FACTORIES = Object.freeze([...new Set(
  Object.values(CAPABILITIES)
    .flatMap((capability) => capability.interface || [])
    .filter((name) => /^make[A-Z]/.test(name)),
)].sort());

const RECOGNIZED_FACTORY_SET = new Set(RECOGNIZED_CAPABILITY_FACTORIES);

// Non-method properties an instance legitimately exposes (enums; never called).
const FACTORY_PROPERTIES = Object.freeze({
  makeBookingSystem: ["BOOKING_STATUS", "CREATE_RESULT"],
  makeWizardMachine: ["WIZARD_STATUS"],
});

const GENERATED_FILE = /^src\/.*\.(jsx?|tsx?)$/;
// Only immutable scaffold/runtime modules are exempt. Generated helper modules commonly live in
// src/lib and must still be inspected; exempting the whole directory created a trivial bypass.
const PLATFORM_PATH = /^src\/lib\/(?:capabilities\/|backend\/|visitorSession\.js$|assets\.js$|assetData\.js$)/;

// The monolith tax (WP-10 variance): a whole-app-in-one-file page makes every future edit
// carry the whole app as context (~8k tokens/round measured live). Generous cap — real
// booking pages are big — but a file beyond it must split into components.
const MAX_GENERATED_FILE_TOKENS = FILE_MAX_TOKENS;
const tokensOf = (text) => Math.ceil(String(text || "").length / 4);

// Capability-owned entities must be persisted through their capability — that check lives in
// moduleContracts.ownershipRules, derived from the contract's ACTUAL bindings rather than a
// static list, so it generalises to any capability and any entity name.


/**
 * Capability SAFETY lint — the checks that survive the blocking/advisory split.
 *
 * This used to be a second, regex-based capability authority running alongside the AST
 * provenance aggregator: it re-derived instances with `(?:const|let|var)\s+(\w+)\s*=.*factory\(`
 * and re-derived method calls with `\bvar\.(\w+)\s*\(`. Two implementations of one truth
 * disagreed on every grammar the regex could not see (destructuring, aliases, cross-module
 * imports), which is how eleven false "missing method" defects reached a live run.
 *
 * Method existence is now derived from the SAME AST facts as everything else. What remains
 * regex-shaped is genuinely different work: the sessionless-mutation check reads a module's
 * session vocabulary, not capability provenance.
 *
 * Ownership (`capability_owner_bypassed`) is NOT checked here. It is contract-derived in
 * moduleContracts.ownershipRules, which knows the actual bound entities instead of a static
 * hardcoded list, and applies to every generated module including unplanned helpers.
 */
export function lintCapabilitySafety(tree, bindings = []) {
  const findings = [];
  const facts = aggregateCapabilityFacts(tree, bindings);
  const appSource = String(tree?.["src/App.jsx"] || "");
  const homePageIsMounted = /\bimport\s+HomePage\s+from\b/.test(appSource)
    && (/["']\/["']\s*:\s*HomePage\b/.test(appSource) || /<HomePage\b/.test(appSource));

  // A call to a method the capability does not export is a guaranteed runtime TypeError.
  // (Live run 3 lost its build to contactForm.submit vs submitContact.) Provable statically,
  // so it stays blocking — but now from real provenance, not a regex.
  for (const fact of facts.values()) {
    for (const unknown of fact.unknownMethods || []) {
      findings.push({
        code: "capability_method_unknown",
        module: unknown.module,
        factory: fact.factory,
        method: unknown.method,
        message: `${unknown.module}: ${fact.factory}() has no ${unknown.method}(...) — it exposes exactly `
          + `[${(FACTORY_METHODS[fact.factory] || []).join(", ")}]. Call the real method; do not reimplement the capability.`,
      });
    }
  }

  // NOTE: `sessionless_mutation` was retired here. It required generated modules to call
  // ensureVisitorSession() before mutating, which was correct while session establishment was
  // the application's job. It no longer is: createSupabaseBackend establishes and recovers the
  // app-scoped visitor session before every protected entity operation, so the runtime — not
  // generated source — is the authority. Keeping the check would have rejected code that works.
  // Capability OWNERSHIP is unaffected and still blocks (capability_owner_bypassed).

  for (const [path, source] of Object.entries(tree || {})) {
    if (!GENERATED_FILE.test(path) || PLATFORM_PATH.test(path)) continue;
    const code = String(source);

    // HomePage is the scaffold's mounted fallback route. Leaving its exact build marker in
    // place produces a valid bundle whose public root is an empty <main>, even when complete
    // feature components exist elsewhere in the tree. Compilation cannot distinguish that
    // from a working application, while the marker proves the scaffold was never composed.
    if (path === "src/routes/HomePage.jsx" && homePageIsMounted
      && /\{\/\*\s*build here\s*\*\/\}/i.test(code)) {
      findings.push({
        code: "scaffold_placeholder_unreplaced",
        module: path,
        message: `${path}: the mounted scaffold placeholder is still present; replace it with `
          + "reachable application UI or mount the generated feature flow",
      });
    }

    // The monolith cap is a maintenance/cost preference, not a correctness property: an
    // oversized module makes every later edit pay its whole body as context. Advisory.
    const size = tokensOf(code);
    if (size > MAX_GENERATED_FILE_TOKENS) {
      findings.push({
        code: "monolith_size",
        module: path,
        actualTokens: size,
        maximumTokens: MAX_GENERATED_FILE_TOKENS,
        message: `${path} is ${size} tokens (preferred cap ${MAX_GENERATED_FILE_TOKENS}) — splitting sections into `
          + `components under src/components/ keeps later edits cheap.`,
      });
    }
  }
  return { ok: findings.length === 0, findings, problems: findings.map((row) => row.message) };
}

function generatedSource(tree) {
  return Object.entries(tree || {})
    .filter(([path]) => GENERATED_FILE.test(path) && !PLATFORM_PATH.test(path))
    .map(([path, source]) => `\n/* ${path} */\n${String(source)}`)
    .join("\n");
}

const CAPABILITY_FACTORIES = Object.freeze({
  crud: "makeEntityStore",
  booking: "makeBookingSystem",
  wizard: "makeWizardMachine",
  contact: "makeContactForm",
  newsletter: "makeNewsletter",
});

const AST_KEYS_TO_SKIP = new Set(["loc", "start", "end", "extra", "errors", "comments", "tokens"]);

function walkAst(node, visit, parent = null) {
  if (!node || typeof node !== "object") return;
  if (typeof node.type === "string") visit(node, parent);
  for (const [key, value] of Object.entries(node)) {
    if (AST_KEYS_TO_SKIP.has(key)) continue;
    if (Array.isArray(value)) for (const child of value) walkAst(child, visit, node);
    else if (value && typeof value === "object") walkAst(value, visit, node);
  }
}

function patternNames(pattern, output = []) {
  if (!pattern) return output;
  if (pattern.type === "Identifier") output.push(pattern.name);
  else if (pattern.type === "ObjectPattern") {
    for (const property of pattern.properties || []) {
      if (property.type === "ObjectProperty") patternNames(property.value, output);
      else if (property.type === "RestElement") patternNames(property.argument, output);
    }
  } else if (pattern.type === "ArrayPattern") {
    for (const element of pattern.elements || []) patternNames(element, output);
  } else if (pattern.type === "AssignmentPattern") patternNames(pattern.left, output);
  else if (pattern.type === "RestElement") patternNames(pattern.argument, output);
  return output;
}

function unwrapExpression(node) {
  let current = node;
  while (["TSAsExpression", "TSTypeAssertion", "TSNonNullExpression", "ParenthesizedExpression",
    "AwaitExpression"].includes(current?.type)) current = current.expression || current.argument;
  return current;
}

function returnedExpression(fn) {
  if (!["ArrowFunctionExpression", "FunctionExpression"].includes(fn?.type)) return null;
  if (fn.body?.type !== "BlockStatement") return fn.body;
  const returns = (fn.body.body || []).filter((row) => row.type === "ReturnStatement" && row.argument);
  return returns.length === 1 ? returns[0].argument : null;
}

function factoryFromExpression(expression) {
  const node = unwrapExpression(expression);
  if (node?.type !== "CallExpression" && node?.type !== "OptionalCallExpression") return null;
  if (node.callee?.type === "Identifier" && RECOGNIZED_FACTORY_SET.has(node.callee.name)) return node.callee.name;
  // Existing generated code legitimately memoises capability objects. Only accept the known
  // transparent wrapper shape; arbitrary functions receiving a factory result are not provenance.
  if (node.callee?.type === "Identifier" && node.callee.name === "useMemo") {
    return factoryFromExpression(returnedExpression(node.arguments?.[0]));
  }
  return null;
}

function capabilitySourceFromExpression(expression, module) {
  const node = unwrapExpression(expression);
  if (node?.type === "Identifier") {
    const factory = module.instances.get(node.name);
    return factory ? { factory, kind: "named", local: node.name } : null;
  }
  const factory = factoryFromExpression(node);
  return factory ? { factory, kind: "factory_result", local: null } : null;
}

function directSourceKey(source, node) {
  return `${source.factory}:${node?.start ?? "?"}:${node?.end ?? "?"}`;
}

function recordDirectSource(module, source, node) {
  if (source?.kind !== "factory_result") return;
  module.directInstances.set(directSourceKey(source, node), {
    factory: source.factory,
    kind: source.kind,
    start: node?.start ?? null,
    end: node?.end ?? null,
  });
}

function propertyName(node) {
  if (node?.type === "Identifier") return node.name;
  if (node?.type === "StringLiteral") return node.value;
  return null;
}

function localName(node) {
  if (node?.type === "Identifier") return node.name;
  if (node?.type === "AssignmentPattern" && node.left?.type === "Identifier") return node.left.name;
  return null;
}

/**
 * Every Identifier node that NAMES a new binding rather than reading an existing one.
 *
 * Collected as node identities, not names, because shorthand destructuring
 * (`const { createBooking } = capability`) produces an Identifier in value position that is
 * still a declaration — treating it as a read would make "bound but never used" unobservable.
 */
function collectPatternNodes(pattern, output) {
  if (!pattern || typeof pattern !== "object") return output;
  if (pattern.type === "Identifier") output.add(pattern);
  else if (pattern.type === "ObjectPattern") {
    for (const property of pattern.properties || []) {
      if (property.type === "ObjectProperty") {
        if (!property.computed) output.add(property.key);
        collectPatternNodes(property.value, output);
      } else if (property.type === "RestElement") collectPatternNodes(property.argument, output);
    }
  } else if (pattern.type === "ArrayPattern") {
    for (const element of pattern.elements || []) collectPatternNodes(element, output);
  } else if (pattern.type === "AssignmentPattern") collectPatternNodes(pattern.left, output);
  else if (pattern.type === "RestElement") collectPatternNodes(pattern.argument, output);
  return output;
}

function declarationNodesOf(ast) {
  const nodes = new Set();
  walkAst(ast, (node) => {
    if (node.type === "VariableDeclarator") collectPatternNodes(node.id, nodes);
    else if (["FunctionDeclaration", "ClassDeclaration", "FunctionExpression", "ArrowFunctionExpression"]
      .includes(node.type)) {
      if (node.id) nodes.add(node.id);
      for (const parameter of node.params || []) collectPatternNodes(parameter, nodes);
    } else if (node.type === "CatchClause") collectPatternNodes(node.param, nodes);
    else if (node.type === "ImportDeclaration") {
      for (const specifier of node.specifiers || []) {
        if (specifier.local) nodes.add(specifier.local);
        if (specifier.imported) nodes.add(specifier.imported);
      }
    } else if (node.type === "ExportSpecifier") {
      if (node.local) nodes.add(node.local);
      if (node.exported) nodes.add(node.exported);
    }
  });
  return nodes;
}

/** Is this node the thing being called, rather than a value being passed around? */
function isCalleeOf(node, parent) {
  if (!["CallExpression", "OptionalCallExpression"].includes(parent?.type)) return false;
  return unwrapExpression(parent.callee) === node || parent.callee === node;
}

/**
 * Identifiers that NAME a binding rather than read one. Without this, every declaration would
 * count as a reference to itself and `const { subscribe } = wizard` would look used on sight.
 */
function isDeclarationName(node, parent) {
  if (!parent) return false;
  if (parent.type === "VariableDeclarator" && parent.id === node) return true;
  if (["FunctionDeclaration", "ClassDeclaration", "FunctionExpression", "ArrowFunctionExpression"]
    .includes(parent.type) && parent.id === node) return true;
  if (parent.type === "ObjectProperty" && parent.key === node && !parent.computed) return true;
  if (["MemberExpression", "OptionalMemberExpression"].includes(parent.type)
    && parent.property === node && !parent.computed) return true;
  if (["ImportSpecifier", "ImportDefaultSpecifier", "ImportNamespaceSpecifier"].includes(parent.type)) return true;
  if (parent.type === "ExportSpecifier") return true;
  if (parent.type === "JSXAttribute" && parent.name === node) return true;
  return false;
}

function resolveGeneratedImport(importer, specifier, files) {
  if (!specifier?.startsWith(".")) return null;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(importer), specifier));
  const candidates = [base, ...[".js", ".jsx", ".ts", ".tsx"].map((ext) => `${base}${ext}`),
    ...[".js", ".jsx", ".ts", ".tsx"].map((ext) => `${base}/index${ext}`)];
  return candidates.find((candidate) => files.has(candidate)) || null;
}

function parseGeneratedModules(tree) {
  const modules = new Map();
  for (const [file, raw] of Object.entries(tree || {})) {
    if (!GENERATED_FILE.test(file) || PLATFORM_PATH.test(file)) continue;
    try {
      const typescript = /\.tsx?$/.test(file);
      const ast = parse(String(raw), {
        sourceType: "module",
        plugins: [typescript ? "typescript" : null, /\.(?:jsx|tsx)$/.test(file) ? "jsx" : null].filter(Boolean),
        errorRecovery: false,
      });
      modules.set(file, {
        ast,
        declarations: new Map(),
        instances: new Map(),
        directInstances: new Map(),
        aliases: new Map(),
        exports: new Map(),
        exportLocals: [],
        imports: [],
        identifierCalls: new Set(),
        identifierReferences: new Set(),
        capabilityMemberCalls: [],
        unknownMemberCalls: [],
      });
    } catch {
      // Parse failure is independently blocked by the patch/index gate. Never invent provenance.
    }
  }
  return modules;
}

function increment(map, name) {
  if (name) map.set(name, (map.get(name) || 0) + 1);
}

/**
 * Build total, machine-verifiable provenance facts for every recognised capability factory.
 * Requiredness is contract metadata; it never controls whether an actually used auxiliary
 * factory receives a fact record.
 */
export function aggregateCapabilityFacts(tree, bindings = []) {
  const modules = parseGeneratedModules(tree);
  for (const module of modules.values()) {
    const exportedDeclarations = new Set((module.ast.program.body || [])
      .filter((row) => row.type === "ExportNamedDeclaration" && row.declaration)
      .map((row) => row.declaration));

    // Pass 1 collects declarations and named factory results. Capability use is resolved in
    // pass 2 so a function body may safely refer to a module-level capability declared later.
    walkAst(module.ast, (node) => {
      if (node.type === "VariableDeclarator") for (const name of patternNames(node.id)) increment(module.declarations, name);
      else if (["FunctionDeclaration", "ClassDeclaration"].includes(node.type)) increment(module.declarations, node.id?.name);
      else if (["FunctionExpression", "ArrowFunctionExpression"].includes(node.type)) {
        for (const parameter of node.params || []) for (const name of patternNames(parameter)) increment(module.declarations, name);
      } else if (node.type === "CatchClause") {
        for (const name of patternNames(node.param)) increment(module.declarations, name);
      } else if (node.type === "ImportDeclaration") {
        for (const specifier of node.specifiers || []) {
          increment(module.declarations, specifier.local?.name);
          if (specifier.type === "ImportSpecifier") module.imports.push({
            source: node.source.value,
            imported: propertyName(specifier.imported),
            local: specifier.local.name,
          });
        }
      } else if (node.type === "ExportNamedDeclaration" && !node.source) {
        for (const specifier of node.specifiers || []) module.exportLocals.push({
          local: propertyName(specifier.local), exported: propertyName(specifier.exported),
        });
      }

      if (node.type === "VariableDeclarator" && node.id?.type === "Identifier") {
        const factory = factoryFromExpression(node.init);
        if (factory) module.instances.set(node.id.name, factory);
      }
    });

    // Pass 2 resolves every supported binding/use through the same source abstraction: either a
    // named identifier already proven in pass 1 or a direct recognised factory result.
    //
    // A capability method is USED when the application reaches it — whether it calls it
    // (`wizard.next()`) or hands it to a consumer that will (`useSyncExternalStore(
    // wizard.subscribe, wizard.getState)`). The platform's own stores are built for exactly
    // that second shape, so the member expression is inspected wherever it appears, and
    // "was it the callee?" becomes a recorded property rather than the price of admission.
    const declarationNodes = declarationNodesOf(module.ast);
    walkAst(module.ast, (node, parent) => {
      if (["CallExpression", "OptionalCallExpression"].includes(node.type)) {
        const callee = unwrapExpression(node.callee);
        if (callee?.type === "Identifier") module.identifierCalls.add(callee.name);
      }
      if (node.type === "Identifier" && !declarationNodes.has(node) && !isDeclarationName(node, parent)) {
        module.identifierReferences.add(node.name);
      }
      if (["MemberExpression", "OptionalMemberExpression"].includes(node.type) && !node.computed) {
        const source = capabilitySourceFromExpression(node.object, module);
        const method = propertyName(node.property);
        if (source && method) {
          const known = FACTORY_METHODS[source.factory]?.includes(method);
          const property = (FACTORY_PROPERTIES[source.factory] || []).includes(method);
          if (known) {
            recordDirectSource(module, source, node.object);
            module.capabilityMemberCalls.push({ source, method, invoked: isCalleeOf(node, parent) });
          } else if (!property && isCalleeOf(node, parent)) {
            // Calling something the capability does not expose is a guaranteed TypeError.
            module.unknownMemberCalls.push({ factory: source.factory, method });
          }
        }
      }
      if (node.type === "VariableDeclarator" && node.id?.type === "ObjectPattern"
        && node.init) {
        const source = capabilitySourceFromExpression(node.init, module);
        if (!source) return;
        recordDirectSource(module, source, node.init);
        for (const property of node.id.properties || []) {
          if (property.type !== "ObjectProperty" || property.computed) continue;
          const method = propertyName(property.key);
          const local = localName(property.value);
          if (!method || !local || !FACTORY_METHODS[source.factory]?.includes(method)) continue;
          module.aliases.set(local, { factory: source.factory, method, source });
        }
      }
    });

    // Export declarations wrap VariableDeclaration, while the declarator's immediate parent is
    // that declaration. Resolve exported destructuring explicitly at program level.
    for (const declaration of exportedDeclarations) {
      if (declaration.type !== "VariableDeclaration") continue;
      for (const declarator of declaration.declarations || []) {
        for (const local of patternNames(declarator.id)) {
          const provenance = module.aliases.get(local);
          if (provenance) module.exports.set(local, provenance);
        }
      }
    }
    for (const specifier of module.exportLocals) {
      const provenance = module.aliases.get(specifier.local);
      if (provenance) module.exports.set(specifier.exported, provenance);
    }
  }

  const files = new Set(modules.keys());
  for (const [file, module] of modules) {
    for (const imported of module.imports) {
      const resolved = resolveGeneratedImport(file, imported.source, files);
      const provenance = resolved ? modules.get(resolved)?.exports.get(imported.imported) : null;
      if (provenance) module.aliases.set(imported.local, provenance);
    }
  }

  const requiredFactories = new Set(bindings
    .filter((binding) => binding.requiredMethods?.length)
    .map((binding) => CAPABILITY_FACTORIES[binding.name])
    .filter(Boolean));
  // `invoked` = called directly. `referenced` = handed to a consumer that will call it.
  // `used` = either; it is what "the application reaches this behaviour" actually means.
  const emptyFact = (factory) => ({
    factory,
    required: requiredFactories.has(factory),
    instances: [],
    bindings: [],
    invocations: [],
    references: [],
    unknownMethods: [],
    modules: new Set(),
    bound: new Set(),
    invoked: new Set(),
    referenced: new Set(),
    used: new Set(),
  });
  const facts = new Map(RECOGNIZED_CAPABILITY_FACTORIES.map((factory) => [factory, emptyFact(factory)]));
  const factFor = (factory) => {
    if (!RECOGNIZED_FACTORY_SET.has(factory)) return null;
    let fact = facts.get(factory);
    if (!fact) { fact = emptyFact(factory); facts.set(factory, fact); }
    return fact;
  };
  for (const [file, module] of modules) {
    for (const [instance, factory] of module.instances) {
      if (module.declarations.get(instance) !== 1) continue; // ambiguous/shadowed names fail closed
      const fact = factFor(factory);
      if (!fact) continue;
      fact.instances.push({ module: file, local: instance, kind: "named" });
      fact.modules.add(file);
    }
    for (const source of module.directInstances.values()) {
      const fact = factFor(source.factory);
      if (!fact) continue;
      fact.instances.push({ module: file, local: null, kind: source.kind, start: source.start, end: source.end });
      fact.modules.add(file);
    }
    for (const call of module.capabilityMemberCalls) {
      if (call.source.kind === "named" && module.declarations.get(call.source.local) !== 1) continue;
      const fact = factFor(call.source.factory);
      if (!fact) continue;
      const kind = call.source.kind === "named" ? "member" : "factory_result_member";
      fact.bound.add(call.method);
      fact.used.add(call.method);
      fact.bindings.push({ module: file, local: call.source.local, method: call.method, kind });
      if (call.invoked) {
        fact.invoked.add(call.method);
        fact.invocations.push({ module: file, local: call.source.local, method: call.method, kind });
      } else {
        // `useSyncExternalStore(wizard.subscribe, wizard.getState)` — the platform's own store
        // contract. The reference IS the use; the consumer performs the call.
        fact.referenced.add(call.method);
        fact.references.push({ module: file, local: call.source.local, method: call.method,
          kind: `${kind}_reference` });
      }
      fact.modules.add(file);
    }
    for (const unknown of module.unknownMemberCalls) {
      const fact = factFor(unknown.factory);
      if (fact) fact.unknownMethods.push({ module: file, method: unknown.method });
    }
    for (const [alias, provenance] of module.aliases) {
      if (module.declarations.get(alias) !== 1) continue; // a local redeclaration cannot borrow provenance
      if (provenance.source?.kind === "named"
        && module.instances.has(provenance.source.local)
        && module.declarations.get(provenance.source.local) !== 1) continue;
      const fact = factFor(provenance.factory);
      if (!fact) continue;
      fact.bound.add(provenance.method);
      fact.bindings.push({ module: file, local: alias, method: provenance.method,
        kind: provenance.source?.kind === "factory_result" ? "factory_result_destructured" : "destructured" });
      fact.modules.add(file);
      if (module.identifierCalls.has(alias)) {
        fact.invoked.add(provenance.method);
        fact.used.add(provenance.method);
        fact.invocations.push({ module: file, local: alias, method: provenance.method, kind: "destructured" });
      } else if (module.identifierReferences.has(alias)) {
        // `const { subscribe, getState } = wizard; useSyncExternalStore(subscribe, getState)`
        fact.referenced.add(provenance.method);
        fact.used.add(provenance.method);
        fact.references.push({ module: file, local: alias, method: provenance.method,
          kind: "destructured_reference" });
      }
    }
  }
  return facts;
}

/**
 * Contract-required capabilities must exist in the produced tree and be used through their
 * actual interface. This is deliberately visual-style agnostic: it inspects behaviour calls,
 * never JSX structure or CSS.
 */
export function lintRequiredCapabilityBindings(tree, bindings = []) {
  const source = generatedSource(tree);
  const provenance = aggregateCapabilityFacts(tree, bindings);
  const problems = [];
  const issues = [];
  const reject = (code, message, details = {}) => {
    problems.push(message);
    issues.push({ code, message, ...details });
  };
  for (const binding of bindings.filter((row) => row.requiredMethods?.length)) {
    const factory = CAPABILITY_FACTORIES[binding.name];
    if (!factory) continue;
    const facts = provenance.get(factory);
    if (!facts?.instances.length) {
      reject("required_factory_missing",
        `required capability ${binding.name} is missing: instantiate ${factory}(...) before verification`,
        { capability: binding.name, factory });
      continue;
    }
    const entity = binding.configuration?.entity;
    if (entity) {
      const escaped = String(entity).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const configured = new RegExp(`\\b${factory}\\s*\\(\\s*\\{[\\s\\S]{0,600}?\\bentity\\s*:\\s*["'\\x60]${escaped}["'\\x60]`, "m");
      if (!configured.test(source)) {
        reject("invalid_factory_configuration",
          `required capability ${binding.name} must be configured with entity: ${JSON.stringify(entity)}; unsupported option names are rejected`,
          { capability: binding.name, factory, configuration: { entity } });
      }
    }
    if (binding.name === "wizard" && binding.configuration?.persistence === "platform") {
      const disabledPersistence = /\bmakeWizardMachine\s*\(\s*\{[\s\S]{0,1000}?\bpersistence\s*:\s*(?:null|false|undefined)\b/m;
      if (disabledPersistence.test(source)) {
        reject("invalid_factory_configuration",
          "required capability wizard must use platform persistence; persistence: null/false/undefined is forbidden",
          { capability: binding.name, factory, configuration: { persistence: "platform" } });
      }
    }
    for (const method of binding.requiredMethods) {
      if (!facts.bound.has(method)) {
        reject("required_method_unbound", `required capability ${binding.name} is not bound to ${method}(...)`,
          { capability: binding.name, factory, method });
      } else if (!facts.used.has(method)) {
        // Bound but neither called nor handed to a consumer. Advisory: the browser journey is
        // the authority on whether the behaviour actually reaches the user.
        reject("required_method_uninvoked", `required capability ${binding.name} binds ${method}(...) but neither invokes nor passes it`,
          { capability: binding.name, factory, method });
      }
    }
  }
  return { ok: problems.length === 0, problems, issues };
}

/** Exact module existence/factory placement for a deterministic module plan. */
export function lintRequiredModulePlan(tree, plan = []) {
  const problems = [];
  for (const module of plan) {
    if (typeof tree?.[module.path] !== "string") {
      problems.push(`required planned module is missing: ${module.path} (${module.role})`);
      continue;
    }
    if (module.factory && !new RegExp(`\\b${module.factory}\\s*\\(`).test(String(tree[module.path]))) {
      problems.push(`required planned module ${module.path} must bind ${module.factory}(...)`);
    }
  }
  return { ok: problems.length === 0, problems };
}
