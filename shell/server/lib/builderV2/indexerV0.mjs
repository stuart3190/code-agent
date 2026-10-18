// Deterministic Code Indexer v0 (master plan Parts 2 §3 and 7, correction C3).
//
// SCOPE: foundations, stored replay and shadow indexing ONLY. This is the zero-dependency
// regex + brace-matching block parser, production-proven in the slicer and modularity gate,
// promoted to a real index: symbols with exact spans and content hashes, imports resolved
// in-tree, routes/entities/capability calls extracted, and call references resolved against
// the project symbol table. It is NOT sufficient for final production code intelligence —
// Indexer v1 (@babel/parser behind this same interface) replaces it before broad rollout.
//
// HONESTY RULE: a file this parser cannot confidently segment is returned `opaque: true`
// with hashes only. Retrieval must treat an opaque file as a whole body; nothing here ever
// guesses at structure it could not parse.

import crypto from "node:crypto";

const sha256 = (text) => crypto.createHash("sha256").update(text).digest("hex");
export const tokensOf = (text) => Math.ceil(String(text || "").length / 4);

const CODE_FILE = /\.(jsx?|tsx?|mjs|cjs)$/;
const CODE_EXTS = ["", ".jsx", ".js", ".mjs", ".ts", ".tsx", ".css", ".json"];
const INDEX_BASES = ["/index.jsx", "/index.js", "/index.mjs", "/index.ts", "/index.tsx"];

// Words that look like calls but are never project symbols.
const CALL_NOISE = new Set(["if", "for", "while", "switch", "catch", "return", "function",
  "typeof", "new", "await", "import", "require", "super", "constructor"]);

// ── one file ──────────────────────────────────────────────────────────────────────────────────

/**
 * Index one file. Pure and deterministic: identical input bytes give identical output,
 * including every hash and span — asserted by tests against both stored production trees.
 */
export function indexFile(path, source) {
  const text = String(source ?? "");
  const base = {
    path,
    contentHash: sha256(text),
    sizeBytes: Buffer.byteLength(text),
    tokens: tokensOf(text),
  };
  if (!CODE_FILE.test(path)) {
    return { ...base, opaque: true, symbols: [], imports: extractImports(text), refs: [] };
  }

  let symbols;
  try {
    symbols = extractSymbols(text);
  } catch {
    symbols = null;
  }
  if (symbols === null) {
    return { ...base, opaque: true, symbols: [], imports: extractImports(text), refs: [] };
  }

  return {
    ...base,
    opaque: false,
    symbols,
    imports: extractImports(text),
    // Raw call names per symbol; resolved to paths at tree level where the symbol table exists.
    refs: symbols.flatMap((s) => s.meta.calls.map((name) => ({ fromSymbol: s.name, refName: name }))),
  };
}

function extractSymbols(text) {
  const header = /^(export\s+)?(default\s+)?(async\s+)?(function|const|class)\s+([\w$]+)/gm;
  const marks = [];
  let m;
  while ((m = header.exec(text)) !== null) {
    marks.push({ start: m.index, exported: !!m[1], isDefault: !!m[2], declKind: m[4], name: m[5] });
  }
  // OPAQUE detection, honest and cheap. Symbol spans are NEXT-HEADER delimited, so they never
  // depended on brace balance — but a file whose raw braces don't balance is one this parser
  // cannot trust (truncated write, exotic syntax), and a code file with content in which no
  // top-level declaration was found has structure v0 cannot see. A string/comment-aware scanner
  // was tried first and false-positived on apostrophes in JSX prose ("Brook's finest"), which is
  // exactly the class of trap C3 exists to acknowledge: v0 is a floor, not a parser.
  let opens = 0;
  let closes = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "{") opens += 1;
    else if (text[i] === "}") closes += 1;
  }
  if (opens !== closes) throw new Error("unbalanced");
  if (!marks.length && text.trim().length > 0) throw new Error("no structure");

  return marks.map((mark, i) => {
    const end = marks[i + 1] ? marks[i + 1].start : text.length;
    const block = text.slice(mark.start, end);
    const returnsJsx = /return\s*\(?\s*</.test(block);
    const kind = mark.declKind === "class" ? "class"
      : /^[A-Z]/.test(mark.name) && returnsJsx ? "component"
      : mark.declKind === "const" ? "const" : "function";
    return {
      name: mark.name,
      kind,
      exported: mark.exported,
      isDefault: mark.isDefault,
      start: mark.start,
      end,
      blockHash: sha256(block),
      meta: {
        returnsJsx,
        routes: [...block.matchAll(/["'`](\/[a-z0-9/_-]*)["'`]\s*:/gi)].map((r) => r[1]),
        entities: [...block.matchAll(/db\s*\.\s*entity\s*\(\s*["'`]([\w-]+)["'`]\s*\)/g)].map((r) => r[1]),
        calls: [...new Set([...block.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)]
          .map((r) => r[1]).filter((name) => !CALL_NOISE.has(name) && name !== mark.name))],
      },
    };
  });
}

export function extractImports(text) {
  const out = [];
  const re = /(?:from|import|require)\s*\(?\s*["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(text)) !== null) out.push({ specifier: m[1] });
  return out;
}

/** Shared per-block meta extraction — v0 and v1 read the SAME signals from a block slice. */
export function blockMeta(block, selfName) {
  const returnsJsx = /return\s*\(?\s*</.test(block);
  return {
    returnsJsx,
    routes: [...block.matchAll(/["'`](\/[a-z0-9/_-]*)["'`]\s*:/gi)].map((r) => r[1]),
    entities: [...block.matchAll(/db\s*\.\s*entity\s*\(\s*["'`]([\w-]+)["'`]\s*\)/g)].map((r) => r[1]),
    calls: [...new Set([...block.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)]
      .map((r) => r[1]).filter((name) => !CALL_NOISE.has(name) && name !== selfName))],
  };
}

// ── the tree ──────────────────────────────────────────────────────────────────────────────────

function resolveInTree(tree, fromPath, spec) {
  if (!spec.startsWith("./") && !spec.startsWith("../") && !spec.startsWith("@/")) return null;
  const fromDir = fromPath.split("/").slice(0, -1);
  let parts;
  if (spec.startsWith("@/")) parts = ["src", ...spec.slice(2).split("/")];
  else {
    parts = [...fromDir];
    for (const seg of spec.split("/")) {
      if (seg === "." || seg === "") continue;
      else if (seg === "..") parts.pop();
      else parts.push(seg);
    }
  }
  const joined = parts.join("/");
  for (const ext of CODE_EXTS) if ((joined + ext) in tree) return joined + ext;
  for (const idx of INDEX_BASES) if ((joined + idx) in tree) return joined + idx;
  return null;
}

/**
 * Index a whole tree: per-file indexes plus resolved import edges and call references
 * (refName → resolved defining path, when exactly one project symbol matches).
 * `fileIndexer` is injectable so Indexer v1 shares this exact tree-level logic (WP-13).
 */
export function indexTree(tree, fileIndexer = indexFile) {
  const files = new Map();
  for (const [path, source] of Object.entries(tree)) files.set(path, fileIndexer(path, source));

  return resolveTreeIndex(files);
}

/** Rebind cached intrinsic file facts to this manifest's project context. */
export function resolveTreeIndex(files) {
  const tree = Object.fromEntries([...files.keys()].map(path => [path, true]));

  // Project-wide symbol table: name -> defining paths.
  const definers = new Map();
  for (const [path, index] of files) {
    for (const symbol of index.symbols) {
      if (!definers.has(symbol.name)) definers.set(symbol.name, []);
      definers.get(symbol.name).push(path);
    }
  }

  const edges = [];
  for (const [path, index] of files) {
    for (const imp of index.imports) {
      edges.push({ fromPath: path, toPath: resolveInTree(tree, path, imp.specifier), specifier: imp.specifier });
    }
  }

  const refs = [];
  for (const [path, index] of files) {
    for (const ref of index.refs) {
      const candidates = definers.get(ref.refName) || [];
      refs.push({
        fromPath: path,
        fromSymbol: ref.fromSymbol,
        refName: ref.refName,
        // Resolved only when unambiguous — a guess would poison the graph.
        resolvedPath: candidates.length === 1 ? candidates[0] : null,
      });
    }
  }

  return { files, edges, refs, treeHash: treeHashOf(files) };
}

export function treeHashOf(files) {
  const pairs = [...files.entries()].map(([path, ix]) => `${path}${ix.contentHash}`).sort();
  return sha256(pairs.join("\n"));
}

/** What changed between two tree indexes — the differential planner's input. */
export function diffIndex(prev, next) {
  const added = [];
  const removed = [];
  const changed = [];
  for (const path of next.files.keys()) if (!prev.files.has(path)) added.push(path);
  for (const path of prev.files.keys()) if (!next.files.has(path)) removed.push(path);
  const changedSymbols = [];
  for (const [path, nextIx] of next.files) {
    const prevIx = prev.files.get(path);
    if (!prevIx || prevIx.contentHash === nextIx.contentHash) continue;
    changed.push(path);
    const prevByName = new Map(prevIx.symbols.map((s) => [s.name, s]));
    for (const symbol of nextIx.symbols) {
      const before = prevByName.get(symbol.name);
      if (!before) changedSymbols.push({ path, name: symbol.name, kind: "added" });
      else if (before.blockHash !== symbol.blockHash) changedSymbols.push({ path, name: symbol.name, kind: "changed" });
      prevByName.delete(symbol.name);
    }
    for (const name of prevByName.keys()) changedSymbols.push({ path, name, kind: "removed" });
  }
  return { added, removed, changed, changedSymbols };
}
