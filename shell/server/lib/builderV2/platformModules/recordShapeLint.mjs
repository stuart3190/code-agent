// Record-shape wrapper lint (WP5).
//
// With the typed entities module installed, a generated application reads and writes
// `{ id, version, createdAt, updatedAt, values }` records through the composed repositories and
// never re-derives shape from raw backend rows. Generated code that spreads `row.data`, reads
// `created_at`, or rebuilds `{ id: row.id, ...row.data }` is the identity/shape wrapper the audit
// lists among repeatable generated work; on a tree that ships the typed module it is reported
// (advisory — the browser decides whether the surface still works) so repair can replace it with
// the module's record shape instead of patching the wrapper.

import { isProtectedPath } from "../patchEngine.mjs";

export const RECORD_SHAPE_LINT_VERSION = 1;
export const ENTITIES_COMPOSED_MARKER = "src/lib/capabilities/composed/entities.js";

const GENERATED_SOURCE = /^src\/.*\.(?:jsx?|tsx?)$/;
const WRAPPER_PATTERNS = Object.freeze([
  { pattern: /\.\.\.\s*[A-Za-z_$][\w$]*\.data\b/, why: "spreads a raw row's data" },
  { pattern: /\b[A-Za-z_$][\w$]*\.created_at\b/, why: "reads a raw row's created_at" },
  { pattern: /\bid:\s*[A-Za-z_$][\w$]*\.id\s*,\s*\.\.\./, why: "rebuilds a record from a raw row" },
  { pattern: /\b[A-Za-z_$][\w$]*\.data\s*\|\|\s*\{\}/, why: "guards a raw row's data" },
]);

export function lintRecordShapeWrappers(tree, { installed = null } = {}) {
  const findings = [];
  const typed = installed ?? typeof tree?.[ENTITIES_COMPOSED_MARKER] === "string";
  if (!typed) return { version: RECORD_SHAPE_LINT_VERSION, installed: false, findings };
  for (const [file, source] of Object.entries(tree || {})) {
    if (!GENERATED_SOURCE.test(file) || isProtectedPath(file, { tree }) || typeof source !== "string") continue;
    for (const { pattern, why } of WRAPPER_PATTERNS) {
      const match = pattern.exec(source);
      if (!match) continue;
      findings.push({
        code: "generated_record_shape_wrapper", file, module: file,
        line: source.slice(0, match.index).split("\n").length, forbidden: true,
        message: `${file} ${why} (${match[0].trim()}); the entities module owns record shape — read repository(\"<entity>\").get()/list() records ({ id, version, values }) instead`,
      });
      break;
    }
  }
  return { version: RECORD_SHAPE_LINT_VERSION, installed: true, findings };
}
