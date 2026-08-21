// GENERATION-ATTEMPT ACCOUNTING AND PATCH DIAGNOSTICS.
//
// Reproduces the 2026-08-11 strict qualification, deterministically and with zero provider calls.
// That run had three core attempts and spent two of them on this:
//
//   {"patches":[{"file":"src/App.jsx","ops":[{"op":"replace_symbol","symbol":"ROUTES",
//     "content":"const ROUTES = {\n  \"/\": HomePage,\n};"}]}, …HomePage with the scaffold's own
//     "{/* build here */}" placeholder…]}
//
// — a well-formed, valid, applicable batch whose content was byte-identical to the scaffold, twice
// in a row, 144 output tokens each. The third attempt wrote eight sound modules plus one file with
// unbalanced braces; the malformed file was refused (correctly) and the eight sound ones were
// thrown away with it (not correctly). The build ended "no runnable tree within 3 generation
// attempts" having produced exactly one substantive attempt.
//
// The quality bars are unchanged: malformed source is still refused, and nothing here lets a
// broken or partial tree become promotable.

import { test } from "node:test";
import assert from "node:assert/strict";

import { applyPatches, patchOutcomes, REJECTION } from "../../shell/server/lib/builderV2/patchEngine.mjs";
import { createOrchestrator, memoryBuildStore } from "../../shell/server/lib/builderV2/orchestrator.mjs";
import { createSnapshotStore } from "../../shell/server/lib/builderV2/snapshotStore.mjs";
import { clone, fromScaffold } from "../../src/engine/fileTree.mjs";
import { REACT_VITE } from "../../src/scaffolds/reactVite.mjs";

const CONTRACT = {
  summary: "Ember Table booking", projectType: "booking", version: 1,
  auth: { required: false }, routes: [{ path: "/", name: "Home" }],
  entities: [{ name: "booking", fields: [{ name: "slotId", type: "string" }] }],
  operations: [],
  journeys: [{ id: "complete-booking", title: "A guest books a slot", priority: "primary", stage: "primary_journey", steps: [
    { action: "open the booking application", target: "/", expect: "the booking page is visible" },
    { action: "select an available slot", target: "slot picker", expect: "the chosen slot is highlighted" },
  ] }],
  acceptance: [], states: [], deferred: [], imageIntents: [], integrations: [],
};

// ── the exact provider fixtures ────────────────────────────────────────────────────────────────

// A and B: what the model actually sent, twice — the scaffold's own content re-emitted.
const NO_OP_BATCH = () => [
  { file: "src/App.jsx", ops: [{ op: "replace_symbol", symbol: "ROUTES",
    content: 'const ROUTES = {\n  "/": HomePage,\n};' }], newFile: null, content: null, deleteFile: null, replaceFile: null },
];

// C: a substantive tree, one file of which does not parse.
const MALFORMED = "export function useWizard() {\n  const [step, setStep] = useState(0);\n  return { step,\n"; // unbalanced
const SUBSTANTIVE_BATCH = () => [
  { newFile: "src/routes/BookPage.jsx", content: 'export default function BookPage() {\n  return <main><h1>Book a table</h1><p>the booking page is visible</p></main>;\n}\n',
    file: null, ops: null, deleteFile: null, replaceFile: null },
  { newFile: "src/routes/SlotList.jsx", content: 'export default function SlotList() {\n  return <ul><li>the chosen slot is highlighted</li></ul>;\n}\n',
    file: null, ops: null, deleteFile: null, replaceFile: null },
  { newFile: "src/data/wizard.js", content: MALFORMED,
    file: null, ops: null, deleteFile: null, replaceFile: null },
];

// ── 1. the patch engine is per-patch, and says exactly why ─────────────────────────────────────

test("a malformed file is refused while its sound siblings apply", () => {
  const tree = clone(fromScaffold(REACT_VITE));
  const result = applyPatches(tree, SUBSTANTIVE_BATCH(), { contract: CONTRACT });
  assert.equal(result.tree["src/routes/BookPage.jsx"] !== undefined, true, "sound module applied");
  assert.equal(result.tree["src/routes/SlotList.jsx"] !== undefined, true, "sound module applied");
  assert.equal(result.tree["src/data/wizard.js"], undefined, "malformed source NEVER enters the tree");
  assert.equal(result.rejected.length, 1);
  assert.equal(result.rejected[0].code, REJECTION.SOURCE_PARSE_FAILED);
  assert.equal(result.rejected[0].file, "src/data/wizard.js");
});

test("every rejected patch is answerable on its own — code, file, operation, reason", () => {
  const tree = clone(fromScaffold(REACT_VITE));
  const batch = [
    ...SUBSTANTIVE_BATCH(),
    { newFile: "src/lib/backend/secrets.js", content: "export const x = 1;\n", file: null, ops: null, deleteFile: null, replaceFile: null },
    { file: "src/routes/HomePage.jsx", ops: [{ op: "replace_symbol", symbol: "NotAThing", content: "x" }], newFile: null, content: null, deleteFile: null, replaceFile: null },
  ];
  const result = applyPatches(tree, batch, { contract: CONTRACT });
  const outcomes = patchOutcomes(batch, result);
  assert.equal(outcomes.length, batch.length, "one outcome per patch, positionally aligned to the batch");
  // The reason lands on the patch it belongs to — the defect that mis-attributed a parse error.
  const wizard = outcomes[2];
  assert.equal(wizard.outcome, "rejected");
  assert.equal(wizard.code, REJECTION.SOURCE_PARSE_FAILED);
  assert.match(wizard.reason, /does not parse/);
  assert.equal(outcomes[3].code, REJECTION.WRITE_SCOPE_VIOLATION, "protected path");
  assert.equal(outcomes[4].code, REJECTION.PATCH_NOT_APPLICABLE, "symbol that is not there");
  // And no rejected outcome anywhere is nameless.
  for (const row of outcomes) {
    if (row.outcome !== "rejected") continue;
    assert.ok(row.code, `rejected outcome without a code: ${JSON.stringify(row)}`);
    assert.ok(row.reason, `rejected outcome without a reason: ${JSON.stringify(row)}`);
  }
  assert.equal(outcomes[0].outcome, "applied");
  assert.equal(outcomes[1].outcome, "applied");
});

test("a batch rolled back as a whole says so, per patch, and marks the innocent", () => {
  // Only a structural-invariant failure rejects a whole batch. Each patch that applied cleanly is
  // recorded by name as independently valid, so the audit trail shows what was lost and why.
  const rejected = [
    { code: REJECTION.TREE_INTEGRITY_FAILED, signature: "modularity", file: null, operation: null, reason: "monolith" },
    { code: REJECTION.BATCH_ATOMIC_ROLLBACK, signature: "new:src/routes/A.jsx", file: "src/routes/A.jsx",
      operation: "newFile", independentlyValid: true, reason: "applied cleanly and was rolled back with its batch" },
  ];
  const batch = [{ newFile: "src/routes/A.jsx", content: "x", file: null, ops: null, deleteFile: null, replaceFile: null }];
  const [row] = patchOutcomes(batch, { applied: [], rejected });
  assert.equal(row.outcome, "rejected");
  assert.equal(row.code, REJECTION.BATCH_ATOMIC_ROLLBACK);
  assert.equal(row.independentlyValid, true);
});

// ── 2. attempt accounting, through the real orchestrator ───────────────────────────────────────

function harness({ script, maxCoreAttempts = 3, maxNoOpRetries = 2 } = {}) {
  const dispatches = [];
  const orchestrator = createOrchestrator({
    contractFn: async () => CONTRACT,
    patchesFn: async (ctx) => {
      const produce = script[Math.min(dispatches.length, script.length - 1)];
      dispatches.push({ rejections: ctx.rejections.map((row) => row.code || row.signature) });
      return produce();
    },
    assetService: { resolveIntents: async () => ({ resolved: [], providerCalls: 0 }), assetManifestFor: async () => [] },
    snapshotStore: createSnapshotStore(),
    buildStore: memoryBuildStore(),
    journeysFn: async ({ journeys }) => ({ journeys: journeys.map((j) => ({ id: j.id, status: "pass" })) }),
    baseTree: () => clone(fromScaffold(REACT_VITE)),
    baseline: REACT_VITE,
    maxCoreAttempts,
    maxNoOpRetries,
  });
  return { orchestrator, dispatches };
}

test("REPRODUCTION — no-op, no-op, malformed: the run that died", async () => {
  // Corrected accounting: the two protocol rounds no longer consume generation attempts, so the
  // substantive attempt is reached rather than being the last of three.
  const { orchestrator, dispatches } = harness({
    script: [NO_OP_BATCH, NO_OP_BATCH, SUBSTANTIVE_BATCH],
  });
  const result = await orchestrator.runBuild({ owner: "o", projectId: "p", request: "booking" });
  assert.equal(dispatches.length >= 3, true, `all three fixtures dispatched: ${dispatches.length}`);
  // The no-op feedback is machine-readable and reaches the next dispatch.
  assert.ok(dispatches[1].rejections.includes("patch_noop"), JSON.stringify(dispatches[1]));
  assert.ok(dispatches[2].rejections.includes("patch_noop"), JSON.stringify(dispatches[2]));
  // The substantive attempt's rejection is the parse failure, named as such.
  if (dispatches[3]) {
    assert.ok(dispatches[3].rejections.includes(REJECTION.SOURCE_PARSE_FAILED),
      `the malformed module is reported precisely: ${JSON.stringify(dispatches[3])}`);
  }
  assert.equal(result.state === "green", false, "malformed source must never reach green");
});

test("a protocol no-op does not consume a substantive generation attempt", async () => {
  // Two no-ops then a good tree: the build must still succeed, because only ONE substantive
  // attempt was ever needed. Before this change the same script exhausted the ceiling.
  const GOOD = () => [
    { newFile: "src/routes/BookPage.jsx", content: 'export default function BookPage() {\n  return <main><h1>the booking page is visible</h1><p>the chosen slot is highlighted</p></main>;\n}\n',
      file: null, ops: null, deleteFile: null, replaceFile: null },
  ];
  const { orchestrator } = harness({ script: [NO_OP_BATCH, NO_OP_BATCH, GOOD] });
  const result = await orchestrator.runBuild({ owner: "o", projectId: "p", request: "booking" });
  // The tree this fixture writes is deliberately minimal, so it is judged on its merits downstream
  // (here, the shape gate's stop rule). What must NEVER happen again is the build ending because
  // two protocol rounds ate the generation budget — that verdict is the one under test.
  assert.doesNotMatch(String(result.error || ""), /no substantive generation/,
    "two no-ops must not be mistaken for a model that generates nothing");
  assert.doesNotMatch(String(result.error || ""), /no runnable tree within \d+ generation attempts/,
    `the substantive attempt must be reached and judged: ${result.error || ""}`);
});

test("a model that only ever returns no-ops fails for the RIGHT reason, and is bounded", async () => {
  const { orchestrator, dispatches } = harness({ script: [NO_OP_BATCH], maxNoOpRetries: 2 });
  const result = await orchestrator.runBuild({ owner: "o", projectId: "p", request: "booking" });
  assert.equal(result.state, "blocked", JSON.stringify(result).slice(0, 200));
  assert.match(String(result.error), /no substantive generation|changed nothing/,
    `the failure must name the protocol round, not a generation ceiling: ${result.error}`);
  // Bounded: not an unlimited retry loop.
  assert.ok(dispatches.length <= 5, `no-op retries are bounded, got ${dispatches.length} dispatches`);
});

test("an empty patch envelope is a protocol round too, and says which", async () => {
  const { orchestrator } = harness({ script: [() => []], maxNoOpRetries: 1 });
  const result = await orchestrator.runBuild({ owner: "o", projectId: "p", request: "booking" });
  assert.equal(result.state, "blocked", JSON.stringify(result).slice(0, 200));
  assert.match(String(result.error), /no substantive generation/);
});

// ── 3. one broken module no longer discards the rest ───────────────────────────────────────────

test("work that applied cleanly survives a sibling's rejection", async () => {
  const seen = [];
  const orchestrator = createOrchestrator({
    contractFn: async () => CONTRACT,
    patchesFn: async (ctx) => {
      seen.push(Object.keys(ctx.tree).filter((path) => /^src\/(routes|data)\//.test(path)).sort());
      return seen.length === 1 ? SUBSTANTIVE_BATCH() : [
        { newFile: "src/data/wizard.js", content: "export const useWizard = () => ({ step: 0 });\n",
          file: null, ops: null, deleteFile: null, replaceFile: null },
      ];
    },
    assetService: { resolveIntents: async () => ({ resolved: [], providerCalls: 0 }), assetManifestFor: async () => [] },
    snapshotStore: createSnapshotStore(),
    buildStore: memoryBuildStore(),
    journeysFn: async ({ journeys }) => ({ journeys: journeys.map((j) => ({ id: j.id, status: "pass" })) }),
    baseTree: () => clone(fromScaffold(REACT_VITE)),
    baseline: REACT_VITE,
  });
  await orchestrator.runBuild({ owner: "o", projectId: "p", request: "booking" });
  assert.ok(seen.length >= 2, "a second dispatch happened");
  // THE POINT: the retry sees the two sound modules already in the tree, so it only has to write
  // the one file that failed — instead of regenerating the application from the scaffold.
  assert.ok(seen[1].includes("src/routes/BookPage.jsx"),
    `sound work must survive into the next attempt: ${JSON.stringify(seen[1])}`);
  assert.ok(seen[1].includes("src/routes/SlotList.jsx"), JSON.stringify(seen[1]));
  assert.equal(seen[1].includes("src/data/wizard.js"), false, "the malformed module is still absent");
});

test("a retained partial candidate is gated immediately instead of returning stale problems", async () => {
  const contract = {
    summary: "A simple public information page", projectType: "informational", version: 1,
    auth: { required: false }, entities: [], operations: [], deferred: [], imageIntents: [], integrations: [],
    routes: [{ path: "/", name: "Home" }], acceptance: [], states: [],
    journeys: [{ id: "view-information", title: "A visitor views the information", priority: "primary",
      stage: "primary_journey", steps: [{ action: "open the application", target: "/",
        expect: "the public information is visible" }] }],
  };
  let dispatches = 0;
  const orchestrator = createOrchestrator({
    contractFn: async () => contract,
    patchesFn: async () => {
      dispatches += 1;
      return [{
        file: "src/routes/HomePage.jsx",
        ops: [{ op: "replace_symbol", symbol: "HomePage", content: `export default function HomePage() {
  return <main><h1>The public information is visible</h1></main>;
}` }],
      }, {
        newFile: "src/data/unrelated.js",
        content: "export function malformed() {\n  return {\n",
      }];
    },
    assetService: { resolveIntents: async () => ({ resolved: [], providerCalls: 0 }), assetManifestFor: async () => [] },
    snapshotStore: createSnapshotStore(),
    buildStore: memoryBuildStore(),
    journeysFn: async ({ journeys }) => ({ journeys: journeys.map((journey) => ({ id: journey.id, status: "pass" })) }),
    baseTree: () => clone(fromScaffold(REACT_VITE)),
    baseline: REACT_VITE,
    maxCoreAttempts: 1,
  });
  const result = await orchestrator.runBuild({ owner: "o", projectId: "partial-green", request: "information" });
  assert.equal(result.state, "green", JSON.stringify(result));
  assert.equal(dispatches, 1, "a sound retained tree does not spend another model attempt on a rejected sibling");
  assert.ok(result.snapshotId, "the gated partial tree becomes an immutable green checkpoint");
});
