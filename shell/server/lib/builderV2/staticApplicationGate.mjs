// Cheap pre-browser application integration gates for composed Builder V2 trees.
// Browser verification remains authoritative for behaviour. Blocking checks reject only defects
// that execution cannot make valid: unparseable source, unresolved identifiers, broken protected
// composition, missing exports and unreachable contracted modules/extensions. Advisory checks,
// including entity/store mount integrity, are recorded and do not stop a runnable candidate.

import { parse } from "@babel/parser";
import path from "node:path";

import { operationUsesDurablePersistence } from "../../../shared/implementationContract.mjs";
import { indexTree } from "./indexer.mjs";
import { memoryGraph } from "./graphStore.mjs";
import { scaffoldCompositionPlan, scaffoldCompositionPlanFor, validateScaffoldComposition,
  SCAFFOLD_MANIFEST_PATH } from "./scaffoldComposer.mjs";
import { journeySurfaceContext, reachableSourcePaths } from "./surfaceIntegration.mjs";
import { partitionFindings } from "./validationSeverity.mjs";

const SOURCE = /^src\/.*\.(?:jsx?|tsx?|mjs|cjs)$/;
const ENTRY = /^src\/(?:main|index|App)\.(?:jsx?|tsx?)$/;
// Platform infrastructure is never judged as generated application source. WP3+ added the module
// runtime (src/lib/modules) and the composed public facade (src/lib/app) to that infrastructure:
// they are protected, qualified by their own module suites, and shipped identically to every
// application, so gating them here would report the platform's own code as an application defect.
const PLATFORM = /^src\/lib\/(?:backend\/|capabilities\/|modules\/|app\/|scaffolds\/composed\/|visitorSession\.js$|assets\.js$|assetData\.js$)/;
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

/**
 * A generated file that references `React.` (React.useState, React.useMemo) without binding React
 * is corrected deterministically: `import React from "react";` is inserted, after a leading
 * directive when there is one. The recessed-light rerun (675d2a73) spent correction calls on
 * exactly this defect three times in one screen. The same scope analysis that reports
 * undefined_identifier decides the rewrite, so a bound React (default, namespace or local) is
 * never touched, platform files are never touched, and the rewrite is idempotent.
 */
export function rewriteMissingReactImports(tree = {}) {
  const rewrites = [];
  const next = { ...tree };
  for (const [path, source] of Object.entries(tree)) {
    if (!SOURCE.test(path) || PLATFORM.test(path) || typeof source !== "string") continue;
    if (!/\bReact\s*\./.test(source)) continue;
    const result = undefinedInSource(source, path);
    if (result.parseError) continue;
    const lines = result.identifiers.filter((row) => row.name === "React").map((row) => row.line);
    if (!lines.length) continue;
    const directive = source.match(/^(\s*(?:['"]use [a-z]+['"];?\s*\n))/);
    const head = directive ? directive[1] : "";
    next[path] = `${head}import React from "react";\n${source.slice(head.length)}`;
    rewrites.push({ file: path, rewrite: "react_default_import", lines });
  }
  return { tree: next, rewrites };
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

const FACADE_CALLS = new Set(["entityStore", "repository", "useEntityMutation"]);
const STORE_MAPS = new Set(["entityStores", "repositories"]);
const COMPOSED_ENTITIES_PATH = "src/lib/capabilities/composed/entities.js";
const COMPOSED_CRUD_PATH = "src/lib/capabilities/composed/crud.js";

function literalString(node) {
  if (!node) return null;
  if (node.type === "StringLiteral" || (node.type === "Literal" && typeof node.value === "string")) return node.value;
  if (node.type === "TemplateLiteral" && (node.expressions || []).length === 0) {
    return node.quasis?.[0]?.value?.cooked ?? "";
  }
  return null;
}

function unwrapFreeze(node) {
  if (["CallExpression", "OptionalCallExpression"].includes(node?.type)
      && ["MemberExpression", "OptionalMemberExpression"].includes(node.callee?.type)
      && !node.callee.computed
      && node.callee.object?.type === "Identifier" && node.callee.object.name === "Object"
      && node.callee.property?.name === "freeze") {
    return node.arguments?.[0] || null;
  }
  return node;
}

function propertyName(property) {
  if (!property || (property.type !== "ObjectProperty" && property.type !== "ObjectMethod")) return null;
  if (!property.computed && property.key?.type === "Identifier") return property.key.name;
  return literalString(property.key);
}

/** Entity names declared by the composed schema (`entityDefinitions`) or legacy `entityStores` map. */
function composedEntityNames(tree) {
  const names = new Set();
  const take = (file, binding, extract) => {
    const source = tree?.[file];
    if (typeof source !== "string") return;
    const ast = parseSource(source, file);
    if (!ast) return;
    const visit = (node) => {
      if (!node || typeof node.type !== "string") return;
      if (node.type === "VariableDeclarator" && node.id?.type === "Identifier" && node.id.name === binding) {
        for (const name of extract(node.init)) if (name) names.add(name);
      }
      for (const [, child] of childrenOf(node)) visit(child);
    };
    visit(ast.program);
  };
  take(COMPOSED_ENTITIES_PATH, "entityDefinitions", (init) => {
    const array = unwrapFreeze(init);
    if (array?.type !== "ArrayExpression") return [];
    return (array.elements || []).map((element) => {
      if (element?.type !== "ObjectExpression") return null;
      const name = element.properties?.map(propertyName).includes("name")
        ? literalString(element.properties.find((property) => propertyName(property) === "name")?.value)
        : null;
      return name;
    });
  });
  take(COMPOSED_CRUD_PATH, "entityStores", (init) => {
    const object = unwrapFreeze(init);
    if (object?.type !== "ObjectExpression") return [];
    return (object.properties || []).map(propertyName);
  });
  return names;
}

function durableOperationEntities(contract) {
  const platformNames = new Set((contract?.entities || [])
    .filter((entity) => entity?.platform)
    .map((entity) => entity.name)
    .filter(Boolean));
  const names = [];
  for (const operation of contract?.operations || []) {
    const entity = typeof operation?.entity === "string" ? operation.entity : "";
    if (!entity || platformNames.has(entity)) continue;
    if (!operationUsesDurablePersistence(contract, operation)) continue;
    names.push(entity);
  }
  return unique(names).sort();
}

function stringConstants(ast) {
  const counts = new Map();
  const values = new Map();
  const visit = (node) => {
    if (!node || typeof node.type !== "string") return;
    if (node.type === "VariableDeclarator" && node.id?.type === "Identifier") {
      const value = literalString(node.init);
      if (value !== null) {
        counts.set(node.id.name, (counts.get(node.id.name) || 0) + 1);
        values.set(node.id.name, value);
      }
    }
    for (const [, child] of childrenOf(node)) visit(child);
  };
  visit(ast);
  const constants = new Map();
  for (const [name, count] of counts) if (count === 1) constants.set(name, values.get(name));
  return constants;
}

function argumentEntity(node, constants) {
  const literal = literalString(node);
  if (literal !== null) return literal;
  if (node?.type === "Identifier" && constants.has(node.name)) return constants.get(node.name);
  return null;
}

function facadeLocals(ast) {
  const locals = new Map();
  for (const name of FACADE_CALLS) locals.set(name, name);
  locals.set("db", "db");
  for (const statement of ast.program?.body || []) {
    if (statement.type !== "ImportDeclaration") continue;
    for (const specifier of statement.specifiers || []) {
      if (specifier.type !== "ImportSpecifier") continue;
      const imported = specifier.imported?.name || specifier.imported?.value;
      if (FACADE_CALLS.has(imported) || imported === "db") locals.set(specifier.local.name, imported);
    }
  }
  return locals;
}

function facadeCallee(callee, locals) {
  if (!callee) return null;
  if (callee.type === "Identifier" && FACADE_CALLS.has(locals.get(callee.name))) return locals.get(callee.name);
  if (["MemberExpression", "OptionalMemberExpression"].includes(callee.type) && !callee.computed) {
    const property = callee.property?.name || null;
    if (FACADE_CALLS.has(property)) return property;
    if (property === "entity") {
      const object = callee.object;
      if (object?.type === "Identifier" && (locals.get(object.name) === "db" || object.name === "db")) return "db.entity";
      if (["MemberExpression", "OptionalMemberExpression"].includes(object?.type)
          && !object.computed && object.property?.name === "db") return "db.entity";
    }
  }
  return null;
}

/**
 * Every facade call a module makes with a statically known entity name: which facade
 * (entityStore, db.entity, repository, useEntityMutation, or a store-map lookup) and where.
 */
function entityFacadeCallSites(source, file) {
  const ast = parseSource(source, file);
  if (!ast) return [];
  const constants = stringConstants(ast);
  const locals = facadeLocals(ast);
  const found = [];
  const visit = (node) => {
    if (!node || typeof node.type !== "string") return;
    if (["CallExpression", "OptionalCallExpression"].includes(node.type)) {
      const facade = facadeCallee(node.callee, locals);
      if (facade) {
        const entity = argumentEntity(node.arguments?.[0], constants);
        if (entity) found.push({ facade, entity, line: node.loc?.start?.line || null });
      }
    }
    if (["MemberExpression", "OptionalMemberExpression"].includes(node.type)
        && node.object?.type === "Identifier" && STORE_MAPS.has(node.object.name)) {
      const key = node.computed
        ? argumentEntity(node.property, constants)
        : node.property?.name || null;
      if (key) found.push({ facade: node.object.name, entity: key, line: node.loc?.start?.line || null });
    }
    for (const [, child] of childrenOf(node)) visit(child);
  };
  visit(ast.program);
  return found;
}

/** Entity names a module passes to entityStore / db.entity / repository / useEntityMutation. */
function entityFacadeCalls(source, file) {
  return entityFacadeCallSites(source, file).map((site) => site.entity);
}

/**
 * `entityStore("X")` calls whose X has no composed store.
 *
 * The composed `entityStore()` resolves only entities the capability graph kept (those used by
 * durable operations). Asked for any other name it used to throw while the importing module was
 * being evaluated, which blanked the whole page (a calculator that stored its transient result in
 * `entityStore("layoutCalculation")` never mounted). The composed store now falls back to an
 * in-memory store instead, so a call can no longer crash the page, but it can still silently lose
 * data. Two different findings follow from that:
 *
 *   - a name that is NOT in the contract at all (a typo, a case slip such as "Project" for
 *     "project", an invented entity) is blocking `entity_store_call_unresolved`: the call can only
 *     ever reach a throwaway store, and catching it before compile costs no browser run;
 *   - a name the contract DOES declare but the platform composed no store for (transient or
 *     not-owned entities) is advisory `entity_store_call_transient`: it works, but the value is
 *     page-lifetime only and component state is the honest way to hold it.
 *
 * Only runs against a tree that carries the composed crud module; legacy trees are untouched.
 */
export function lintUnresolvedEntityStoreCalls(tree = {}, contract = null) {
  if (typeof tree?.[COMPOSED_CRUD_PATH] !== "string") return [];
  const composed = composedEntityNames(tree);
  const declared = new Set((contract?.entities || []).map((entity) => entity?.name).filter(Boolean));
  const findings = [];
  for (const file of Object.keys(tree).sort()) {
    if (!SOURCE.test(file) || PLATFORM.test(file) || typeof tree[file] !== "string") continue;
    if (!/\bentityStore\b/.test(tree[file])) continue;
    for (const site of entityFacadeCallSites(tree[file], file)) {
      if (site.facade !== "entityStore" || composed.has(site.entity)) continue;
      const where = `${file}${site.line ? `:${site.line}` : ""}`;
      if (declared.has(site.entity)) {
        findings.push({
          code: "entity_store_call_transient", file, line: site.line, entity: site.entity,
          message: `${where}: entityStore(${JSON.stringify(site.entity)}): this entity is declared in the contract `
            + "but has no platform store (it is transient or not durable), so the call gets a throwaway in-memory store. "
            + "Keep transient values in component state (useState) instead.",
        });
      } else {
        const near = [...composed, ...declared].find((name) => name.toLowerCase() === site.entity.toLowerCase());
        findings.push({
          code: "entity_store_call_unresolved", file, line: site.line, entity: site.entity,
          message: `${where}: entityStore(${JSON.stringify(site.entity)}): no entity with this name is composed `
            + `or declared in the contract${near ? ` (did you mean ${JSON.stringify(near)}?)` : ""}, so the call can only reach a throwaway in-memory store `
            + "and its data is lost on reload. Use a declared entity name, or keep transient values in component state (useState).",
        });
      }
    }
  }
  return findings;
}

/**
 * Advisory mount check for every durable entity.
 *
 * The entity must be declared in the composed schema or `entityStores`, and some module the
 * running application can load (`reachableSourcePaths`) must call its facade or store:
 * `entityStore`, `db.entity`, `repository`, or `useEntityMutation`. Platform-owned entities
 * (accounts, identity, authorization, admin) and transient storage never enter this set.
 * Findings stay advisory until the false-rejection corpus reports none of them.
 */
export function lintEntityStoreIntegrity(tree = {}, contract = null) {
  const entities = durableOperationEntities(contract);
  if (!entities.length) return [];
  const composed = composedEntityNames(tree);
  const reachable = reachableSourcePaths(tree);
  const called = new Set();
  for (const file of reachable) {
    if (typeof tree?.[file] !== "string") continue;
    for (const name of entityFacadeCalls(tree[file], file)) called.add(name);
  }
  const findings = [];
  for (const entity of entities) {
    const inComposition = composed.has(entity);
    const mounted = called.has(entity);
    if (inComposition && mounted) continue;
    const gaps = [
      !inComposition ? "it does not appear in the composed schema or entityStores" : null,
      !mounted ? "no module reachable from the application entry calls entityStore, db.entity, repository, or useEntityMutation for it" : null,
    ].filter(Boolean);
    findings.push({
      code: "entity_store_unmounted",
      entity,
      composed: inComposition,
      reachableCall: mounted,
      message: `durable entity ${JSON.stringify(entity)} is not mounted: ${gaps.join("; ")}`,
    });
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
  const composition = validateScaffoldComposition(tree, scaffoldGraph, scaffoldCompositionPlanFor(tree, scaffoldGraph), {
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

  const integrity = lintEntityStoreIntegrity(tree, contract);
  const integrityVerdict = partitionFindings(integrity);
  advisory.push(...integrityVerdict.advisory);
  blocking.push(...integrityVerdict.blocking);
  checks.push({ name: "entity_store_integrity", ok: integrity.length === 0,
    detail: integrity.map((finding) => finding.message) });

  const unresolvedStores = lintUnresolvedEntityStoreCalls(tree, contract);
  const unresolvedVerdict = partitionFindings(unresolvedStores);
  advisory.push(...unresolvedVerdict.advisory);
  blocking.push(...unresolvedVerdict.blocking);
  checks.push({ name: "entity_store_calls", ok: unresolvedVerdict.blocking.length === 0,
    detail: unresolvedStores.map((finding) => finding.message) });

  return { ok: blocking.length === 0, active: true, blocking, advisory, checks,
    mountedSurface: surface, reachable: [...reachable].sort() };
}
