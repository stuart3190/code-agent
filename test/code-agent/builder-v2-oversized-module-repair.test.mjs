// AN OVERSIZED MODULE MUST STILL BE REPAIRABLE.
//
// `applyPatches` re-checks modularity over every changed file and rejects the WHOLE batch when a
// structural invariant breaks. That rule exists to stop a batch re-monolithing a modular tree, and
// it is right — but applied to a file that was ALREADY over the limit it became a trap with no
// exit. A production build on 2026-08-20 spent 23 repair dispatches and produced 2 browser
// verdicts: every patch to the oversized flow component was discarded, however correct, because
// the file it was fixing was too big. The file could not be fixed, could not be shrunk, and could
// never go green.
//
// The rule now judges the DELTA. A violation the batch inherited does not condemn it; a violation
// the batch creates or worsens still does.

import test from "node:test";
import assert from "node:assert/strict";

import { applyPatches } from "../../shell/server/lib/builderV2/patchEngine.mjs";
import { FILE_MAX_TOKENS } from "../../shell/server/lib/appBuild/modularity.mjs";

const CONTRACT = {
  summary: "A planner",
  entities: [{ name: "project" }],
  journeys: [{ id: "plan", title: "Plan a room", priority: "primary", steps: [] }],
};

const FLOW = "src/components/plan/PlanFlow.jsx";

/** A module comfortably over the size limit, in the shape the builder actually produces. */
function oversized(marker = "original") {
  // Fixed width: two variants must differ in CONTENT, not in size, or the delta rule correctly
  // reads the difference as growth rather than as a repair.
  marker = String(marker).padEnd(12, ".").slice(0, 12);
  const filler = Array.from({ length: 900 }, (_, index) =>
    `  const value${index} = compute(${index}); // ${marker} padding line ${index}`).join("\n");
  return `import React, { useState } from "react";

export default function PlanFlow() {
  const [state, setState] = useState({});
${filler}
  return <main><h1>Plan</h1></main>;
}
`;
}

const tokensOfSource = (source) => Math.ceil(source.length / 4);

test("the fixture really is over the modularity limit", () => {
  assert.ok(tokensOfSource(oversized()) > FILE_MAX_TOKENS,
    `fixture is ${tokensOfSource(oversized())} tokens, needs to exceed ${FILE_MAX_TOKENS}`);
});

test("a repair to an ALREADY oversized module lands instead of being discarded", () => {
  const tree = { [FLOW]: oversized("original") };
  // The exact shape of a real repair: replace the component body to fix a control.
  const patched = oversized("repaired");
  const result = applyPatches(tree, [{ replaceFile: FLOW, content: patched }], { contract: CONTRACT });

  assert.equal(result.modularityFailed, false, "an inherited size violation must not reject the batch");
  assert.equal(result.tree[FLOW], patched, "the repair actually landed in the tree");
  assert.ok(result.applied.length, "the operation is recorded as applied");
  // …and the pre-existing problem is handed back as work to do, not silently dropped.
  assert.ok((result.inheritedStructuralProblems || []).some((problem) => problem.includes(FLOW)),
    `the inherited violation is reported: ${JSON.stringify(result.inheritedStructuralProblems)}`);
});

test("a batch that makes an oversized module even bigger is still rejected", () => {
  const tree = { [FLOW]: oversized("original") };
  const bigger = `${oversized("original")}\n${Array.from({ length: 200 },
    (_, index) => `// additional bloat ${index}`).join("\n")}\n`;
  const result = applyPatches(tree, [{ replaceFile: FLOW, content: bigger }], { contract: CONTRACT });

  assert.equal(result.modularityFailed, true, "worsening an inherited violation is still a rejection");
  assert.deepEqual(result.tree, tree, "the tree is left untouched");
});

test("a batch that pushes a COMPLIANT module over the limit is still rejected", () => {
  const small = `import React from "react";\nexport default function PlanFlow() { return <main>Plan</main>; }\n`;
  const tree = { [FLOW]: small };
  const result = applyPatches(tree, [{ replaceFile: FLOW, content: oversized("new monolith") }],
    { contract: CONTRACT });

  assert.equal(result.modularityFailed, true, "creating a new violation is rejected exactly as before");
  assert.deepEqual(result.tree, tree);
  assert.ok(result.structuralProblems.some((problem) => problem.includes(FLOW)));
});

test("splitting an oversized module into compliant siblings is accepted", () => {
  // The remedy the brief now asks for: the flow becomes small and the work moves to siblings.
  const tree = { [FLOW]: oversized("original") };
  const shell = `import React from "react";\nimport StepOne from "./StepOne.jsx";\n`
    + `export default function PlanFlow() { return <main><StepOne /></main>; }\n`;
  const step = `import React from "react";\nexport default function StepOne() { return <section>Step one</section>; }\n`;
  const result = applyPatches(tree, [
    { replaceFile: FLOW, content: shell },
    { newFile: "src/components/plan/StepOne.jsx", content: step },
  ], { contract: CONTRACT });

  assert.equal(result.modularityFailed, false, "the split must be accepted");
  assert.equal(result.tree[FLOW], shell);
  assert.equal(result.tree["src/components/plan/StepOne.jsx"], step);
  assert.ok(!(result.inheritedStructuralProblems || []).length,
    "and once split there is no inherited problem left to report");
});

// ── and the model is actually told to split it ────────────────────────────────────────────────

test("the repair brief carries a split instruction naming the oversized module", async () => {
  const { createOrchestrator, memoryBuildStore } = await import("../../shell/server/lib/builderV2/orchestrator.mjs");
  const { createSnapshotStore } = await import("../../shell/server/lib/builderV2/snapshotStore.mjs");
  const { fromScaffold } = await import("../../src/engine/fileTree.mjs");
  const { REACT_VITE } = await import("../../src/scaffolds/reactVite.mjs");

  const contract = {
    summary: "A planner", entities: [{ name: "project" }],
    operations: [{ id: "save-project", entity: "project", action: "create", journey: "plan" }],
    routes: [{ path: "/", name: "Plan" }], auth: { required: false },
    journeys: [{ id: "plan", title: "Plan a room", priority: "primary", steps: [
      { action: "enter the room size", target: "roomSize", expect: "the size is held" },
    ] }],
  };
  const seen = [];
  const orchestrator = createOrchestrator({
    contractFn: async () => contract,
    patchesFn: async (input) => {
      seen.push(input);
      // Every dispatch edits the monolith without shrinking it — the production shape.
      return [{ replaceFile: FLOW, content: oversized(`round-${seen.length}`) }];
    },
    assetService: { async resolveIntents() { return { resolved: [], providerCalls: 0 }; },
      async assetManifestFor() { return []; } },
    snapshotStore: createSnapshotStore(),
    buildStore: memoryBuildStore(),
    // The oversized module ALREADY EXISTS — in production it arrives via the retained
    // provisional candidate after the core batch broke the structural rule. Repairs to it must land.
    baseTree: () => ({ ...fromScaffold(REACT_VITE), [FLOW]: oversized("seed") }),
    baseline: REACT_VITE,
    compile: async () => ({ ok: true }),
    journeysFn: async ({ journeys }) => ({
      journeys: journeys.map((journey) => ({ id: journey.id, title: journey.title,
        priority: journey.priority, status: "fail", owners: [FLOW],
        steps: [{ action: "enter the room size", expect: "the size is held", status: "fail",
          drove: true, detail: "the size was not held" }] })),
      blockingErrors: [],
    }),
    events: {}, log: () => {},
  });
  await orchestrator.runBuild({ owner: "o", projectId: "p", request: "planner", maxRepairs: 2 });

  const briefed = seen.filter((input) => (input.advisory || [])
    .some((finding) => finding.code === "oversized_module_must_be_split"));
  assert.ok(briefed.length, `no split instruction reached any dispatch: ${
    JSON.stringify(seen.map((input) => (input.advisory || []).map((a) => a.code)))}`);
  const finding = briefed[0].advisory.find((row) => row.code === "oversized_module_must_be_split");
  assert.equal(finding.module, FLOW, "the instruction names the file to split");
  assert.match(finding.message, /Split it NOW/);
  assert.match(finding.message, /own module/);
  // Issued once, not re-appended every round.
  const perDispatch = seen.map((input) => (input.advisory || [])
    .filter((row) => row.code === "oversized_module_must_be_split").length);
  assert.ok(Math.max(...perDispatch, 0) <= 1, `the instruction is not duplicated: ${perDispatch}`);
});
