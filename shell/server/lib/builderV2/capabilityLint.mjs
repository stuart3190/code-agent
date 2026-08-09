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
  makeWizardMachine: ["getState", "subscribe", "restore", "setValue", "select", "validateCurrent", "next", "back", "goTo", "confirm", "cancel", "reset"],
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

// Entity types OWNED by a capability: persisting them any other way bypasses session
// management and validation. Live run 4 wrote its own db.entity("contactMessage").create
// data layer with no session — an unauthenticated insert, a 401, and a dead build.
const OWNED_ENTITIES = Object.freeze({
  contactMessage: 'makeContactForm().submitContact(fields)',
  newsletterSignup: 'makeNewsletter().subscribe(email)',
  booking: 'makeBookingSystem().createBooking(...)',
});

// Stores are usually bound first (const store = db.entity(...)), so the mutation check is
// two-part: the module touches db.entity AND calls a mutating method on something.
const USES_ENTITIES_RE = /\bdb\s*\.\s*entity\s*\(/;
const MUTATION_RE = /\.\s*(create|update|remove|delete)\s*\(/;
const SESSION_RE = /ensureSession|ensureVisitorSession|currentUser/;

/**
 * Scan generated files for capability-instance method calls that the capability does not
 * export. Returns { ok, problems } with teaching-quality reasons.
 */
export function lintCapabilityUsage(tree) {
  const problems = [];
  for (const [path, source] of Object.entries(tree)) {
    if (!GENERATED_FILE.test(path) || PLATFORM_PATH.test(path)) continue;
    const code = String(source);

    // The monolith cap: every edit to an oversized file pays its whole body as context.
    const size = tokensOf(code);
    if (size > MAX_GENERATED_FILE_TOKENS) {
      problems.push(
        `${path} is ${size} tokens (cap ${MAX_GENERATED_FILE_TOKENS}) — split sections into `
        + `components under src/components/ and import them; single-file apps make every `
        + `future edit pay the whole file as context.`,
      );
    }

    // Capability-owned entities may ONLY be persisted through their capability.
    for (const [entity, correctCall] of Object.entries(OWNED_ENTITIES)) {
      const direct = new RegExp(`\\bdb\\s*\\.\\s*entity\\s*\\(\\s*["'\`]${entity}["'\`]`);
      if (direct.test(code)) {
        problems.push(
          `${path}: db.entity("${entity}") is a direct write to a capability-owned entity — `
          + `use ${correctCall} instead. The capability establishes the visitor session and `
          + `validation; the raw path sends an unauthenticated insert and fails with 401.`,
        );
      }
    }

    // Any other raw entity MUTATION in a module that never touches session management is an
    // unauthenticated write for anonymous visitors — same 401, different table.
    if (USES_ENTITIES_RE.test(code) && MUTATION_RE.test(code) && !SESSION_RE.test(code)) {
      problems.push(
        `${path}: db.entity(...).create/update/remove with NO session in this module — call `
        + `await ensureVisitorSession() (from ../lib/capabilities) before mutating, or use the `
        + `owning capability. Unauthenticated writes fail with 401 under row-level security.`,
      );
    }
    for (const [factory, methods] of Object.entries(FACTORY_METHODS)) {
      // Every binding of this factory's instance: const x = makeContactForm(...),
      // including through useMemo(() => makeContactForm(...)).
      const bindingRe = new RegExp(`(?:const|let|var)\\s+(\\w+)\\s*=[^;\\n]*\\b${factory}\\s*\\(`, "g");
      for (const bindingMatch of code.matchAll(bindingRe)) {
        const varName = bindingMatch[1];
        const callRe = new RegExp(`\\b${varName}\\.(\\w+)\\s*\\(`, "g");
        for (const call of code.matchAll(callRe)) {
          const method = call[1];
          if (methods.includes(method)) continue;
          if ((FACTORY_PROPERTIES[factory] || []).includes(method)) continue;
          problems.push(
            `${path}: ${varName}.${method}(...) does not exist — ${factory}() exposes exactly `
            + `[${methods.join(", ")}]. Call the real method; do not reimplement the capability.`,
          );
        }
      }
    }
  }
  return { ok: problems.length === 0, problems };
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
        capabilityMemberCalls: [],
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
    walkAst(module.ast, (node) => {
      if (["CallExpression", "OptionalCallExpression"].includes(node.type)) {
        const callee = unwrapExpression(node.callee);
        if (callee?.type === "Identifier") module.identifierCalls.add(callee.name);
        else if (["MemberExpression", "OptionalMemberExpression"].includes(callee?.type) && !callee.computed) {
          const source = capabilitySourceFromExpression(callee.object, module);
          const method = propertyName(callee.property);
          if (source && FACTORY_METHODS[source.factory]?.includes(method)) {
            recordDirectSource(module, source, callee.object);
            module.capabilityMemberCalls.push({ source, method });
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
  const facts = new Map(RECOGNIZED_CAPABILITY_FACTORIES.map((factory) => [factory, {
    factory,
    required: requiredFactories.has(factory),
    instances: [],
    bindings: [],
    invocations: [],
    modules: new Set(),
    bound: new Set(),
    invoked: new Set(),
  }]));
  const factFor = (factory) => {
    if (!RECOGNIZED_FACTORY_SET.has(factory)) return null;
    let fact = facts.get(factory);
    if (!fact) {
      fact = {
        factory, required: requiredFactories.has(factory), instances: [], bindings: [],
        invocations: [], modules: new Set(), bound: new Set(), invoked: new Set(),
      };
      facts.set(factory, fact);
    }
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
      fact.bound.add(call.method);
      fact.invoked.add(call.method);
      fact.bindings.push({ module: file, local: call.source.local, method: call.method,
        kind: call.source.kind === "named" ? "member" : "factory_result_member" });
      fact.invocations.push({ module: file, local: call.source.local, method: call.method,
        kind: call.source.kind === "named" ? "member" : "factory_result_member" });
      fact.modules.add(file);
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
        fact.invocations.push({ module: file, local: alias, method: provenance.method, kind: "destructured" });
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
      } else if (!facts.invoked.has(method)) {
        reject("required_method_uninvoked", `required capability ${binding.name} binds ${method}(...) but never invokes it`,
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
