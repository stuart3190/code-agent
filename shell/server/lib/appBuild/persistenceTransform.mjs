// Rewrite browser-only persistence into real database calls, deterministically.
//
// The first attempt at this rewrote whole modules and assumed a shape: one string-literal storage
// key, conventionally-named exports, nothing else in the file. It declined every module it met in
// production. The real ones use constant or computed keys, reach storage through `window.`, mix
// persistence with validation and sorting, and — in one case — already use the real store for
// signed-in users with browser storage as a guest fallback inside a ternary.
//
// So this works at CALL SITES, not modules. Each storage expression is examined on its own,
// mapped to a db.entity() operation if and only if the mapping is provable from the surrounding
// syntax, and rewritten in place. Everything else in the file — validation, reference generation,
// sorting, the signed-in path — is left exactly as it was.
//
// The governing rule is unchanged from the import preflight: it must never silently produce
// guessed code. An expression it cannot prove is left alone and reported, and a module with any
// unmapped expression is handed to targeted AI repair rather than half-transformed.

// Every way a generated app reaches browser storage, including through `window.` and common
// aliases. Detection is broad; the TRANSFORM is what stays narrow.
const STORE_ACCESS = String.raw`(?:window\s*\.\s*|globalThis\s*\.\s*)?(?:localStorage|sessionStorage)`;

const READ_PATTERNS = [
  // JSON.parse(<store>.getItem(<key>) || "[]")  — the list read, with or without a fallback
  {
    id: "json_list_read",
    regex: new RegExp(String.raw`JSON\s*\.\s*parse\s*\(\s*${STORE_ACCESS}\s*\.\s*getItem\s*\([^)]*\)\s*(?:\|\|\s*(?:"\[\]"|'\[\]'|` + "`\\[\\]`" + String.raw`)\s*)?\)`, "g"),
    replace: (entity) => `await db.entity("${entity}").list()`,
  },
];

const WRITE_PATTERNS = [
  // <store>.setItem(<key>, JSON.stringify([...<list>, <item>]))  — an append. The new record is
  // the thing being created, and the spread of the existing list is what the database already has.
  {
    id: "append_write",
    regex: new RegExp(String.raw`${STORE_ACCESS}\s*\.\s*setItem\s*\([^,]+,\s*JSON\s*\.\s*stringify\s*\(\s*\[\s*\.\.\.\s*[\w$.]+\s*,\s*([\w$.]+)\s*\]\s*\)\s*\)`, "g"),
    replace: (entity, match) => `await db.entity("${entity}").create(${match[1]})`,
  },
  // <store>.setItem(<key>, JSON.stringify(<listVar>)) immediately after <listVar>.push(<item>).
  // The pair is an append written across two statements; the push is what carries the intent.
  {
    id: "push_then_write",
    regex: new RegExp(String.raw`([\w$]+)\s*\.\s*push\s*\(\s*([\w$]+)\s*\)\s*;?\s*\n?\s*${STORE_ACCESS}\s*\.\s*setItem\s*\([^,]+,\s*JSON\s*\.\s*stringify\s*\(\s*\1\s*\)\s*\)\s*;?`, "g"),
    replace: (entity, match) => `await db.entity("${entity}").create(${match[2]});`,
  },
];

// A ternary whose false branch is browser storage and whose true branch is already the real store:
//   store ? await store.list(...) : JSON.parse(localStorage.getItem(k) || "[]")
// The correct fix is to keep the real branch and drop the fallback, NOT to rewrite both.
// The true branch is matched lazily up to the ` : JSON.parse(` that starts the fallback, rather
// than "anything without a colon" — a first version used [^:]+? and broke on the perfectly ordinary
// `await store.list({ limit: 500 })`, whose object literal contains a colon.
const HYBRID_TERNARY = new RegExp(
  String.raw`([\w$]+)\s*\?\s*((?:await\s+)?[^;]*?)\s*:\s*JSON\s*\.\s*parse\s*\(\s*${STORE_ACCESS}\s*\.\s*getItem\s*\([^)]*\)[^)]*\)`,
  "g",
);

// A guarded guest fallback written as a statement after an early return:
//   if (store) return store.create(x);
//   localStorage.setItem(key, JSON.stringify([...list, x]));
// Once the fallback becomes a real create, the guard is redundant — but removing the guard is a
// judgement call, so the fallback is rewritten and the guard left in place. The result is correct
// either way: both branches now write to the database.

/** Does this file touch browser storage at all? */
export function usesBrowserStorage(source) {
  return new RegExp(String.raw`${STORE_ACCESS}\s*\.\s*(?:getItem|setItem|removeItem)|indexedDB\s*\.`, "").test(String(source || ""));
}

/**
 * Is this storage use about application DATA, or about the browser?
 *
 * Theme, locale, "has seen the tour", scroll position and consent flags are legitimately per-device
 * and must not be moved into the database. Judged from the key text and the module path.
 */
export function isDevicePreference(source, path = "") {
  const text = `${source} ${path}`.toLowerCase();
  const dataish = /reservation|booking|order|subscription|customer|record|entity|profile|cart|message|post/.test(text);
  const prefish = /theme|locale|language|dismiss|seen|tour|onboard|consent|cookie|sidebar|collapsed|scroll|draft/.test(text);
  return prefish && !dataish;
}

/**
 * Transform one module.
 *
 * Returns `{ ok, source, applied, declined }`. `ok` is true only when NO browser storage remains:
 * a partial transform is a decline, because leaving one call behind is the same defect with fewer
 * findings, which is exactly the substitution failure this whole line of work exists to prevent.
 */
export function transformModule(source, { entity, path = "" } = {}) {
  const original = String(source || "");
  if (!entity) return { ok: false, source: original, applied: [], declined: ["no contract entity maps to this module"] };
  if (isDevicePreference(original, path)) {
    return { ok: false, source: original, applied: [], declined: ["this is a device preference, not application data — it belongs in the browser"] };
  }

  let working = original;
  const applied = [];

  // Hybrid ternaries first: they contain a read pattern, and rewriting the read in place would
  // leave `store ? await store.list() : await db.entity(...).list()` — correct but absurd.
  working = working.replace(HYBRID_TERNARY, (whole, guard, realBranch) => {
    applied.push("hybrid_ternary");
    return realBranch.trim();
  });

  for (const pattern of [...WRITE_PATTERNS, ...READ_PATTERNS]) {
    working = working.replace(pattern.regex, (...args) => {
      const match = args.slice(0, -2);
      applied.push(pattern.id);
      return pattern.replace(entity, match);
    });
  }

  // Anything left is something this transform could not prove. Report it and decline the module.
  if (usesBrowserStorage(working)) {
    const remaining = working.split("\n")
      .map((line, i) => ({ line: i + 1, text: line.trim() }))
      .filter((l) => usesBrowserStorage(l.text))
      .map((l) => `${path}:${l.line} ${l.text.slice(0, 100)}`);
    return { ok: false, source: original, applied, declined: remaining };
  }
  if (!applied.length) {
    return { ok: false, source: original, applied, declined: ["no storage expression matched a provable mapping"] };
  }

  // The db import the rewritten calls need, if the module does not already have one.
  if (!/from\s+["'][^"']*lib\/backend["']/.test(working)) {
    const depth = (path.match(/\//g) || []).length - 1;
    const prefix = depth > 0 ? "../".repeat(depth) : "./";
    working = `import { db } from "${prefix}lib/backend";\n${working}`;
  }

  // A rewritten call is awaited, so its function must be async. Only the functions that gained an
  // await are touched.
  // `async` is only ADDED, never doubled: most generated data functions are already async, and an
  // earlier version emitted `export async async function`, which does not parse.
  working = working.replace(/(\n?\s*)(export\s+)?(async\s+)?function\s+(\w+)\s*\(([^)]*)\)\s*\{/g,
    (whole, space, exp, alreadyAsync, name, params) => {
      if (alreadyAsync) return whole;
      const body = bodyOf(working, whole);
      if (!body || !/\bawait\b/.test(body)) return whole;
      return `${space}${exp || ""}async function ${name}(${params}) {`;
    });

  return { ok: true, source: working, applied, declined: [] };
}

// The text of a function body, for deciding whether it needs `async`. Brace-counting rather than a
// parser: the input is generated code with balanced braces, and an AST toolchain to answer one
// question about a handful of files is not worth the dependency.
function bodyOf(source, header) {
  const start = source.indexOf(header);
  if (start === -1) return null;
  let depth = 0;
  let i = source.indexOf("{", start);
  if (i === -1) return null;
  const from = i;
  for (; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(from, i + 1);
    }
  }
  return null;
}

/**
 * Transform every module the findings implicate.
 *
 * Returns the corrected tree plus, for each module, whether it was fixed for free or must go to
 * targeted AI repair — and if so, exactly which expressions defeated the transform, so the model
 * gets the reason rather than the whole file.
 */
export function transformPersistence(tree, { findings = [], contract = null } = {}) {
  const working = { ...tree };
  const entities = contract?.entities || [];
  const fixed = [];
  const declined = [];

  const files = [...new Set(findings.filter((f) => f.id === "fake_persistence" && f.file).map((f) => f.file))];
  for (const file of files) {
    const source = working[file];
    if (!source) continue;

    // Which entity is this module about? Its path first, then its content, then — only when the
    // app has exactly one entity — that one.
    const entity = entities.find((e) => file.toLowerCase().includes(String(e.name).toLowerCase()))
      || entities.find((e) => new RegExp(`\\b${e.name}\\b`, "i").test(source))
      || (entities.length === 1 ? entities[0] : null);

    const result = transformModule(source, { entity: entity?.name, path: file });
    if (result.ok) {
      working[file] = result.source;
      fixed.push({ file, entity: entity?.name, applied: result.applied });
    } else {
      declined.push({ file, reasons: result.declined, partial: result.applied });
    }
  }

  return { tree: working, fixed, declined };
}

export function transformSummary({ fixed, declined }) {
  const parts = [];
  if (fixed.length) parts.push(`rewrote ${fixed.length} module(s) with no model call: ${fixed.map((f) => `${f.file} → db.entity("${f.entity}")`).join(", ")}`);
  if (declined.length) parts.push(`declined ${declined.length}: ${declined.map((d) => `${d.file} (${d.reasons[0]})`).join("; ")}`);
  return parts.join(" · ") || "nothing to transform";
}
