// Context Retrieval Engine (K) — proven on the real modular production tree, against the
// exact wasteful shapes the 46.10/32.65-credit runs paid for.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { indexTree, tokensOf } from "../../shell/server/lib/builderV2/indexerV0.mjs";
import { memoryGraph } from "../../shell/server/lib/builderV2/graphStore.mjs";
import { retrieve } from "../../shell/server/lib/builderV2/retrieval.mjs";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const TREE = JSON.parse(readFileSync(path.join(FIXTURES, "run17b6513f-tree.json"), "utf8"));
const graph = memoryGraph("o", "p", indexTree(TREE));

test("K — a selected-date defect loads the selector and its caller, not App.jsx, not the world", () => {
  const result = retrieve({
    graph, tree: TREE,
    failureRefs: ["src/components/BookingSlotSelector.jsx"],
    budgetTokens: 12_000,
  });
  const fullPaths = result.full.map((f) => f.path);
  assert.ok(fullPaths.includes("src/components/BookingSlotSelector.jsx"), "the named module in full");
  const included = [...result.full, ...result.interfaces].map((f) => f.path);
  assert.ok(included.includes("src/routes/BookPage.jsx"), "its caller rides along");
  assert.ok(!fullPaths.includes("src/App.jsx"), "the shell body does NOT");
  assert.ok(!included.includes("src/routes/FarmPage.jsx"), "unrelated screens stay out entirely");
  assert.ok(result.tokens <= result.budget);
  // Every inclusion is traced with form, score and reason.
  for (const row of result.trace.included) {
    assert.ok(row.form && row.reason && typeof row.score === "number" && row.tokens > 0);
  }
});

test("K — the data-stage-shaped query fits in a fraction of what the live run paid", () => {
  // Run 17b6513f's data stage opened at 13,323 tokens and the 46-run's at 23,993. The same
  // intent — write the three data modules against the SDK — retrieved by graph:
  const result = retrieve({
    graph, tree: TREE,
    targets: ["src/data/bookings.js", "src/data/slots.js", "src/data/newsletterSubscribers.js"],
    capabilityPaths: ["src/lib/backend/index.js", "src/lib/visitorSession.js"],
    journeys: [{ id: "reserve-picking-slot", title: "A visitor reserves an available strawberry picking slot", entities: ["booking"] }],
    budgetTokens: 12_000,
  });
  assert.ok(result.tokens <= 12_000, `hard budget holds: ${result.tokens}`);
  assert.ok(result.tokens < 9_000, `materially under the 13,323/23,993 the live runs paid: ${result.tokens}`);
  const fullPaths = result.full.map((f) => f.path);
  for (const target of ["src/data/bookings.js", "src/data/slots.js", "src/data/newsletterSubscribers.js"]) {
    assert.ok(fullPaths.includes(target), `${target} in full`);
  }
  // The SDK SURFACE arrives as an interface/body by capability rank — the implementation never does.
  const everywhere = [...result.full, ...result.interfaces, ...result.summaries].map((f) => f.path);
  assert.ok(everywhere.includes("src/lib/backend/index.js"));
  assert.ok(!result.full.map((f) => f.path).includes("src/lib/backend/supabaseBackend.js"),
    "the protected implementation is never a body");
});

test("K — the budget is HARD: demotion by ascending score, recorded, never silent truncation", () => {
  const result = retrieve({
    graph, tree: TREE,
    targets: ["src/routes/BookPage.jsx"],
    budgetTokens: Math.min(1_200, tokensOf(TREE["src/routes/BookPage.jsx"]) + 300),
  });
  assert.ok(result.tokens <= result.budget, `${result.tokens} <= ${result.budget}`);
  const demoted = [...result.interfaces, ...result.summaries].filter((f) => f.demoted);
  assert.ok(demoted.length > 0, "what could not fit as a body is PRESENT in a smaller form, flagged demoted");
  // Determinism: identical queries return byte-identical traces.
  const again = retrieve({
    graph, tree: TREE,
    targets: ["src/routes/BookPage.jsx"],
    budgetTokens: Math.min(1_200, tokensOf(TREE["src/routes/BookPage.jsx"]) + 300),
  });
  assert.deepEqual(again.trace, result.trace);
});

test("K — planned-but-absent target paths carry nothing and break nothing", () => {
  const result = retrieve({
    graph, tree: TREE,
    targets: ["src/data/toBeCreated.js", "src/data/bookings.js"],
    budgetTokens: 12_000,
  });
  assert.ok(result.full.some((f) => f.path === "src/data/bookings.js"));
  assert.ok(!result.trace.included.some((f) => f.path === "src/data/toBeCreated.js"));
});
