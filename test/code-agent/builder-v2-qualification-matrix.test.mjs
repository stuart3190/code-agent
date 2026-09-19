import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";

test("V2-only deterministic qualification matrix is complete and references executable proofs", async () => {
  const url = new URL("./fixtures/bv2-qualification-matrix.json", import.meta.url);
  const matrix = JSON.parse(await readFile(url, "utf8"));
  assert.equal(matrix.modelSpend, false);
  const required = ["landing", "contact", "crud-data", "booking", "booking-wizard", "multi-route",
    "auth-session", "asset-heavy", "typescript-tsx", "legacy-adoption", "edit", "repair",
    "publish-rollback", "cancellation-worker", "provider-failure-billing", "runtime-composition",
    "graph-owner-parity", "backup-restore"];
  assert.deepEqual(matrix.classes.map((row) => row.id).sort(), required.sort());
  for (const row of matrix.classes) {
    assert.ok(row.asserts.length, `${row.id} has explicit assertions`);
    await access(new URL(`./${row.proof}`, import.meta.url));
  }
});
