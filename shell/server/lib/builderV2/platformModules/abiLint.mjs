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

function resolveRelative(from, specifier) {
  if (!specifier.startsWith(".")) return null;
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
  return resolved.replace(/^\.\//, "");
}

function lineOf(source, index) {
  return source.slice(0, index).split("\n").length;
}

/**
 * @param {Record<string,string>} tree
 * @param {{ locked?: boolean, identityInstalled?: boolean }} options
 */
export function lintPlatformAbi(tree, { locked = false, identityInstalled = null } = {}) {
  const findings = [];
  const hasIdentity = identityInstalled ?? typeof tree?.["src/lib/capabilities/composed/identity.js"] === "string";
  for (const [file, source] of Object.entries(tree || {})) {
    if (!GENERATED_SOURCE.test(file) || isProtectedPath(file, { tree }) || typeof source !== "string") continue;
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
