// WP-13 — Indexer v1 (@babel/parser) as a STRICT REFINEMENT of v0, proven on both stored
// production trees: everything v0 could see, v1 sees at least as precisely; spans are
// exact AST ranges; error recovery still means opaque; determinism byte-for-byte.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as v0 from "../../shell/server/lib/builderV2/indexerV0.mjs";
import * as v1 from "../../shell/server/lib/builderV2/indexerV1.mjs";
import { indexFile as facadeIndexFile } from "../../shell/server/lib/builderV2/indexer.mjs";
import { applyPatches } from "../../shell/server/lib/builderV2/patchEngine.mjs";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const MONOLITH = JSON.parse(readFileSync(path.join(FIXTURES, "run178f7fc8-tree.json"), "utf8"));
const MODULAR = JSON.parse(readFileSync(path.join(FIXTURES, "run17b6513f-tree.json"), "utf8"));

test("WP13 — parity on BOTH production trees: v1 parses everything v0 parsed and finds v0's exported symbols", () => {
  for (const [label, tree] of [["monolith", MONOLITH], ["modular", MODULAR]]) {
    const a = v0.indexTree(tree);
    const b = v1.indexTree(tree);
    for (const [p, ix0] of a.files) {
      const ix1 = b.files.get(p);
      assert.equal(ix1.contentHash, ix0.contentHash, `${label} ${p}: content hashes identical`);
      if (!ix0.opaque) {
        assert.equal(ix1.opaque, false, `${label} ${p}: v1 must parse whatever v0 parsed`);
        const names0 = new Set(ix0.symbols.filter((s) => s.exported).map((s) => s.name));
        const names1 = new Set(ix1.symbols.filter((s) => s.exported).map((s) => s.name));
        for (const name of names0) {
          assert.ok(names1.has(name), `${label} ${p}: v0 export "${name}" must be seen by v1`);
        }
      }
      // Imports come from the shared extractor — byte-identical by construction.
      assert.deepEqual(ix1.imports, ix0.imports, `${label} ${p}: imports identical`);
    }
    assert.equal(b.treeHash, a.treeHash, `${label}: tree hash is content-derived, so identical`);
  }
});

test("WP13 — v1 spans are EXACT declaration ranges; v0's bleed to the next header", () => {
  const source = `import React from "react";

export function First() {
  return 1;
}

// a comment between declarations

export function Second() {
  return 2;
}
`;
  const ix0 = v0.indexFile("src/a.jsx", source);
  const ix1 = v1.indexFile("src/a.jsx", source);
  const first0 = ix0.symbols.find((s) => s.name === "First");
  const first1 = ix1.symbols.find((s) => s.name === "First");
  assert.match(source.slice(first0.start, first0.end), /a comment between/, "v0 bleeds trailing content");
  assert.equal(source.slice(first1.start, first1.end), "export function First() {\n  return 1;\n}", "v1 is exact");
  assert.equal(ix1.symbols.find((s) => s.name === "Second").isDefault, false);
});

test("WP13 — strict refinement: v1 parses files v0's raw brace count falsely rejects", () => {
  // An unbalanced brace inside a STRING: valid JS, opaque to v0's honest floor.
  const source = 'export function Smile() {\n  const face = "{";\n  return face;\n}\n';
  assert.equal(v0.indexFile("src/s.js", source).opaque, true, "v0 floors out — by design");
  const ix1 = v1.indexFile("src/s.js", source);
  assert.equal(ix1.opaque, false, "v1 genuinely parses it");
  assert.equal(ix1.symbols[0].name, "Smile");
});

test("WP13 — error recovery still means OPAQUE: a broken file never gets a guessed index", () => {
  const broken = "export function f() { const = 3; }\n";
  const ix1 = v1.indexFile("src/broken.js", broken);
  assert.equal(ix1.opaque, true, "recovered parse errors are still errors");

  // And the patch engine (now on v1 via the facade) REJECTS content v0's brace count
  // would have waved through — balanced braces, invalid JS.
  const out = applyPatches(
    { "src/routes/A.jsx": "export default function A() {\n  return null;\n}\n" },
    [{ file: "src/routes/A.jsx", ops: [{ op: "replace_symbol", symbol: "A", content: "export default function A() { const = 3; }" }] }],
  );
  assert.equal(out.applied.length, 0);
  assert.match(out.rejected[0].reason, /does not parse/);
  assert.equal(v0.indexFile("x.js", "function f() { const = 3; }").opaque, false, "…which v0 could not catch");
});

test("WP13 — deterministic byte-for-byte, default exports named, facade serves v1", () => {
  const source = 'export default function HomePage() {\n  return <main>hi</main>;\n}\nexport const helper = () => 1;\n';
  const a = v1.indexFile("src/routes/HomePage.jsx", source);
  const b = v1.indexFile("src/routes/HomePage.jsx", source);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  const home = a.symbols.find((s) => s.name === "HomePage");
  assert.equal(home.isDefault, true);
  assert.equal(home.kind, "component");
  assert.equal(a.symbols.find((s) => s.name === "helper").kind, "const");
  assert.equal(JSON.stringify(facadeIndexFile("src/routes/HomePage.jsx", source)), JSON.stringify(a), "the facade IS v1");
});

test("WP13 — diffIndex over v1 indexes still names exactly the changed symbols", () => {
  const before = { "src/a.jsx": "export function A() {\n  return 1;\n}\nexport function B() {\n  return 2;\n}\n" };
  const after = { "src/a.jsx": "export function A() {\n  return 99;\n}\nexport function B() {\n  return 2;\n}\n" };
  const diff = v1.diffIndex(v1.indexTree(before), v1.indexTree(after));
  assert.deepEqual(diff.changed, ["src/a.jsx"]);
  assert.deepEqual(diff.changedSymbols, [{ path: "src/a.jsx", name: "A", kind: "changed" }],
    "B's exact-span hash is untouched by A's edit");
});
