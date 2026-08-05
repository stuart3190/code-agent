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

import { findSessionBootstrapFunction } from "./honestyScan.mjs";
import { REACT_VITE } from "../../../../src/scaffolds/reactVite.mjs";

// Every way a generated app reaches browser storage, including through `window.` and common
// aliases. Detection is broad; the TRANSFORM is what stays narrow.
const STORE_ACCESS = String.raw`(?:window\s*\.\s*|globalThis\s*\.\s*)?(?:localStorage|sessionStorage)`;

const READ_PATTERNS = [
  // JSON.parse(<store>.getItem(<key>) || "[]")  — the list read, with or without a fallback
  {
    id: "json_list_read",
    regex: new RegExp(String.raw`JSON\s*\.\s*parse\s*\(\s*${STORE_ACCESS}\s*\.\s*getItem\s*\([^)]*\)\s*(?:(?:\|\||\?\?)\s*(?:"\[\]"|'\[\]'|` + "`\\[\\]`" + String.raw`)\s*)?\)`, "g"),
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

// SHAPE A from run f4c1c00c: the lazy React state initialiser with try/catch —
//
//   useState(() => { try { return JSON.parse(localStorage.getItem(KEY)) || fb; } catch { return fb; } })
//
// The initialiser is a cross-refresh convenience CACHE of state the component also holds live. The
// provable mapping: the initial state becomes the fallback, and the paired same-key writes are
// removed, so the component's in-session behaviour is unchanged (first render = fallback either
// way) and the authoritative record lives in db.entity(). Requires the try-fallback and the
// catch-fallback to be textually identical — different fallbacks mean intent this cannot prove.
const LAZY_INIT_TRY = new RegExp(
  String.raw`useState\s*\(\s*\(\s*\)\s*=>\s*\{\s*try\s*\{\s*return\s+JSON\s*\.\s*parse\s*\(\s*${STORE_ACCESS}\s*\.\s*getItem\s*\(\s*([\w$]+|["'][^"']+["'])\s*\)\s*\)\s*(?:(?:\|\||\?\?)\s*([^;]+?))?\s*;\s*\}\s*catch\s*(?:\([^)]*\)\s*)?\{\s*return\s+([^;]+?)\s*;\s*\}\s*\}\s*\)`,
  "g",
);

// Storage reached inside a component rather than a data module: a hook body, a callback, an event
// handler, an inline expression in JSX. The latest production run put four of nine findings in
// App.jsx this way, and a module-shaped transform saw none of them.
const COMPONENT_PATTERNS = [
  // useState(JSON.parse(localStorage.getItem(k) || "[]")) — the initial-state read. It becomes an
  // empty initial state plus a load, because a database read cannot be synchronous.
  {
    id: "usestate_initialiser",
    regex: new RegExp(String.raw`useState\s*\(\s*(?:\(\s*\)\s*=>\s*)?JSON\s*\.\s*parse\s*\(\s*${STORE_ACCESS}\s*\.\s*getItem\s*\([^)]*\)\s*(?:\|\|\s*(?:"\[\]"|'\[\]')\s*)?\)\s*\)`, "g"),
    replace: () => "useState([])",
  },
  // A bare read inside a handler or effect.
  {
    id: "inline_read",
    regex: new RegExp(String.raw`JSON\s*\.\s*parse\s*\(\s*${STORE_ACCESS}\s*\.\s*getItem\s*\([^)]*\)\s*(?:\|\|\s*(?:"\[\]"|'\[\]')\s*)?\)`, "g"),
    replace: (entity) => `await db.entity("${entity}").list()`,
  },
  // A write inside a handler: setItem(k, JSON.stringify([...list, item])) or of a named record.
  {
    id: "inline_append",
    regex: new RegExp(String.raw`${STORE_ACCESS}\s*\.\s*setItem\s*\([^,]+,\s*JSON\s*\.\s*stringify\s*\(\s*\[\s*\.\.\.\s*[\w$.]+\s*,\s*([\w$.]+)\s*\]\s*\)\s*\)`, "g"),
    replace: (entity, match) => `await db.entity("${entity}").create(${match[1]})`,
  },
];

/** Does this file touch browser storage at all? */
export function usesBrowserStorage(source) {
  return new RegExp(String.raw`${STORE_ACCESS}\s*\.\s*(?:getItem|setItem|removeItem)|indexedDB\s*\.`, "").test(String(source || ""));
}

/**
 * Is this a component rather than a data module?
 *
 * Components are transformed with the component patterns and, crucially, are NOT rewritten
 * wholesale — a component is mostly rendering, and only its storage expressions may move.
 */
export function looksLikeComponent(source, path = "") {
  return /\.(jsx|tsx)$/.test(path)
    || /\buseState\s*\(|\buseEffect\s*\(|return\s*\(?\s*</.test(String(source || ""));
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

  // SHAPE A: the lazy try/catch initialiser (run f4c1c00c, src/App.jsx:378). Replace the whole
  // initialiser with its fallback, and remove the same-key writes so no storage remains. The keys
  // it neutralises are collected so the statement sweep below knows which writes are paired.
  const neutralisedKeys = new Set();
  if (looksLikeComponent(original, path)) {
    working = working.replace(LAZY_INIT_TRY, (whole, key, tryFallback, catchFallback) => {
      const a = (tryFallback || "").trim();
      const b = (catchFallback || "").trim();
      const fallback = a || b;
      // Different fallbacks mean intent this transform cannot prove — leave it for the model.
      if (a && b && a !== b) return whole;
      applied.push("lazy_init_try");
      neutralisedKeys.add(key);
      return `useState(${fallback || "null"})`;
    });
    // The paired writes: whole statements that only mirror the neutralised state into storage.
    for (const key of neutralisedKeys) {
      const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      working = working.replace(
        new RegExp(String.raw`^\s*(?:window\s*\.\s*|globalThis\s*\.\s*)?(?:localStorage|sessionStorage)\s*\.\s*(?:setItem\s*\(\s*${escaped}\s*,[^;]*|removeItem\s*\(\s*${escaped}\s*\))\s*\)?\s*;\s*$`, "gm"),
        (statement) => {
          applied.push("paired_cache_write_removed");
          return statement.replace(/\S[\s\S]*$/, "// (browser cache removed — the record lives in the database)");
        },
      );
    }
  }

  // Component-local storage first: a useState initialiser must become an empty state before the
  // generic read pattern turns it into an `await` inside a synchronous initialiser, which does not
  // compile.
  if (looksLikeComponent(original, path)) {
    for (const pattern of COMPONENT_PATTERNS) {
      working = working.replace(pattern.regex, (...args) => {
        const match = args.slice(0, -2);
        applied.push(pattern.id);
        return pattern.replace(entity, match);
      });
    }
  }

  // SHAPE B (run f4c1c00c, src/data/reservations.js:46): a whole-value save helper —
  //
  //   function saveX(value) { localStorage.setItem(KEY, JSON.stringify(value)); }
  //
  // The helper itself has no provable mapping: "persist this whole list" is not a db.entity()
  // operation. Its CALLERS do. When every caller is an append ([...] spread, or push-then-save) or
  // a filter-by-property, each call site maps exactly — create(item), or list-and-delete-matching —
  // and the helper then has no callers and is removed along with its key constant. Any caller
  // outside those forms leaves the helper in place, and the module declines loudly as before.
  const saveHelper = working.match(new RegExp(
    String.raw`function\s+([\w$]+)\s*\(\s*([\w$]+)\s*\)\s*\{\s*${STORE_ACCESS}\s*\.\s*setItem\s*\(\s*([\w$]+|["'][^"']+["'])\s*,\s*JSON\s*\.\s*stringify\s*\(\s*\2\s*\)\s*\)\s*;?\s*\}`,
  ));
  if (saveHelper) {
    const [helperText, helperName, , keyToken] = saveHelper;
    const name = helperName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    let rewrote = false;

    // save([...list, item]) → create(item)
    working = working.replace(
      new RegExp(String.raw`(?:await\s+)?${name}\s*\(\s*\[\s*\.\.\.\s*[\w$.()]+\s*,\s*([\w$.]+)\s*\]\s*\)\s*;?`, "g"),
      (whole, item) => { rewrote = true; applied.push("save_helper_append"); return `await db.entity("${entity}").create(${item});`; },
    );
    // list.push(item); save(list) → create(item)
    working = working.replace(
      new RegExp(String.raw`([\w$]+)\s*\.\s*push\s*\(\s*([\w$]+)\s*\)\s*;\s*\n?\s*(?:await\s+)?${name}\s*\(\s*\1\s*\)\s*;?`, "g"),
      (whole, list, item) => { rewrote = true; applied.push("save_helper_push"); return `await db.entity("${entity}").create(${item});`; },
    );
    // save(list.filter((r) => r.prop !== value)) → delete every row whose prop matches
    working = working.replace(
      new RegExp(String.raw`(?:await\s+)?${name}\s*\(\s*[\w$.()]+\s*\.\s*filter\s*\(\s*\(?\s*([\w$]+)\s*\)?\s*=>\s*\1\s*\.\s*([\w$]+)\s*!==?\s*([\w$.]+)\s*\)\s*\)\s*;?`, "g"),
      (whole, row, prop, value) => {
        rewrote = true; applied.push("save_helper_filter_delete");
        return `{\n    const rows = await db.entity("${entity}").list();\n    for (const r of rows) if (r.${prop} === ${value}) await db.entity("${entity}").delete(r.id);\n  }`;
      },
    );

    // Only when every caller was rewritten may the helper (and its now-orphaned key) be removed —
    // a surviving caller means an unprovable use, and the untouched helper makes the module
    // decline below rather than half-transform.
    const callersLeft = (working.match(new RegExp(String.raw`\b${name}\s*\(`, "g")) || [])
      .length - 1; // the declaration itself
    if (rewrote && callersLeft === 0) {
      working = working.replace(helperText, "");
      if (/^[\w$]+$/.test(keyToken)) {
        const keyRefs = (working.match(new RegExp(String.raw`\b${keyToken}\b`, "g")) || []).length;
        // The const declaration plus at most the read pattern (rewritten next) may remain.
        if (keyRefs <= 2) {
          working = working.replace(new RegExp(String.raw`^\s*const\s+${keyToken}\s*=\s*["'][^"']*["']\s*;\s*$`, "m"), "");
        }
      }
    }
  }

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
      // NEVER a React component. A component whose body contains an awaiting handler is not itself
      // async, and marking it so returns a Promise from render — the screen goes blank. An earlier
      // version turned `export default function App()` into `async function App()` for exactly this
      // reason: the await it found was inside a submit handler nested in the component.
      const isComponent = /^[A-Z]/.test(name) && /return\s*\(?\s*</.test(body);
      if (isComponent) return whole;
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

// ── SHAPE C from run cf130c23 (src/data/newsletterSignup.js:38-39): the guest fallback branch ──
//
//   if (!user) {
//     const record = { id: `local-…`, …, localOnly: true };
//     try {
//       const existing = JSON.parse(localStorage.getItem(KEY) || "[]");
//       localStorage.setItem(KEY, JSON.stringify([record, ...existing].slice(0, N)));
//     } catch { … }
//     return record;
//   }
//   …
//   const row = await entity().create({ … });
//
// The module already has the REAL create path; only anonymous visitors were shunted into the
// browser. The branch's actual job — "persist even for visitors who never signed in" — is done
// properly by establishing a visitor session and falling through to the real create. The
// slice(0, N) cap bounded a guest-only list this module never reads back; the database keeps
// every record (the source of truth), and any visible cap belongs on display reads.
//
// The session strategy is the SCAFFOLD's maintained module, never a synthesis and no longer a
// per-app move: src/lib/visitorSession.js ships with every generated app, is exempted by the
// honesty scan by PATH, and is protected from edits by the stage gate. Guest branches call its
// ensureVisitorSession; a hand-written local bootstrap is replaced with an import alias of it —
// same callers, same contract, one centrally-tested implementation. (The previous design moved
// the app's OWN bootstrap into src/data/visitorSession.js; the 46.10-credit run showed where
// that leads — the model re-invents the file per build and the scanner cannot bless every
// variant, so three stages went through repair loops over one helper.)

const VISITOR_SESSION_PATH = "src/lib/visitorSession.js";
const SCAFFOLD_VISITOR_SESSION = REACT_VITE[VISITOR_SESSION_PATH];

function relativeImport(fromFile, toFile) {
  const from = fromFile.split("/").slice(0, -1);
  const to = toFile.split("/");
  while (from.length && to.length > 1 && from[0] === to[0]) { from.shift(); to.shift(); }
  const up = from.length ? "../".repeat(from.length) : "./";
  return (up + to.join("/")).replace(/\.(jsx?|tsx?)$/, "");
}

function matchBrace(source, open) {
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

export function transformGuestFallback(tree, { files = [] } = {}) {
  const working = { ...tree };
  const appliedByFile = {};
  const notes = [];
  let rewired = false;

  const ensureScaffold = () => {
    if (!working[VISITOR_SESSION_PATH] && SCAFFOLD_VISITOR_SESSION) {
      working[VISITOR_SESSION_PATH] = SCAFFOLD_VISITOR_SESSION;
      notes.push(`added the scaffold ${VISITOR_SESSION_PATH} (older tree predates it)`);
    }
  };

  for (const file of files) {
    const source = working[file];
    if (!source || file === VISITOR_SESSION_PATH) continue;
    const applied = [];
    let next = source;

    // A hand-written local bootstrap: replace the whole function with an import alias of the
    // scaffold's ensureVisitorSession — same name, same callers, same contract (returns the
    // signed-in user, establishing the session on the way).
    const local = findSessionBootstrapFunction(next);
    if (local && next.includes(local.text)) {
      next = next.replace(local.text,
        `// (${local.name} is the supported scaffold module now — see src/lib/visitorSession.js)`);
      const alias = local.name === "ensureVisitorSession"
        ? "ensureVisitorSession"
        : `ensureVisitorSession as ${local.name}`;
      if (!new RegExp(String.raw`import\s*\{[^}]*\b${local.name}\b`).test(next)) {
        next = `import { ${alias} } from "${relativeImport(file, VISITOR_SESSION_PATH)}";\n${next}`;
      }
      applied.push("local_bootstrap_aliased_to_scaffold");
    }

    // The guest fallback branch: provable only when it stores in the browser, returns early,
    // never touches the database — and the real create exists after it, on a `let` variable.
    const header = /if\s*\(\s*!\s*([\w$]+)\s*\)\s*\{/g;
    let match = null;
    let rewrite = null;
    while ((match = header.exec(next)) !== null) {
      const open = next.indexOf("{", match.index + match[0].length - 1);
      const end = matchBrace(next, open);
      if (end === -1) continue;
      const body = next.slice(open + 1, end);
      const storesInBrowser = new RegExp(String.raw`${STORE_ACCESS}\s*\.\s*setItem\b`).test(body);
      const returnsEarly = /\breturn\b/.test(body);
      const touchesDb = /\bdb\s*\.|\.\s*(?:create|list|update|delete)\s*\(/.test(body);
      const createAfter = /\.\s*create\s*\(/.test(next.slice(end));
      const reassignable = new RegExp(String.raw`\blet\s+${match[1]}\b`).test(next);
      if (storesInBrowser && returnsEarly && !touchesDb && createAfter && reassignable) {
        rewrite = { start: match.index, end: end + 1, variable: match[1] };
        break;
      }
    }
    if (rewrite) {
      next = next.slice(0, rewrite.start)
        + `if (!${rewrite.variable}) {\n    ${rewrite.variable} = await ensureVisitorSession();\n  }`
        + next.slice(rewrite.end);
      if (!/import\s*\{[^}]*\bensureVisitorSession\b/.test(next)) {
        next = `import { ensureVisitorSession } from "${relativeImport(file, VISITOR_SESSION_PATH)}";\n${next}`;
      }
      applied.push("guest_fallback_bootstrap");
    }

    if (applied.length) {
      working[file] = next;
      appliedByFile[file] = applied;
      rewired = true;
    }
  }

  if (!rewired) return { tree, appliedByFile: {}, notes };
  ensureScaffold();
  return { tree: working, appliedByFile, notes };
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

  const files = [...new Set(findings
    .filter((f) => (f.id === "fake_persistence" || f.id === "local_session_bootstrap") && f.file)
    .map((f) => f.file))];

  // SHAPE C first: it is tree-level (the fix moves the app's own bootstrap into a shared module),
  // and a module it fully cleans never reaches the call-site patterns at all.
  const guest = transformGuestFallback(working, { files });
  Object.assign(working, guest.tree);
  for (const [file, applied] of Object.entries(guest.appliedByFile)) {
    if (!files.includes(file) && !usesBrowserStorage(working[file])) {
      // A file edited only as the move's origin (not itself a finding) — count it as fixed work.
      fixed.push({ file, entity: null, applied });
    }
  }

  for (const file of files) {
    const source = working[file];
    if (!source) continue;

    const guestApplied = guest.appliedByFile[file] || [];
    if (guestApplied.length && !usesBrowserStorage(source)) {
      fixed.push({ file, entity: null, applied: guestApplied });
      continue;
    }

    // Which entity is this module about? Its path first, then its content, then — only when the
    // app has exactly one entity — that one.
    const entity = entities.find((e) => file.toLowerCase().includes(String(e.name).toLowerCase()))
      || entities.find((e) => new RegExp(`\\b${e.name}\\b`, "i").test(source))
      || (entities.length === 1 ? entities[0] : null);

    const result = transformModule(source, { entity: entity?.name, path: file });
    if (result.ok) {
      working[file] = result.source;
      fixed.push({ file, entity: entity?.name, applied: [...guestApplied, ...result.applied] });
    } else {
      declined.push({ file, reasons: [...guest.notes, ...result.declined], partial: [...guestApplied, ...result.applied] });
    }
  }

  return { tree: working, fixed, declined };
}

export function transformSummary({ fixed, declined }) {
  const parts = [];
  if (fixed.length) parts.push(`rewrote ${fixed.length} module(s) with no model call: ${fixed.map((f) => (f.entity ? `${f.file} → db.entity("${f.entity}")` : `${f.file} (${f.applied.join("+")})`)).join(", ")}`);
  if (declined.length) parts.push(`declined ${declined.length}: ${declined.map((d) => `${d.file} (${d.reasons[0]})`).join("; ")}`);
  return parts.join(" · ") || "nothing to transform";
}
