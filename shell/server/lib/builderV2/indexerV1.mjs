// Deterministic Code Indexer v1 (WP-13; master plan Part 7, correction C3).
//
// The REAL parser behind the same FileIndex interface as v0: @babel/parser with JSX,
// error recovery on — but any recovered error still means OPAQUE, because an index built
// on a file the parser had to guess at would poison every consumer downstream. Spans are
// EXACT AST ranges (v0's were next-header-delimited and bled trailing content); per-block
// meta reads the same signals as v0 from the exact slice, so the graph's behaviour is a
// strict refinement, never a rewrite. C3 discharged: v0 stays as the floor and the test
// fixture parser; v1 is the default for every v2 path.

import crypto from "node:crypto";
import { parse } from "@babel/parser";
import {
  tokensOf, extractImports, blockMeta,
  indexTree as indexTreeWith, treeHashOf, diffIndex,
} from "./indexerV0.mjs";

const sha256 = (text) => crypto.createHash("sha256").update(text).digest("hex");
const CODE_FILE = /\.(jsx?|tsx?|mjs|cjs)$/;

export { tokensOf, treeHashOf, diffIndex };

function symbolsFromAst(ast, text) {
  const symbols = [];
  const push = (name, node, { exported = false, isDefault = false, declKind = "function", spanNode = node } = {}) => {
    if (!name) return;
    const start = spanNode.start;
    const end = spanNode.end;
    const block = text.slice(start, end);
    const meta = blockMeta(block, name);
    const kind = declKind === "class" ? "class"
      : /^[A-Z]/.test(name) && meta.returnsJsx ? "component"
      : declKind === "const" ? "const" : "function";
    symbols.push({
      name, kind, exported, isDefault, start, end,
      blockHash: sha256(block), meta,
    });
  };

  for (const node of ast.program.body) {
    if (node.type === "FunctionDeclaration") {
      push(node.id?.name, node, { declKind: "function" });
    } else if (node.type === "ClassDeclaration") {
      push(node.id?.name, node, { declKind: "class" });
    } else if (node.type === "VariableDeclaration") {
      const d = node.declarations[0];
      if (d?.id?.type === "Identifier") push(d.id.name, node, { declKind: "const" });
    } else if (node.type === "ExportNamedDeclaration" && node.declaration) {
      const decl = node.declaration;
      if (decl.type === "FunctionDeclaration") push(decl.id?.name, decl, { exported: true, declKind: "function", spanNode: node });
      else if (decl.type === "ClassDeclaration") push(decl.id?.name, decl, { exported: true, declKind: "class", spanNode: node });
      else if (decl.type === "VariableDeclaration") {
        const d = decl.declarations[0];
        if (d?.id?.type === "Identifier") push(d.id.name, decl, { exported: true, declKind: "const", spanNode: node });
      }
    } else if (node.type === "ExportDefaultDeclaration") {
      const decl = node.declaration;
      const name = decl.id?.name
        || (decl.type === "Identifier" ? decl.name : null)
        || "default";
      const declKind = decl.type === "ClassDeclaration" ? "class"
        : decl.type?.includes("Function") ? "function" : "const";
      push(name, decl, { exported: true, isDefault: true, declKind, spanNode: node });
    }
  }
  return symbols;
}

/** Same contract as v0's indexFile: pure, deterministic, honest opaque fallback. */
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

  let symbols = null;
  try {
    const ast = parse(text, {
      sourceType: "module",
      plugins: ["jsx"],
      errorRecovery: true, // recover enough to REPORT errors; recovered files stay opaque
    });
    if (!ast.errors?.length) symbols = symbolsFromAst(ast, text);
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
    refs: symbols.flatMap((s) => s.meta.calls.map((name) => ({ fromSymbol: s.name, refName: name }))),
  };
}

/** Tree-level indexing is SHARED with v0 — only the per-file parser differs. */
export function indexTree(tree) {
  return indexTreeWith(tree, indexFile);
}
