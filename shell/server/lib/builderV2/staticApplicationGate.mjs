// Cheap pre-browser application integration gates for composed Builder V2 trees.
// Browser verification remains authoritative for behaviour. These checks reject only defects
// that execution cannot make valid: unparseable source, unresolved identifiers, broken protected
// composition, missing exports and unreachable contracted modules/extensions.

import { parse } from "@babel/parser";
import path from "node:path";

import { indexTree } from "./indexer.mjs";
import { memoryGraph } from "./graphStore.mjs";
import { scaffoldCompositionPlan, validateScaffoldComposition,
  SCAFFOLD_MANIFEST_PATH } from "./scaffoldComposer.mjs";
import { journeySurfaceContext } from "./surfaceIntegration.mjs";

const SOURCE = /^src\/.*\.(?:jsx?|tsx?|mjs|cjs)$/;
const ENTRY = /^src\/(?:main|index|App)\.(?:jsx?|tsx?)$/;
const PLATFORM = /^src\/lib\/(?:backend\/|capabilities\/|scaffolds\/composed\/|visitorSession\.js$|assets\.js$|assetData\.js$)/;
const unique = (values) => [...new Set((values || []).filter(Boolean))];

const GLOBALS = new Set([
  "AbortController", "Array", "ArrayBuffer", "Atomics", "BigInt", "BigInt64Array",
  "BigUint64Array", "Blob", "Boolean", "BroadcastChannel", "Buffer", "ByteLengthQueuingStrategy",
  "CSS", "CSSStyleSheet", "CloseEvent", "CompressionStream", "console", "CountQueuingStrategy",
  "crypto", "CustomEvent", "DataView", "Date", "decodeURI", "decodeURIComponent", "document",
  "DOMException", "Element", "encodeURI", "encodeURIComponent", "Error", "EvalError", "Event",
  "EventSource", "fetch", "File", "FileList", "FileReader", "FinalizationRegistry", "Float32Array",
  "Float64Array", "FormData", "Function", "globalThis", "Headers", "history", "HTMLAnchorElement",
  "HTMLElement", "HTMLInputElement", "HTMLSelectElement", "HTMLTextAreaElement", "Infinity", "Int16Array",
  "Int32Array", "Int8Array", "Intl", "isFinite", "isNaN", "JSON", "location", "Map", "Math",
  "MessageChannel", "MessageEvent", "MessagePort", "MutationObserver", "NaN", "Navigator", "navigator",
  "Number", "Object", "parseFloat", "parseInt", "performance", "Promise", "Proxy", "queueMicrotask",
  "RangeError", "ReadableStream", "ReferenceError", "Reflect", "RegExp", "Request", "ResizeObserver",
  "Response", "screen", "Set", "SharedArrayBuffer", "String", "structuredClone", "Symbol", "SyntaxError",
  "TextDecoder", "TextEncoder", "TypeError", "Uint16Array", "Uint32Array", "Uint8Array", "Uint8ClampedArray",
  "undefined", "URIError", "URL", "URLSearchParams", "WeakMap", "WeakRef", "WeakSet", "WebSocket",
  "window", "WritableStream", "XMLHttpRequest", "setTimeout", "clearTimeout", "setInterval", "clearInterval",
  "requestAnimationFrame", "cancelAnimationFrame", "alert", "confirm", "prompt",
]);

function addPattern(pattern, bindings, declarations = null) {
  if (!pattern) return;
  if (pattern.type === "Identifier") { bindings.add(pattern.name); declarations?.add(pattern); return; }
  if (pattern.type === "RestElement") { addPattern(pattern.argument, bindings, declarations); return; }
  if (pattern.type === "AssignmentPattern") { addPattern(pattern.left, bindings, declarations); return; }
  if (pattern.type === "ArrayPattern") { for (const element of pattern.elements || []) addPattern(element, bindings, declarations); return; }
  if (pattern.type === "ObjectPattern") {
    for (const property of pattern.properties || []) {
      if (property.key?.type === "Identifier") declarations?.add(property.key);
      addPattern(property.value || property.argument, bindings, declarations);
    }
  }
}

const childrenOf = (node) => Object.entries(node || {}).flatMap(([key, value]) => {
  if (["loc", "start", "end", "extra", "comments", "tokens", "errors"].includes(key)) return [];
  if (Array.isArray(value)) return value.filter((entry) => entry && typeof entry.type === "string")
    .map((entry) => [key, entry]);
  return value && typeof value.type === "string" ? [[key, value]] : [];
});

function undefinedInSource(source, path) {
  let ast;
  try {
    ast = parse(source, { sourceType: "unambiguous", plugins: ["jsx",
      ...(path.endsWith(".ts") || path.endsWith(".tsx") ? ["typescript"] : [])] });
  } catch (error) {
    return { parseError: error.message, identifiers: [], imports: [] };
  }
  const root = { parent: null, bindings: new Set() };
  const scopes = [root];
  const functionScopes = new WeakMap();
  const declarations = new WeakSet();

  const collect = (node, scope, parent = null, key = null) => {
    if (!node || typeof node.type !== "string" || node.type.startsWith("TS")) return;
    if (node.type === "ImportDeclaration") {
      for (const specifier of node.specifiers || []) addPattern(specifier.local, scope.bindings, declarations);
    } else if (node.type === "VariableDeclarator") addPattern(node.id, scope.bindings, declarations);
    else if (node.type === "ClassDeclaration" && node.id) { scope.bindings.add(node.id.name); declarations.add(node.id); }
    else if (node.type === "FunctionDeclaration" && node.id) { scope.bindings.add(node.id.name); declarations.add(node.id); }

    if (["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression", "ObjectMethod", "ClassMethod"].includes(node.type)) {
      const child = { parent: scope, bindings: new Set() };
      scopes.push(child);
      functionScopes.set(node, child);
      if (node.type === "FunctionExpression" && node.id) { child.bindings.add(node.id.name); declarations.add(node.id); }
      for (const param of node.params || []) addPattern(param, child.bindings, declarations);
      for (const [, nested] of childrenOf(node)) {
        if (nested === node.id || (node.params || []).includes(nested)) continue;
        collect(nested, child, node, key);
      }
      return;
    }
    if (node.type === "CatchClause" && node.param) addPattern(node.param, scope.bindings, declarations);
    for (const [childKey, child] of childrenOf(node)) collect(child, scope, node, childKey);
  };
  collect(ast.program, root);
  const unresolved = new Map();
  const bound = (scope, name) => {
    for (let current = scope; current; current = current.parent) if (current.bindings.has(name)) return true;
    return GLOBALS.has(name);
  };
  const isReference = (node, parent, key) => {
    if (!parent) return false;
    if (declarations.has(node)) return false;
    if (["ImportSpecifier", "ImportDefaultSpecifier", "ImportNamespaceSpecifier", "ExportSpecifier",
      "LabeledStatement", "BreakStatement", "ContinueStatement"].includes(parent.type)) return false;
    if ((parent.type === "VariableDeclarator" && key === "id")
      || ((parent.type === "FunctionDeclaration" || parent.type === "FunctionExpression") && key === "id")
      || ((parent.type === "ClassDeclaration" || parent.type === "ClassExpression") && key === "id")
      || (parent.type === "CatchClause" && key === "param")) return false;
    if ((parent.params || []).includes(node)) return false;
    if (["MemberExpression", "OptionalMemberExpression"].includes(parent.type)
      && key === "property" && !parent.computed) return false;
    if (["ObjectProperty", "ObjectMethod", "ClassMethod", "ClassProperty"].includes(parent.type)
      && key === "key" && !parent.computed && !parent.shorthand) return false;
    if (parent.type === "MetaProperty") return false;
    return true;
  };
  const inspect = (node, scope, parent = null, key = null) => {
    if (!node || typeof node.type !== "string" || node.type.startsWith("TS")) return;
    const active = functionScopes.get(node) || scope;
    if (node.type === "Identifier" && isReference(node, parent, key) && !bound(scope, node.name)) {
      const line = node.loc?.start?.line || 0;
      unresolved.set(`${node.name}:${line}`, { name: node.name, line });
    }
    for (const [childKey, child] of childrenOf(node)) {
      const next = functionScopes.has(node) && !((node.params || []).includes(child) || child === node.id)
        ? active : scope;
      inspect(child, next, node, childKey);
    }
  };
  inspect(ast.program, root);
  return { parseError: null, identifiers: [...unresolved.values()], imports: (ast.program.body || [])
    .filter((node) => node.type === "ImportDeclaration" && typeof node.source?.value === "string")
    .map((node) => node.source.value) };
}

function resolvedImportCandidates(from, specifier) {
  const raw = specifier.startsWith("@/") ? `src/${specifier.slice(2)}`
    : path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
  return unique([raw, ...[".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"].map((extension) => `${raw}${extension}`),
    ...[".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"].map((extension) => `${raw}/index${extension}`)]);
}

export function lintUndefinedIdentifiers(tree = {}) {
  const findings = [];
  for (const [path, source] of Object.entries(tree)) {
    if (!SOURCE.test(path) || typeof source !== "string") continue;
    const result = undefinedInSource(source, path);
    if (result.parseError) findings.push({ code: "source_parse_error", file: path,
      message: `${path} does not parse: ${result.parseError}` });
    if (PLATFORM.test(path)) continue;
    for (const identifier of result.identifiers) findings.push({ code: "undefined_identifier", file: path,
      identifier: identifier.name, line: identifier.line,
      message: `${path}:${identifier.line} references undefined identifier ${identifier.name}` });
  }
  return findings;
}

export function lintUnresolvedImports(tree = {}) {
  const findings = [];
  for (const [file, source] of Object.entries(tree)) {
    if (!SOURCE.test(file) || typeof source !== "string") continue;
    const parsed = undefinedInSource(source, file);
    if (parsed.parseError) continue;
    for (const specifier of parsed.imports || []) {
      if (!specifier.startsWith(".") && !specifier.startsWith("@/")) continue;
      if (resolvedImportCandidates(file, specifier).some((candidate) => typeof tree[candidate] === "string")) continue;
      findings.push({ code: "unresolved_import", file, specifier,
        message: `${file} imports unresolved module ${specifier}` });
    }
  }
  return findings;
}

function reachablePaths(tree) {
  const graph = memoryGraph("static-scaffold", "static-scaffold", indexTree(tree));
  const reachable = new Set();
  const queue = Object.keys(tree).filter((path) => ENTRY.test(path));
  while (queue.length) {
    const current = queue.shift();
    if (reachable.has(current)) continue;
    reachable.add(current);
    for (const dependency of graph.importsOf(current)) if (!reachable.has(dependency)) queue.push(dependency);
  }
  return reachable;
}

function parseSource(source, file) {
  try {
    return parse(source, { sourceType: "unambiguous", plugins: ["jsx",
      ...(file.endsWith(".ts") || file.endsWith(".tsx") ? ["typescript"] : [])] });
  } catch {
    return null;
  }
}

const memberName = (member) => {
  if (!["MemberExpression", "OptionalMemberExpression"].includes(member?.type)) return null;
  return member.computed ? literalValue(member.property) : member.property?.name || null;
};

function nodeContainsAttributeRead(node, attributeName) {
  let found = false;
  const inspect = (current) => {
    if (found || !current || typeof current.type !== "string") return;
    if (["CallExpression", "OptionalCallExpression"].includes(current.type)
        && ["getAttribute", "hasAttribute"].includes(memberName(current.callee))
        && literalValue(current.arguments?.[0]) === attributeName) {
      found = true;
      return;
    }
    for (const [, child] of childrenOf(current)) inspect(child);
  };
  inspect(node);
  return found;
}

function observerCallbackWrites(callback) {
  const writes = [];
  const inspect = (node, ancestors = []) => {
    if (!node || typeof node.type !== "string") return;
    const operation = ["setAttribute", "removeAttribute", "toggleAttribute"].includes(memberName(node.callee))
      ? memberName(node.callee) : null;
    const attributeName = operation ? literalValue(node.arguments?.[0]) : null;
    if (["CallExpression", "OptionalCallExpression"].includes(node.type) && attributeName) {
      const guarded = ancestors.some(({ node: parent, key }) => (
        (parent.type === "IfStatement" && key === "consequent"
          && nodeContainsAttributeRead(parent.test, attributeName))
        || (parent.type === "ConditionalExpression" && ["consequent", "alternate"].includes(key)
          && nodeContainsAttributeRead(parent.test, attributeName))
        || (parent.type === "LogicalExpression" && key === "right"
          && nodeContainsAttributeRead(parent.left, attributeName))
      ));
      if (!guarded) writes.push({ attributeName, operation, line: node.loc?.start?.line || 0 });
    }
    for (const [key, child] of childrenOf(node)) inspect(child, [...ancestors, { node, key }]);
  };
  inspect(callback);
  return writes;
}

/** Reject a MutationObserver callback that can retrigger itself by rewriting a watched attribute. */
export function lintSelfTriggeringMutationObservers(tree = {}) {
  const findings = [];
  for (const [file, source] of Object.entries(tree)) {
    if (!SOURCE.test(file) || PLATFORM.test(file) || typeof source !== "string") continue;
    const ast = parseSource(source, file);
    if (!ast) continue;
    const functions = new Map();
    const observers = new Map();
    const observeCalls = [];
    const collect = (node) => {
      if (!node || typeof node.type !== "string") return;
      if (node.type === "FunctionDeclaration" && node.id) functions.set(node.id.name, node);
      if (node.type === "VariableDeclarator" && node.id?.type === "Identifier") {
        if (["ArrowFunctionExpression", "FunctionExpression"].includes(node.init?.type)) {
          functions.set(node.id.name, node.init);
        }
        if (node.init?.type === "NewExpression" && node.init.callee?.type === "Identifier"
            && node.init.callee.name === "MutationObserver") {
          observers.set(node.id.name, node.init.arguments?.[0] || null);
        }
      }
      if (["CallExpression", "OptionalCallExpression"].includes(node.type)
          && memberName(node.callee) === "observe" && node.callee.object?.type === "Identifier") {
        observeCalls.push({ observer: node.callee.object.name, options: node.arguments?.[1] || null });
      }
      for (const [, child] of childrenOf(node)) collect(child);
    };
    collect(ast.program);

    for (const call of observeCalls) {
      const callbackReference = observers.get(call.observer);
      const callback = callbackReference?.type === "Identifier"
        ? functions.get(callbackReference.name) : callbackReference;
      if (!callback || call.options?.type !== "ObjectExpression") continue;
      const attributes = literalValue(literalObjectProperty(call.options, "attributes")?.value) === true;
      const subtree = literalValue(literalObjectProperty(call.options, "subtree")?.value) === true;
      const filterNode = literalObjectProperty(call.options, "attributeFilter")?.value;
      const attributeFilter = filterNode?.type === "ArrayExpression"
        ? new Set((filterNode.elements || []).map(literalValue).filter((value) => typeof value === "string"))
        : null;
      if (!attributes && !attributeFilter) continue;
      for (const write of observerCallbackWrites(callback)) {
        if (attributeFilter && !attributeFilter.has(write.attributeName)) continue;
        // With subtree observation, a callback that rewrites a watched attribute anywhere in the
        // observed surface can feed its own mutation queue. A same-node observer is equally unsafe;
        // generated callbacks must compare the current value before writing either shape.
        if (!subtree && call.options && !attributes) continue;
        findings.push({
          code: "self_triggering_mutation_observer",
          file,
          line: write.line,
          attribute: write.attributeName,
          message: `${file}:${write.line} rewrites watched attribute ${write.attributeName} `
            + "without checking its current value, which can retrigger its MutationObserver indefinitely",
        });
      }
    }
  }
  return findings;
}

/** A crowded mounted screen has one planned interaction controller, rendered exactly once. */
export function lintJourneyControllerMounts(tree = {}, modulePlan = []) {
  const findings = [];
  for (const screen of (modulePlan || []).filter((module) => (
    module?.providedBy === "scaffold_screen_slot" && module?.journeyController
  ))) {
    const source = tree?.[screen.path];
    if (typeof source !== "string") continue;
    const ast = parseSource(source, screen.path);
    if (!ast) continue;
    const locals = new Set();
    const namespaces = new Set();
    for (const declaration of ast.program.body || []) {
      if (declaration.type !== "ImportDeclaration" || typeof declaration.source?.value !== "string") continue;
      if (!resolvedImportCandidates(screen.path, declaration.source.value).includes(screen.journeyController)) continue;
      for (const specifier of declaration.specifiers || []) {
        if (specifier.type === "ImportNamespaceSpecifier") namespaces.add(specifier.local.name);
        else if (specifier.local?.name) locals.add(specifier.local.name);
      }
    }
    let mounts = 0;
    const inspect = (node) => {
      if (!node || typeof node.type !== "string") return;
      if (node.type === "JSXOpeningElement") {
        const name = node.name;
        if (name?.type === "JSXIdentifier" && locals.has(name.name)) mounts += 1;
        if (name?.type === "JSXMemberExpression" && name.object?.type === "JSXIdentifier"
          && namespaces.has(name.object.name)) mounts += 1;
      }
      for (const [, child] of childrenOf(node)) inspect(child);
    };
    inspect(ast.program);
    if (mounts !== 1) findings.push({
      code: "scaffold_composition_invalid", file: screen.path,
      journeyController: screen.journeyController, mounts,
      journeyIds: screen.journeyIds || [],
      message: `${screen.path} must render shared journey controller ${screen.journeyController} exactly once (found ${mounts})`,
    });
  }
  return findings;
}

function objectPropertyName(property) {
  if (!property || property.type === "SpreadElement") return null;
  if (property.computed && property.key?.type !== "StringLiteral") return null;
  if (property.key?.type === "Identifier") return property.key.name;
  if (["StringLiteral", "NumericLiteral"].includes(property.key?.type)) return String(property.key.value);
  return null;
}

function literalObjectProperty(object, name) {
  if (object?.type !== "ObjectExpression") return null;
  return (object.properties || []).find((property) => objectPropertyName(property) === name) || null;
}

function literalValue(node) {
  if (["StringLiteral", "NumericLiteral", "BooleanLiteral"].includes(node?.type)) return node.value;
  if (node?.type === "TemplateLiteral" && node.expressions?.length === 0) {
    return node.quasis?.[0]?.value?.cooked ?? null;
  }
  return null;
}

function normalizedSelector(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function extensionCallTarget(callee, named, namespaces) {
  if (callee?.type === "Identifier") return named.get(callee.name) || null;
  if (!["MemberExpression", "OptionalMemberExpression"].includes(callee?.type)
    || callee.object?.type !== "Identifier") return null;
  const extension = namespaces.get(callee.object.name);
  if (!extension) return null;
  const exportName = callee.computed ? literalValue(callee.property) : callee.property?.name;
  return (extension.requiredExports || []).includes(exportName) ? { extension, exportName } : null;
}

function localObjectBindings(ast) {
  const bindings = new Map();
  const ambiguous = new Set();
  const visit = (node) => {
    if (!node || typeof node.type !== "string") return;
    if (node.type === "VariableDeclarator" && node.id?.type === "Identifier"
      && node.init?.type === "ObjectExpression") {
      if (bindings.has(node.id.name)) ambiguous.add(node.id.name);
      else bindings.set(node.id.name, node.init);
    }
    for (const [, child] of childrenOf(node)) visit(child);
  };
  visit(ast.program);
  for (const name of ambiguous) bindings.delete(name);
  return bindings;
}

function callObject(argument, bindings) {
  if (argument?.type === "ObjectExpression") return argument;
  if (argument?.type === "Identifier") return bindings.get(argument.name) || null;
  return null;
}

const SESSION_INVOCATION_INPUTS = Object.freeze({
  signUp: Object.freeze(["email", "password"]),
  signIn: Object.freeze(["email", "password"]),
  resetPassword: Object.freeze(["email"]),
  confirmReset: Object.freeze(["email", "code", "newPassword"]),
});
const SESSION_MODULES = new Set([
  "src/lib/capabilities/session.js",
  "src/lib/capabilities/index.js",
  "src/lib/capabilities/composed/session.js",
  "src/lib/capabilities/composed/index.js",
]);

function sessionInvocationTarget(callee, named, namespaces) {
  if (callee?.type === "Identifier") return named.get(callee.name) || null;
  if (!["MemberExpression", "OptionalMemberExpression"].includes(callee?.type)
      || callee.object?.type !== "Identifier" || !namespaces.has(callee.object.name)) return null;
  const method = callee.computed ? literalValue(callee.property) : callee.property?.name;
  return SESSION_INVOCATION_INPUTS[method] ? method : null;
}

/** Reject generated calls that cannot satisfy the protected session capability's public API. */
export function lintCapabilityInvocationShapes(tree = {}) {
  const findings = [];
  for (const [file, source] of Object.entries(tree)) {
    if (!SOURCE.test(file) || PLATFORM.test(file) || typeof source !== "string") continue;
    const ast = parseSource(source, file);
    if (!ast) continue;
    const named = new Map();
    const namespaces = new Set();
    for (const declaration of ast.program.body || []) {
      if (declaration.type !== "ImportDeclaration" || typeof declaration.source?.value !== "string") continue;
      const sessionModule = resolvedImportCandidates(file, declaration.source.value)
        .some((candidate) => SESSION_MODULES.has(candidate));
      if (!sessionModule) continue;
      for (const specifier of declaration.specifiers || []) {
        if (specifier.type === "ImportNamespaceSpecifier") namespaces.add(specifier.local.name);
        if (specifier.type !== "ImportSpecifier") continue;
        const imported = specifier.imported?.name || specifier.imported?.value;
        if (SESSION_INVOCATION_INPUTS[imported]) named.set(specifier.local.name, imported);
      }
    }
    if (!named.size && !namespaces.size) continue;
    const bindings = localObjectBindings(ast);
    const inspect = (node) => {
      if (!node || typeof node.type !== "string") return;
      if (["CallExpression", "OptionalCallExpression"].includes(node.type)) {
        const method = sessionInvocationTarget(node.callee, named, namespaces);
        if (method) {
          const inputObject = callObject(node.arguments?.[0], bindings);
          const explicitKeys = new Set((inputObject?.properties || []).map(objectPropertyName).filter(Boolean));
          const missingInputs = SESSION_INVOCATION_INPUTS[method]
            .filter((input) => !explicitKeys.has(input));
          if (node.arguments?.length !== 1 || !inputObject || missingInputs.length) {
            const requiredInputs = SESSION_INVOCATION_INPUTS[method];
            const signature = `${method}({ ${requiredInputs.join(", ")} })`;
            findings.push({
              code: "capability_invocation_invalid",
              file,
              line: node.loc?.start?.line || 0,
              capability: "session",
              method,
              requiredInputs,
              missingInputs,
              explicitKeys: [...explicitKeys].sort(),
              argumentCount: node.arguments?.length || 0,
              message: `${file}:${node.loc?.start?.line || 0} must call the protected session capability as ${signature} with one explicit credentials object; positional arguments are not supported`,
            });
          }
        }
      }
      for (const [, child] of childrenOf(node)) inspect(child);
    };
    inspect(ast.program);
  }
  return findings;
}

function inputAliases(input, contract) {
  const value = String(input || "");
  const leaf = value.split(".").at(-1);
  return unique([value, leaf, ...(contract?.inputKeys || []).filter((key) => (
    key === value || key === leaf || String(key).split(".").at(-1) === leaf
  ))]);
}

/**
 * Prove the directly imported custom-extension seam. The gate intentionally requires an explicit,
 * inspectable input object: spreading a domain record is not evidence that its generic `id` field
 * satisfies a contract-owned `competitionId`, `projectId`, or any other semantic input.
 */
export function lintCustomExtensionInterfaces(tree = {}, scaffoldGraph = null, journeys = []) {
  const selectedJourneys = new Set((journeys || []).map((journey) => journey?.id).filter(Boolean));
  const extensions = (scaffoldGraph?.extensions || []).filter((extension) => (
    (extension.operationContracts || []).length
      && (!(extension.owningJourneys || []).length || (extension.owningJourneys || [])
        .some((journeyId) => selectedJourneys.has(journeyId)))
  ));
  if (!extensions.length) return [];
  const findings = [];
  for (const [file, source] of Object.entries(tree)) {
    if (!SOURCE.test(file) || typeof source !== "string" || PLATFORM.test(file)) continue;
    const ast = parseSource(source, file);
    if (!ast) continue;
    const named = new Map();
    const namespaces = new Map();
    for (const declaration of ast.program.body || []) {
      if (declaration.type !== "ImportDeclaration" || typeof declaration.source?.value !== "string") continue;
      const extension = extensions.find((candidate) => resolvedImportCandidates(file, declaration.source.value)
        .includes(candidate.module));
      if (!extension) continue;
      for (const specifier of declaration.specifiers || []) {
        if (specifier.type === "ImportDefaultSpecifier"
            && !(extension.requiredExports || []).includes("default")) {
          findings.push({
            code: "custom_extension_invalid",
            file,
            extensionId: extension.extensionId,
            exportName: "default",
            requiredExports: [...(extension.requiredExports || [])],
            message: `${file} imports a default value from ${extension.module}, but that custom extension `
              + `exports only [${(extension.requiredExports || []).join(", ")}]; import its declared named export instead`,
          });
          continue;
        }
        if (specifier.type === "ImportNamespaceSpecifier") namespaces.set(specifier.local.name, extension);
        if (specifier.type !== "ImportSpecifier") continue;
        const exportName = specifier.imported?.name || specifier.imported?.value;
        if ((extension.requiredExports || []).includes(exportName)) {
          named.set(specifier.local.name, { extension, exportName });
        }
      }
    }
    if (!named.size && !namespaces.size) continue;
    const bindings = localObjectBindings(ast);
    const inspect = (node) => {
      if (!node || typeof node.type !== "string") return;
      if (["CallExpression", "OptionalCallExpression"].includes(node.type)) {
        const target = extensionCallTarget(node.callee, named, namespaces);
        if (target) {
          const inputObject = callObject(node.arguments?.[0], bindings);
          const contextObject = callObject(node.arguments?.[1], bindings);
          // `operation` is the canonical selector documented by the scaffold contract. Generated
          // extensions have also long accepted the equally explicit `operationId` context key.
          // Treating the runtime-supported alias as absent made a valid multi-operation extension
          // impossible to correct: every repaired call still failed here as operation=null.
          const operationSelectors = ["operation", "operationId"]
            .map((name) => literalValue(literalObjectProperty(contextObject, name)?.value))
            .filter((value) => value !== null && value !== undefined);
          const selectorIdentities = unique(operationSelectors.map(normalizedSelector).filter(Boolean));
          const conflictingSelectors = selectorIdentities.length > 1;
          const operation = conflictingSelectors ? null : operationSelectors[0] ?? null;
          const normalizedOperation = normalizedSelector(operation);
          const contracts = (target.extension.operationContracts || []).filter((contract) => (
            normalizedOperation
              ? (contract.selectors || []).some((selector) => normalizedSelector(selector) === normalizedOperation)
              : target.extension.operationContracts.length === 1
          ));
          if (!inputObject || !contracts.length) {
            findings.push({
              code: "custom_extension_invalid", file, extensionId: target.extension.extensionId,
              exportName: target.exportName, operation: operation || null,
              allowedOperations: unique((target.extension.operationContracts || []).flatMap((contract) => (
                (contract.selectors || []).length ? contract.selectors : [contract.operationId]
              )).filter(Boolean)),
              journeyIds: target.extension.owningJourneys || [],
              message: !inputObject
                ? `${file} must call ${target.exportName} with an explicit inspectable input object`
                : conflictingSelectors
                  ? `${file} calls ${target.exportName} with conflicting literal context.operation and context.operationId selectors`
                  : operation === null
                    ? `${file} must call ${target.exportName} with a literal context.operation or context.operationId selector`
                    : `${file} calls ${target.exportName} with undeclared operation ${JSON.stringify(operation)}`,
            });
          } else {
            const explicitKeys = new Set((inputObject.properties || []).map(objectPropertyName).filter(Boolean));
            const requiredInputs = unique(contracts.flatMap((contract) => contract.inputs || []));
            const missingInputs = requiredInputs.filter((input) => !inputAliases(input,
              contracts.find((contract) => (contract.inputs || []).includes(input)))
              .some((alias) => explicitKeys.has(alias)));
            if (missingInputs.length) {
              findings.push({
                code: "custom_extension_invalid", file, extensionId: target.extension.extensionId,
                exportName: target.exportName, operation: operation || contracts[0]?.operationId || null,
                missingInputs, requiredInputs, explicitKeys: [...explicitKeys].sort(),
                journeyIds: target.extension.owningJourneys || [],
                message: `${file} calls ${target.exportName} for ${operation || contracts[0]?.operationId || "its declared operation"} `
                  + `without explicit contract input(s): ${missingInputs.join(", ")}. Object spreads do not satisfy named extension inputs.`,
              });
            }
          }
        }
      }
      for (const [, child] of childrenOf(node)) inspect(child);
    };
    inspect(ast.program);
  }
  return findings;
}

function structuralSurfaceFinding(tree, graph) {
  const expected = graph?.expectedModuleSurface;
  if (!expected?.extremeMaximum) return [];
  const generated = Object.keys(tree).filter((path) => SOURCE.test(path)
    && (/^src\/(?:screens|routes|components|extensions|data)\//.test(path) || /^src\/App\./.test(path))
    && !/^src\/components\/ui\//.test(path)
    && path !== "src/routes/HomePage.jsx"
    && !PLATFORM.test(path));
  if (generated.length <= expected.extremeMaximum) return [];
  return [{ code: "structural_expansion_exceeded", severity: "advisory",
    expectedMaximum: expected.extremeMaximum, observed: generated.length,
    message: `generated source surface ${generated.length} exceeds the contract-derived extreme ${expected.extremeMaximum}` }];
}

/** Production-composed trees only. Legacy fixtures without the scaffold manifest stay compatible. */
export function runStaticApplicationGate(tree, { contract = null, modulePlan = [], requireExtensions = true,
  rejectScreenSlots = true, journeys = contract?.journeys || [] } = {}) {
  const scaffoldGraph = contract?.scaffoldGraph || null;
  const active = Boolean(scaffoldGraph && typeof tree?.[SCAFFOLD_MANIFEST_PATH] === "string");
  if (!active) return { ok: true, active: false, blocking: [], advisory: [], checks: [] };
  const blocking = [];
  const advisory = [];
  const checks = [];
  const composition = validateScaffoldComposition(tree, scaffoldGraph, scaffoldCompositionPlan(scaffoldGraph), {
    requireExtensions, rejectScreenSlots, journeyIds: (journeys || []).map((journey) => journey?.id).filter(Boolean),
  });
  checks.push({ name: "scaffold_composition", ok: composition.ok, detail: composition.problems });
  blocking.push(...composition.problems.map((message) => ({
    code: /custom extension|must export/.test(message) ? "custom_extension_invalid" : "scaffold_composition_invalid",
    message,
  })));

  const undefinedIdentifiers = lintUndefinedIdentifiers(tree);
  const unresolvedImports = lintUnresolvedImports(tree);
  const extensionInterfaces = lintCustomExtensionInterfaces(tree, scaffoldGraph, journeys);
  const capabilityInvocationShapes = lintCapabilityInvocationShapes(tree);
  const journeyControllerMounts = lintJourneyControllerMounts(tree, modulePlan);
  const observerSafety = lintSelfTriggeringMutationObservers(tree);
  checks.push({ name: "source_integrity",
    ok: undefinedIdentifiers.length + unresolvedImports.length + extensionInterfaces.length
      + capabilityInvocationShapes.length + journeyControllerMounts.length + observerSafety.length === 0,
    detail: [...undefinedIdentifiers, ...unresolvedImports, ...extensionInterfaces,
      ...capabilityInvocationShapes, ...journeyControllerMounts, ...observerSafety]
      .map((finding) => finding.message) });
  blocking.push(...undefinedIdentifiers, ...unresolvedImports);
  blocking.push(...extensionInterfaces);
  blocking.push(...capabilityInvocationShapes);
  blocking.push(...journeyControllerMounts);
  blocking.push(...observerSafety);

  const reachable = reachablePaths(tree);
  const scopedContract = { ...contract, journeys };
  const surface = journeySurfaceContext(tree, scopedContract, journeys, { modulePlan });
  const unreachable = unique([
    ...surface.unreachableJourneyModules,
    ...(scaffoldGraph.extensions || []).filter((extension) => (extension.owningJourneys || [])
      .some((id) => (journeys || []).some((journey) => journey?.id === id))).map((extension) => extension.module)
      .filter((path) => typeof tree?.[path] === "string" && !reachable.has(path)),
  ]).filter((path) => !PLATFORM.test(path));
  checks.push({ name: "journey_reachability", ok: unreachable.length === 0, detail: unreachable });
  blocking.push(...unreachable.map((file) => {
    const journeyIds = unique([
      ...(modulePlan || []).filter((module) => module?.path === file)
        .flatMap((module) => module.journeyIds || module.ownedJourneys || []),
      ...(scaffoldGraph?.extensions || []).filter((extension) => extension?.module === file
        || (extension?.allowedFiles || []).includes(file)).flatMap((extension) => extension.owningJourneys || []),
      ...(scaffoldGraph?.journeyRouteOwnership || scaffoldGraph?.journeyOwnership || [])
        .filter((owner) => owner?.mountedModule === file)
        .map((owner) => owner.journeyId),
    ]).filter((id) => (journeys || []).some((journey) => journey?.id === id));
    const mountedModules = unique((scaffoldGraph?.journeyRouteOwnership
      || scaffoldGraph?.journeyOwnership || [])
      .filter((owner) => journeyIds.includes(owner?.journeyId)).map((owner) => owner.mountedModule));
    return { code: "journey_surface_unreachable", file, journeyIds, mountedModules,
      message: `${file} implements contracted work but is unreachable from the mounted live application` };
  }));

  const expansion = structuralSurfaceFinding(tree, scaffoldGraph);
  advisory.push(...expansion);
  checks.push({ name: "module_proportionality", ok: expansion.length === 0,
    detail: expansion.map((finding) => finding.message) });

  return { ok: blocking.length === 0, active: true, blocking, advisory, checks,
    mountedSurface: surface, reachable: [...reachable].sort() };
}
