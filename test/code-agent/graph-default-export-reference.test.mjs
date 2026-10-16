import test from "node:test";
import assert from "node:assert/strict";
import { indexTree } from "../../shell/server/lib/builderV2/indexer.mjs";
import { fileGraphPayload, fileGraphHash } from "../../shell/server/lib/builderV2/graphParity.mjs";

test("named plus default export retains its immutable symbols and resolves call ownership", () => {
  const file = "src/extensions/custom/calculate.js";
  const tree = { [file]: 'export function calculate(input) { return Math.ceil(Number(input)); }\nexport default calculate;' };
  const index = indexTree(tree);
  assert.equal(index.files.get(file).symbols.filter(s => s.name === "calculate").length, 2);
  const payload = fileGraphPayload(index, file);
  assert.equal(payload.symbols.length, 2, "existing persisted symbol shape is unchanged");
  assert.deepEqual(payload.refs.map(r => r.from_symbol_ordinal), [0, 0]);
  assert.equal(fileGraphHash(index, file), fileGraphHash(indexTree(tree), file));
});

test("graph promotion still rejects genuinely ambiguous call ownership", () => {
  const file = "src/a.js";
  const index = indexTree({ [file]: 'export function calculate() { return helper(); }\nexport default calculate;' });
  index.files.get(file).symbols[1].meta.calls = ["helper"];
  assert.throws(() => fileGraphPayload(index, file), /reference source symbol calculate is not unique/);
});
