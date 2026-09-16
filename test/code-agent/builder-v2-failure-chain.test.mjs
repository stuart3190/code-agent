import assert from "node:assert/strict";
import { test } from "node:test";

import { describeErrorChain, structuredBuildFailure } from "../../shell/server/lib/builderV2/buildFailure.mjs";
import { serialiseWorkerFailure } from "../../build-worker/queue.mjs";

// The 2026-09-16 advanced qualification: a provider rejection wrapped by a settlement failure,
// recorded everywhere as "terminal accounting could not be completed" and nothing else.
function productionShapedFailure() {
  const provider = Object.assign(new Error("Codex responses HTTP 401: token_expired"), { code: "provider_rejected" });
  const settlement = new Error("settle terminal: reservation 79b3056e is not held");
  return Object.assign(new AggregateError([provider, settlement],
    "Builder V2 failed and terminal accounting could not be completed"), { code: "terminal_settlement_failed" });
}

test("an error chain is described outermost first with every member and cause", () => {
  const described = describeErrorChain(productionShapedFailure());
  assert.equal(described, [
    "Builder V2 failed and terminal accounting could not be completed [terminal_settlement_failed]",
    "  Codex responses HTTP 401: token_expired [provider_rejected]",
    "  settle terminal: reservation 79b3056e is not held",
  ].join("\n"));
  const withCause = new Error("outer", { cause: new Error("inner") });
  assert.equal(describeErrorChain(withCause), "outer\n  inner");
  assert.equal(describeErrorChain(new Error("plain")), "plain");
  assert.equal(describeErrorChain("just a string"), "just a string");
});

test("a cyclic or oversized chain is bounded", () => {
  const a = new Error("a");
  const b = new Error("b", { cause: a });
  a.cause = b;
  assert.equal(describeErrorChain(a), "a\n  b");
  const wide = new AggregateError(Array.from({ length: 20 }, (_, i) => new Error(`m${i}`)), "wide");
  assert.equal(describeErrorChain(wide).split("\n").length, 6);
});

test("structured and worker failure records carry the whole chain in internalDetail", () => {
  const error = productionShapedFailure();
  const structured = structuredBuildFailure(error);
  assert.match(structured.internalDetail, /token_expired/);
  assert.match(structured.internalDetail, /not held/);
  assert.equal(structured.classification, "accounting");
  const worker = serialiseWorkerFailure(error, "accounting");
  assert.equal(worker.message, "Builder V2 failed and terminal accounting could not be completed");
  assert.match(worker.internalDetail, /token_expired/);
  assert.equal(structuredBuildFailure(error, { internalDetail: "explicit" }).internalDetail, "explicit");
});
