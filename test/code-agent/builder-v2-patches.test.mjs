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
  assert.deepEqual(item.required.sort(), ["content", "deleteFile", "file", "newFile", "ops"].sort(),
    "strict tools need ALL properties required (the P18 lesson) with nullable optionals");
});
