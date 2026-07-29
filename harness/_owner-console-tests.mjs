import assert from "node:assert/strict";
import { summarizeConsole } from "../shell/server/lib/ownerConsole.mjs";

const summary = summarizeConsole(
  [{ status: "active" }, { status: "disabled" }, { status: "active" }],
  [{ type: "task" }, { type: "task" }, { type: "note" }],
  [
    { status: "paid", currency: "gbp", amount_total: 1000 },
    { status: "paid", currency: "gbp", amount_total: 500 },
    { status: "paid", currency: "usd", amount_total: 250 },
    { status: "failed", currency: "gbp", amount_total: 9999 },
  ],
);
assert.deepEqual(summary.stats, {
  users: 3, activeUsers: 2, records: 3, paidOrders: 3, revenueByCurrency: { gbp: 1500, usd: 250 },
});
assert.deepEqual(summary.entityCounts, { task: 2, note: 1 });

console.log("Owner console tests passed");
