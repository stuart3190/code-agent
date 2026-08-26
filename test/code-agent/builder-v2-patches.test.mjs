// WP-2 — structured patch engine, proven against the real modular production tree.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { applyPatches, escalationPlan, EMIT_PATCHES_SCHEMA } from "../../shell/server/lib/builderV2/patchEngine.mjs";
import { indexFile, indexTree, diffIndex } from "../../shell/server/lib/builderV2/indexerV0.mjs";
import { preflightImports } from "../../shell/server/lib/appBuild/importPreflight.mjs";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const TREE = JSON.parse(readFileSync(path.join(FIXTURES, "run17b6513f-tree.json"), "utf8"));
const CONTRACT = JSON.parse(readFileSync(path.join(FIXTURES, "cf130c23", "contract.json"), "utf8"));

const SELECTOR = "src/components/BookingSlotSelector.jsx";

test("WP2 — replace_symbol lands surgically: only the targeted symbol's hash changes", () => {
  const before = indexTree(TREE);
  const original = indexFile(SELECTOR, TREE[SELECTOR]);
  const target = original.symbols.find((s) => s.kind === "component") || original.symbols[0];
  const block = String(TREE[SELECTOR]).slice(target.start, target.end);

  const result = applyPatches(TREE, [{
    file: SELECTOR,
    ops: [{ op: "replace_symbol", symbol: target.name, content: block.replace("return", 'console.log("cancel feedback probe"); return') }],
    newFile: null, content: null, deleteFile: null,
  }], { contract: CONTRACT });

  assert.equal(result.rejected.length, 0, JSON.stringify(result.rejected));
  assert.equal(result.applied.length, 1);
  const diff = diffIndex(before, indexTree(result.tree));
  assert.deepEqual(diff.changed, [SELECTOR], "exactly one file changed");
  const touched = diff.changedSymbols.filter((s) => s.path === SELECTOR);
  assert.deepEqual(touched.map((s) => s.name), [target.name], "exactly the targeted symbol");
  assert.notEqual(result.tree, TREE, "input tree never mutated");
  assert.equal(TREE[SELECTOR].includes("cancel feedback probe"), false);
});

test("WP2 — insert/delete/append ops parse-validate their results", () => {
  const helper = "function probeHelper() { return 42; }";
  const okInsert = applyPatches(TREE, [{
    file: SELECTOR, newFile: null, content: null, deleteFile: null,
    ops: [{ op: "insert_before_symbol", symbol: indexFile(SELECTOR, TREE[SELECTOR]).symbols[0].name, content: helper }],
  }]);
  assert.equal(okInsert.rejected.length, 0);
  assert.ok(okInsert.tree[SELECTOR].includes("probeHelper"));

  const badInsert = applyPatches(TREE, [{
    file: SELECTOR, newFile: null, content: null, deleteFile: null,
    ops: [{ op: "insert_after_symbol", symbol: indexFile(SELECTOR, TREE[SELECTOR]).symbols[0].name, content: "function broken() { if (x { }" }],
  }]);
  assert.equal(badInsert.applied.length, 0);
  assert.match(badInsert.rejected[0].reason, /does not parse/);

  const appended = applyPatches(TREE, [{
    file: "src/data/bookings.js", newFile: null, content: null, deleteFile: null,
    ops: [{ op: "append", symbol: null, content: "export function probeAppend() { return 1; }" }],
  }]);
  assert.equal(appended.rejected.length, 0);
  assert.ok(appended.tree["src/data/bookings.js"].endsWith("export function probeAppend() { return 1; }"));
});

test("WP2 — unknown symbols reject with the file's REAL symbol list in the reason", () => {
  const result = applyPatches(TREE, [{
    file: SELECTOR, newFile: null, content: null, deleteFile: null,
    ops: [{ op: "replace_symbol", symbol: "NoSuchThing", content: "function NoSuchThing() {}" }],
  }]);
  assert.equal(result.applied.length, 0);
  assert.match(result.rejected[0].reason, /symbol "NoSuchThing" not found/);
  assert.match(result.rejected[0].reason, /present symbols:/, "the machine reason teaches the model");
});

test("WP2 — protected paths and anti-collapse deletions are refused", () => {
  const sdk = applyPatches(TREE, [{
    file: "src/lib/backend/index.js", newFile: null, content: null, deleteFile: null,
    ops: [{ op: "append", symbol: null, content: "// vandalism" }],
  }]);
  assert.match(sdk.rejected[0].reason, /protected platform infrastructure/);

  const route = applyPatches(TREE, [{ file: null, ops: null, newFile: null, content: null, deleteFile: "src/routes/ManagePage.jsx" }]);
  assert.match(route.rejected[0].reason, /anti-collapse/);

  const dupe = applyPatches(TREE, [{ file: null, ops: null, newFile: SELECTOR, content: "export default function X() { return null; }", deleteFile: null }]);
  assert.match(dupe.rejected[0].reason, /already exists/);
});

test("WP2 — a batch that would rebuild the monolith is rejected WHOLE (modularity)", () => {
  const giant = `export default function App() {\n${'  // line of feature code\n'.repeat(2100)}  return null;\n}`;
  const result = applyPatches(TREE, [{
    file: "src/App.jsx", newFile: null, content: null, deleteFile: null,
    ops: [{ op: "replace_symbol", symbol: "App", content: giant }],
  }], { contract: CONTRACT });
  assert.equal(result.modularityFailed, true);
  assert.equal(result.applied.length, 0, "the WHOLE batch rolls back");
  assert.equal(result.tree, TREE, "the original tree object is returned untouched");
  assert.ok(result.rejected.some((r) => /src\/App\.jsx is \d+ tokens/.test(r.reason)));
});

test("WP2 — two rejections of one op escalate exactly that file to regeneration", () => {
  const rejection = { signature: `${SELECTOR}:replace_symbol:Nope`, reason: "symbol not found" };
  assert.deepEqual(escalationPlan([rejection]).regenerateFiles, [], "one strike is not escalation");
  assert.deepEqual(escalationPlan([rejection, { ...rejection }]).regenerateFiles, [SELECTOR]);
  assert.deepEqual(escalationPlan([
    rejection, { ...rejection },
    { signature: "new:src/x.js", reason: "does not parse" }, { signature: "new:src/x.js", reason: "does not parse" },
  ]).regenerateFiles, [SELECTOR, "src/x.js"].sort());
});

test("WP2 — the synthetic cancel-confirmation patch passes D0 on the patched tree", async () => {
  // The live gap from run 689e49e1: cancellation lacked a visible confirmation prompt. A v2
  // repair lands it as ONE symbol insertion; the patched tree still preflights clean.
  const lookupPath = "src/components/ManageBookingLookup.jsx";
  const lookupIndex = indexFile(lookupPath, TREE[lookupPath]);
  const anchor = lookupIndex.symbols[lookupIndex.symbols.length - 1];
  const result = applyPatches(TREE, [{
    file: lookupPath, newFile: null, content: null, deleteFile: null,
    ops: [{
      op: "insert_before_symbol", symbol: anchor.name,
      content: [
        "function CancelConfirmationPrompt({ onConfirm, onKeep }) {",
        "  return (",
        '    <div role="alertdialog" aria-label="Confirm cancellation">',
        "      <p>Cancel this reservation? The slot and party spaces will be released.</p>",
        '      <button type="button" onClick={onConfirm}>Yes, cancel it</button>',
        '      <button type="button" onClick={onKeep}>Keep my booking</button>',
        "    </div>",
        "  );",
        "}",
      ].join("\n"),
    }],
  }], { contract: CONTRACT });
  assert.equal(result.rejected.length, 0, JSON.stringify(result.rejected));

  const preflight = await preflightImports(result.tree, { nodeModules: null }).catch((e) => ({ ok: true, skipped: e.message }));
  assert.notEqual(preflight.ok, false, "D0 import preflight holds on the patched tree");
  assert.ok(result.tree[lookupPath].includes("CancelConfirmationPrompt"));
});

test("WP2 — the strict tool schema is complete: every property required, optionals nullable", () => {
  const schema = EMIT_PATCHES_SCHEMA;
  assert.equal(schema.strict, true);
  assert.deepEqual(schema.parameters.required, ["patches"]);
  const item = schema.parameters.properties.patches.items;
  assert.deepEqual(item.required.sort(), ["content", "deleteFile", "file", "newFile", "ops", "replaceFile"].sort(),
    "strict tools need ALL properties required (the P18 lesson) with nullable optionals");
});

// ── WP-11 live evidence: replaceFile is the mutation path for index-opaque files ──────────────

test("replaceFile: the only way to change CSS — validated, protected-path-aware, parse-checked for JS", () => {
  const tree = {
    "src/index.css": ":root { --x: 1; }",
    "src/routes/A.jsx": "export default function A() { return null; }",
    "src/lib/capabilities/forms.js": "// protected",
  };
  const ok = applyPatches(tree, [{ replaceFile: "src/index.css", content: ":root { --x: 2; } .hero { color: red; }" }]);
  assert.equal(ok.rejected.length, 0, JSON.stringify(ok.rejected));
  assert.match(ok.tree["src/index.css"], /--x: 2/);
  assert.equal(ok.applied[0].kind, "replaceFile");

  const missing = applyPatches(tree, [{ replaceFile: "src/nope.css", content: "x" }]);
  assert.match(missing.rejected[0].reason, /does not exist/);

  const protectedHit = applyPatches(tree, [{ replaceFile: "src/lib/capabilities/forms.js", content: "x" }]);
  assert.match(protectedHit.rejected[0].reason, /protected platform infrastructure/);

  const badJs = applyPatches(tree, [{ replaceFile: "src/routes/A.jsx", content: "export default function A() { return (" }]);
  assert.match(badJs.rejected[0].reason, /does not parse/);

  // The opaque-file teaching now names the way out.
  const opaqueOp = applyPatches(tree, [{ file: "src/index.css", ops: [{ op: "append", content: "x" }] }]);
  assert.match(opaqueOp.rejected[0].reason, /use replaceFile with the COMPLETE new content/);
});

// ── WP-11 attempt-3 evidence: imports are lines, duplicate defaults are free rejections ───────

test("add_import inserts after the last import; naming an import as a symbol teaches the op", () => {
  const tree = { "src/App.jsx": 'import React from "react";\nimport { A } from "./a";\n\nexport default function App() { return null; }\n' };
  const ok = applyPatches(tree, [{ file: "src/App.jsx", ops: [{ op: "add_import", symbol: null, content: 'import HomePage from "./routes/HomePage";' }] }]);
  assert.equal(ok.rejected.length, 0, JSON.stringify(ok.rejected));
  const lines = ok.tree["src/App.jsx"].split("\n");
  assert.equal(lines[2], 'import HomePage from "./routes/HomePage";', "after the LAST existing import");

  const bad = applyPatches(tree, [{ file: "src/App.jsx", ops: [{ op: "add_import", symbol: null, content: "const x = 1;" }] }]);
  assert.match(bad.rejected[0].reason, /must be a complete import statement/);

  // The exact live miss: an import statement named as a symbol — the rejection names add_import.
  const miss = applyPatches(tree, [{ file: "src/App.jsx", ops: [{ op: "insert_after_symbol", symbol: 'import HomePage from "./routes/HomePage";', content: "x" }] }]);
  assert.match(miss.rejected[0].reason, /use \{op: "add_import"/);
});

test("add_import is idempotent against retained sibling work and adds only missing bindings", () => {
  const tree = {
    "src/App.jsx": [
      'import { useEffect, useMemo, useState } from "react";',
      'import Existing from "./Existing.jsx";',
      "export default function App() { return null; }",
    ].join("\n"),
  };

  const retained = applyPatches(tree, [{
    file: "src/App.jsx", ops: [{ op: "add_import", symbol: null,
      content: 'import { useEffect, useState } from "react";' }],
  }]);
  assert.equal(retained.rejected.length, 0, JSON.stringify(retained.rejected));
  assert.equal(retained.applied[0].kind, "add_import_existing");
  assert.equal((retained.tree["src/App.jsx"].match(/useEffect/g) || []).length, 1);

  const partial = applyPatches(retained.tree, [{
    file: "src/App.jsx", ops: [{ op: "add_import", symbol: null,
      content: 'import { useCallback, useEffect, useState } from "react";' }],
  }, {
    file: "src/App.jsx", ops: [{ op: "add_import", symbol: null,
      content: 'import Existing from "./Existing.jsx";' }],
  }]);
  assert.equal(partial.rejected.length, 0, JSON.stringify(partial.rejected));
  assert.match(partial.tree["src/App.jsx"], /import \{ useCallback \} from "react";/);
  assert.equal((partial.tree["src/App.jsx"].match(/useEffect/g) || []).length, 1);
  assert.equal((partial.tree["src/App.jsx"].match(/Existing from/g) || []).length, 1);
  assert.equal(indexFile("src/App.jsx", partial.tree["src/App.jsx"]).opaque, false);
});

test("a second default export is rejected at APPLY time with the fix named — never a compile round", () => {
  const tree = { "src/routes/HomePage.jsx": "export default function HomePage() {\n  return null;\n}\n" };
  const dup = applyPatches(tree, [{ file: "src/routes/HomePage.jsx", ops: [{ op: "append", symbol: null, content: "export default function BetterHome() {\n  return 1;\n}" }] }]);
  assert.equal(dup.applied.length, 0);
  assert.match(dup.rejected[0].reason, /2 default exports/);
  assert.match(dup.rejected[0].reason, /use replace_symbol on the existing default/);

  // The correct move still works.
  const ok = applyPatches(tree, [{ file: "src/routes/HomePage.jsx", ops: [{ op: "replace_symbol", symbol: "HomePage", content: "export default function HomePage() {\n  return 2;\n}" }] }]);
  assert.equal(ok.rejected.length, 0, JSON.stringify(ok.rejected));
});

test("replace_exact surgically patches one unique nested excerpt and fails closed", () => {
  const routePath = "src/routes/Nested.jsx";
  const source = [
    "export default function Nested() {",
    "  const ready = false;",
    "  function start() { return true; }",
    "  if (!ready) return <button onClick={start}>Start</button>;",
    "  return <main>Ready</main>;",
    "}",
  ].join("\n");
  const tree = { [routePath]: source };
  const expected = "if (!ready) return <button onClick={start}>Start</button>;";
  const replacement = "if (!ready) return <button onClick={start}>Start now</button>;";
  const result = applyPatches(tree, [{ file: routePath, ops: [{
    op: "replace_exact", symbol: expected, content: replacement,
  }] }]);
  assert.equal(result.rejected.length, 0, JSON.stringify(result.rejected));
  assert.equal(result.applied[0].kind, "replace_exact");
  assert.match(result.applied[0].signature, /replace_exact:[a-f0-9]{16}$/);
  assert.match(result.tree[routePath], /Start now/);
  assert.equal(tree[routePath], source, "the retained input tree remains immutable");

  const duplicate = applyPatches({ [routePath]: `${source}\n// ${expected}` }, [{ file: routePath, ops: [{
    op: "replace_exact", symbol: expected, content: replacement,
  }] }]);
  assert.match(duplicate.rejected[0].reason, /not unique/);
  const missing = applyPatches(tree, [{ file: routePath, ops: [{
    op: "replace_exact", symbol: "not in source", content: replacement,
  }] }]);
  assert.match(missing.rejected[0].reason, /not found/);
  const malformed = applyPatches(tree, [{ file: routePath, ops: [{
    op: "replace_exact", symbol: expected, content: "if (!ready) return (",
  }] }]);
  assert.match(malformed.rejected[0].reason, /does not parse/);
  const mistakenSymbolName = applyPatches(tree, [{ file: routePath, ops: [{
    op: "replace_exact", symbol: "Nested", content: "<section>Replacement fragment</section>",
  }] }]);
  assert.equal(mistakenSymbolName.rejected[0].code, "invalid_patch_operation");
  assert.match(mistakenSymbolName.rejected[0].reason, /only an indexed symbol name/);
  assert.match(mistakenSymbolName.rejected[0].reason, /complete unique old code block/);
  const unresolved = applyPatches(tree, [{ file: routePath, ops: [{
    op: "replace_exact", symbol: expected,
    content: "if (!ready) { setStep('workspace'); return <button onClick={start}>Start</button>; }",
  }] }]);
  assert.equal(unresolved.applied.length, 0);
  assert.equal(unresolved.rejected[0].code, "tree_integrity_failed");
  assert.match(unresolved.rejected[0].reason, /unresolved call identifier\(s\): setStep/);

  const standardBuiltins = applyPatches(tree, [{ file: routePath, ops: [{
    op: "replace_exact", symbol: expected,
    content: "if (!ready) { const values = new Set([String(1)]); return <button onClick={start}>{values.size}</button>; }",
  }] }]);
  assert.equal(standardBuiltins.rejected.length, 0, JSON.stringify(standardBuiltins.rejected));

  const locallyBound = applyPatches(tree, [{ file: routePath, ops: [{
    op: "replace_exact", symbol: expected,
    content: "if (!ready) { const advance = () => true; return <button onClick={advance}>Start</button>; }",
  }] }]);
  assert.equal(locallyBound.rejected.length, 0, JSON.stringify(locallyBound.rejected));
  assert.ok(EMIT_PATCHES_SCHEMA.parameters.properties.patches.items.properties.ops.items
    .properties.op.enum.includes("replace_exact"));
  assert.match(EMIT_PATCHES_SCHEMA.parameters.properties.patches.items.properties.ops.items
    .properties.symbol.description, /never only a function\/component name/);
});
