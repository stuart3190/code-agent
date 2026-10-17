// Public-ABI lint (audit §6.2, §14 "checks after generation"; WP3).
//
// Generated application code imports the public facade and the composed capability surface. It
// must not import backend implementation files, the visitor-session internals or private module
// paths, and once the identity module is installed it must not orchestrate the session itself.
//
// On a LOCKED tree (one the composer built with a module lock) a private import blocks: the ABI
// is the boundary the lock certifies. On a legacy tree the same finding is advisory, because the
// retained candidates and any snapshot that predates the lock were generated before the rule
// existed and must keep judging exactly as they did.

import path from "node:path";
import { parse } from "@babel/parser";
import { isProtectedPath } from "../patchEngine.mjs";

export const ABI_LINT_VERSION = 1;

export const PRIVATE_PLATFORM_IMPORT = /^src\/lib\/(?:backend(?:\/|$)|visitorSession(?:\.js)?$|modules\/)/;
// Module internals were never a taught surface: importing them blocks on a locked tree now. The
// backend SDK and the visitor session are still what the generation prompt teaches today
// ("import { auth, db } from ./lib/backend"), so until WP14 re-teaches the public facade they are
// reported, not enforced — flipping `backend` to "block" is that package's job, recorded here.
export const ABI_ENFORCEMENT = Object.freeze({ modules: "block", backend: "warn", visitorSession: "warn" });
const PRIVATE_MODULE_IMPORT = /^src\/lib\/modules\//;
const GENERATED_SOURCE = /^src\/.*\.(?:jsx?|tsx?)$/;
const IMPORT_SPECIFIER = /(?:\bimport\s+(?:[^"'`;]*?\s+from\s*)?|\bexport\s+(?:\*|\{[^}]*\})\s*from\s*|\bimport\s*\(\s*)["']([^"'`]+)["']/g;
const SESSION_ORCHESTRATION = /\bauth\.(?:signIn|signUp|signOut|currentUser|resetPassword|confirmReset)\s*\(|\bensureVisitorSession\s*\(/;
// A destination that still carries a ":param" segment: to=/href=/navigate( with a literal path.
const LITERAL_ROUTE_PARAM = /(?:\b(?:to|href)\s*=\s*|\bnavigate\s*\(\s*)["'](\/[^"'`]*?\/:([A-Za-z_$][\w$]*)[^"'`]*)["']/g;

function resolveRelative(from, specifier) {
  if (!specifier.startsWith(".")) return null;
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
  return resolved.replace(/^\.\//, "");
}

function lineOf(source, index) {
  return source.slice(0, index).split("\n").length;
}

// Only diagnose imported platform Links with literal path props. Unknown components,
// dynamic destinations and locally shadowed names remain the browser's responsibility.
function linkPathFindings(source, file, staticPaths = new Set()) {
  let ast;
  try { ast = parse(source, { sourceType: "module", plugins: ["jsx", ...(/\.tsx?$/.test(file) ? ["typescript"] : [])] }); }
  catch { return []; }
  const nodes = [];
  const visit = node => {
    if (!node || typeof node.type !== "string") return;
    nodes.push(node);
    for (const [key, value] of Object.entries(node)) {
      if (["loc", "comments", "tokens", "extra"].includes(key)) continue;
      if (Array.isArray(value)) value.forEach(visit); else if (value && typeof value === "object") visit(value);
    }
  };
  visit(ast);
  const imported = new Set();
  for (const node of ast.program.body) {
    if (node.type !== "ImportDeclaration") continue;
    const target = resolveRelative(file, node.source.value);
    if (!/^src\/lib\/app(?:\/(?:index|routing)(?:\.js)?)?$/.test(target || "")) continue;
    for (const spec of node.specifiers) if (spec.imported?.name === "Link") imported.add(spec.local.name);
  }
  // Conservatively abstain for any local binding that could shadow this import.
  const bound = node => {
    if (!node) return;
    if (node.type === "Identifier") imported.delete(node.name);
    else if (node.type === "AssignmentPattern") bound(node.left);
    else if (node.type === "RestElement") bound(node.argument);
    else if (node.type === "ObjectPattern") for (const p of node.properties) bound(p.value || p.argument);
    else if (node.type === "ArrayPattern") node.elements.forEach(bound);
  };
  for (const node of nodes) {
    if (/Function/.test(node.type)) (node.params || []).forEach(bound);
    if (node.type === "VariableDeclarator" || node.type === "ClassDeclaration" || node.type === "FunctionDeclaration") bound(node.id);
    if (node.type === "CatchClause") bound(node.param);
  }
  const findings = [];
  for (const node of nodes) {
    if (node.type !== "JSXOpeningElement" || !imported.has(node.name?.name)) continue;
    const attr = node.attributes.find(a => a.type === "JSXAttribute" && a.name?.name === "to");
    const value = attr?.value?.type === "StringLiteral" ? attr.value.value
      : attr?.value?.expression?.type === "StringLiteral" ? attr.value.expression.value : null;
    if (!value?.startsWith("/") || staticPaths.has(value)) continue;
    findings.push({ code: "platform_link_path", module: file, line: node.loc.start.line, target: value,
      message: `${file}:${node.loc.start.line} passes path "${value}" to the platform Link, but it is not a declared static path. Use a declared route ID with <Link to="routeId"> (and params for parameterised routes); an unknown path throws "no route" during render.` });
  }
  return findings;
}

function composedStaticPaths(tree) {
  try {
    const ast = parse(tree['src/lib/capabilities/composed/routes.js'] || '', { sourceType: 'module' });
    const declaration = ast.program.body.flatMap(n => n.declaration?.declarations || [])
      .find(n => n.id?.name === 'routeDefinitions');
    const entries = declaration?.init?.arguments?.[0]?.elements || [];
    return new Set(entries.map(n => n.properties?.find(p => (p.key?.name || p.key?.value) === 'path')?.value?.value)
      .filter(path => typeof path === 'string' && !/[:*]/.test(path)));
  } catch { return new Set(); }
}

/**
 * @param {Record<string,string>} tree
 * @param {{ locked?: boolean, identityInstalled?: boolean }} options
 */
export function lintPlatformAbi(tree, { locked = false, identityInstalled = null } = {}) {
  const findings = [];
  const staticPaths = composedStaticPaths(tree);
  const hasIdentity = identityInstalled ?? typeof tree?.["src/lib/capabilities/composed/identity.js"] === "string";
  for (const [file, source] of Object.entries(tree || {})) {
    if (!GENERATED_SOURCE.test(file) || isProtectedPath(file, { tree }) || typeof source !== "string") continue;
    if (typeof tree?.["src/lib/app/routing.js"] === "string") findings.push(...linkPathFindings(source, file, staticPaths));
    IMPORT_SPECIFIER.lastIndex = 0;
    let match;
    while ((match = IMPORT_SPECIFIER.exec(source))) {
      const target = resolveRelative(file, match[1]);
      if (!target) continue;
      const candidates = [target, `${target}.js`, `${target}/index.js`];
      if (!candidates.some((candidate) => PRIVATE_PLATFORM_IMPORT.test(candidate))) continue;
      const moduleInternal = candidates.some((candidate) => PRIVATE_MODULE_IMPORT.test(candidate));
      const enforcement = moduleInternal ? ABI_ENFORCEMENT.modules : ABI_ENFORCEMENT.backend;
      findings.push({
        code: locked && enforcement === "block" ? "private_platform_import" : "private_platform_import_legacy",
        module: file, line: lineOf(source, match.index), forbidden: true,
        target: match[1],
        message: `${file} imports private platform path "${match[1]}"; generated code imports the public application facade (src/lib/app) or the composed capability surface only`,
      });
    }
    // WP6: a parameterised route is reachable only through routeHref(id, params) / <Link to={id}
    // params={…}>. A literal "/projects/:projectId" navigates to the pattern itself — the defect
    // the audit names in §10 — so it is reported wherever it appears as a destination.
    for (const match of source.matchAll(LITERAL_ROUTE_PARAM)) {
      findings.push({
        code: "route_parameter_literal", module: file, line: lineOf(source, match.index), forbidden: true,
        target: match[2],
        message: `${file} navigates to the literal route pattern "${match[2]}"; build the destination with routeHref("<routeId>", { … }) so the parameter is bound`,
      });
    }
    if (hasIdentity) {
      const orchestration = SESSION_ORCHESTRATION.exec(source);
      if (orchestration) {
        findings.push({
          code: "generated_session_orchestration",
          module: file, line: lineOf(source, orchestration.index), forbidden: true,
          message: `${file} orchestrates the session directly (${orchestration[0].trim()}); the identity module owns sign-in, recovery and sign-out — bind useSession()/useSignIn()/useSignOut() from the application facade`,
        });
      }
    }
  }
  return { version: ABI_LINT_VERSION, locked, identityInstalled: hasIdentity, findings };
}
