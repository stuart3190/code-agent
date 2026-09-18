// Query-binding lint (WP7; audit §14 "Query/filter bindings use declared fields").
//
// The query module refuses an undeclared field at runtime, which is the real boundary. This lint
// says the same thing BEFORE generation finishes, so a screen that filters on a field the schema
// never declared is named in the static verdict rather than discovered as an empty list in the
// browser. It reads the literal filter keys a screen passes to the collection bindings; anything
// dynamic is left to the runtime, because a lint that guesses is worse than one that abstains.

import { isProtectedPath } from "../patchEngine.mjs";
import { queryableFields } from "../../../../../src/scaffolds/reactVite/lib/modules/schema.js";

export const QUERY_LINT_VERSION = 1;

const GENERATED_SOURCE = /^src\/.*\.(?:jsx?|tsx?)$/;
// useCollection("entity", …) names the entity a file's collection bindings act on.
const COLLECTION_BINDING = /\buseCollection\s*\(\s*["']([A-Za-z_$][\w$]*)["']/g;
// The two shapes a filter set arrives in: `filters: { … }` and `.filter({ … })`.
const FILTER_SITE = /\bfilters\s*:\s*\{|\.\s*filter\s*\(\s*\{/g;
const FIELD_KEY = /^\s*(?:["']([A-Za-z_$][\w$.]*)["']|([A-Za-z_$][\w$]*))\s*:/;

const lineOf = (source, index) => source.slice(0, index).split("\n").length;

/** The balanced object body starting at the `{` at `open`, or null when it never closes. */
function balancedObject(source, open) {
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const character = source[index];
    if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, index);
    }
  }
  return null;
}

/**
 * The literal keys at the TOP level of an object body. Nested operator objects
 * (`{ ilike: "%x%" }`) are skipped rather than mistaken for fields, and a computed or spread key
 * is ignored — a lint that guesses is worse than one that abstains.
 */
function literalFieldKeys(body) {
  const keys = [];
  let depth = 0;
  let index = 0;
  let expectKey = true;
  while (index < body.length) {
    const character = body[index];
    if (character === "{" || character === "[" || character === "(") { depth += 1; index += 1; continue; }
    if (character === "}" || character === "]" || character === ")") { depth -= 1; index += 1; continue; }
    if (character === "," && depth === 0) { expectKey = true; index += 1; continue; }
    if (depth === 0 && expectKey && !/\s/.test(character)) {
      const match = FIELD_KEY.exec(body.slice(index));
      if (match) {
        keys.push(match[1] || match[2]);
        index += match[0].length;
        expectKey = false;
        continue;
      }
      expectKey = false;
    }
    index += 1;
  }
  return keys;
}

/**
 * @param {Record<string,string>} tree
 * @param {{ entitySchema?: object }} options compiled entity schema (platformModules/schema.mjs)
 */
export function lintQueryBindings(tree, { entitySchema = null } = {}) {
  const findings = [];
  const schema = entitySchema?.schema || null;
  if (!schema) return { version: QUERY_LINT_VERSION, findings };
  for (const [file, source] of Object.entries(tree || {})) {
    if (!GENERATED_SOURCE.test(file) || isProtectedPath(file, { tree }) || typeof source !== "string") continue;
    // The entity a screen's collection binding names. With exactly one, every filter block in the
    // file is attributable to it; with several, the attribution would be a guess, so we abstain.
    COLLECTION_BINDING.lastIndex = 0;
    const entities = [...new Set([...source.matchAll(COLLECTION_BINDING)].map((match) => match[1]))];
    if (entities.length !== 1) continue;
    const entity = entities[0];
    const allowed = queryableFields(schema, entity);
    if (!Object.keys(allowed).length) continue;
    FILTER_SITE.lastIndex = 0;
    const seen = new Set();
    for (const site of source.matchAll(FILTER_SITE)) {
      const open = source.indexOf("{", site.index + site[0].length - 1);
      const body = open === -1 ? null : balancedObject(source, open);
      if (body === null) continue;
      for (const field of literalFieldKeys(body)) {
        if (allowed[field] || seen.has(field)) continue;
        seen.add(field);
        findings.push({
          code: "query_field_not_declared", module: file, file, entity, field,
          line: lineOf(source, site.index), forbidden: true,
          message: `${file} filters ${entity} on "${field}", which is not a queryable field of ${entity} (${Object.keys(allowed).join(", ")}); the query module refuses it at runtime`,
        });
      }
    }
  }
  return { version: QUERY_LINT_VERSION, findings };
}
