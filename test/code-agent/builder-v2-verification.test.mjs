// WP-3 — verification facade parity, attribution discipline, and differential reuse,
// proven on the real modular production tree.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runStageGate } from "../../shell/server/lib/appBuild/stageGate.mjs";
import { indexTree } from "../../shell/server/lib/builderV2/indexerV0.mjs";
import { memoryGraph } from "../../shell/server/lib/builderV2/graphStore.mjs";
import {
  verifyStage, attributeFailures, ownersHashOf,
  memoryVerificationCache, planJourneyVerification, recordJourneyVerdicts,
} from "../../shell/server/lib/builderV2/verification.mjs";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const TREE = JSON.parse(readFileSync(path.join(FIXTURES, "run17b6513f-tree.json"), "utf8"));
const CONTRACT = JSON.parse(readFileSync(path.join(FIXTURES, "cf130c23", "contract.json"), "utf8"));
const graph = memoryGraph("o", "p", indexTree(TREE));
const okCompile = async () => ({ ok: true, stderr: "" });

test("WP3 — the facade NEVER drifts from the gate: identical checks and problems", async () => {
  const options = { contract: CONTRACT, stage: { id: "data", journeys: [] }, compile: okCompile };
  const direct = await runStageGate({ ...TREE }, options);
  const facade = await verifyStage({ ...TREE }, options);
  assert.equal(facade.ok, direct.ok);
  assert.deepEqual(facade.layers.d0d2.checks, direct.checks);
  assert.deepEqual(facade.layers.d0d2.problems, direct.problems);
});

test("WP3 — a failure attributed to no owning module DOWNGRADES to warn, with the reason", () => {
  const results = { journeys: [
    { id: "reserve-picking-slot", title: "reserve", status: "fail", priority: "primary" },
    { id: "ghost-journey", title: "nothing owns this", status: "fail", priority: "secondary" },
    { id: "browse-visitor-information", title: "browse", status: "pass", priority: "secondary" },
  ] };
  const contract = { journeys: [
    { id: "reserve-picking-slot", title: "A visitor reserves an available strawberry picking slot", entities: ["booking"] },
    { id: "ghost-journey", title: "zzqx qqzy unownable", entities: [] },
    { id: "browse-visitor-information", title: "A visitor plans their farm visit" },
  ] };
  const attributed = attributeFailures(results, graph, contract);
  const reserve = attributed.find((j) => j.id === "reserve-picking-slot");
  assert.equal(reserve.status, "fail", "an attributable failure stays a failure");
  assert.ok(reserve.owners.length > 0, `owners: ${reserve.owners.join(", ")}`);
  const ghost = attributed.find((j) => j.id === "ghost-journey");
  assert.equal(ghost.status, "warn", "unattributable failures cannot brief a repair — they warn");
  assert.match(ghost.downgraded, /no owning module/);
});

test("WP3 — owners hash moves with owning-module content and nothing else", () => {
  const journey = { id: "reserve-picking-slot", title: "A visitor reserves an available strawberry picking slot", entities: ["booking"] };
  const before = ownersHashOf(journey, graph);
  assert.equal(ownersHashOf(journey, graph), before, "stable for identical content");

  const edited = { ...TREE };
  edited["src/data/bookings.js"] = `// touched\n${edited["src/data/bookings.js"]}`;
  const editedGraph = memoryGraph("o", "p", indexTree(edited));
  assert.notEqual(ownersHashOf(journey, editedGraph), before, "owning-module edits move the hash");

  const unrelated = { ...TREE };
  unrelated["src/routes/FarmPage.jsx"] = `// touched\n${unrelated["src/routes/FarmPage.jsx"]}`;
  const unrelatedGraph = memoryGraph("o", "p", indexTree(unrelated));
  assert.equal(ownersHashOf(journey, unrelatedGraph), before, "unrelated edits do not");
});

test("WP3 — verify twice: the second pass drives ZERO journeys, reuses five, and says so", async () => {
  const cache = memoryVerificationCache();
  const first = await planJourneyVerification({ owner: "o", projectId: "p", contract: CONTRACT, graph, cache });
  assert.equal(first.drive.length, CONTRACT.journeys.length, "cold cache drives everything");
  assert.equal(first.reused.length, 0);

  // All five pass on the drive; verdicts recorded.
  await recordJourneyVerdicts({
    owner: "o", projectId: "p", cache, plan: first, snapshotId: "snap-1",
    results: { journeys: CONTRACT.journeys.map((j) => ({ id: j.id, status: "pass", failedSteps: 0 })) },
  });

  const second = await planJourneyVerification({ owner: "o", projectId: "p", contract: CONTRACT, graph, cache });
  assert.equal(second.drive.length, 0, "unchanged owners → nothing to drive");
  assert.equal(second.reused.length, CONTRACT.journeys.length);
  assert.match(second.summary, /drive 0, reuse 5/);
  for (const row of second.reused) {
    assert.ok(row.verdict && row.ownersHash && row.evidenceSnapshot, "reuse carries its evidence");
  }
});

test("WP3 — cached FAILURES are never reused, and owning-module edits invalidate reuse", async () => {
  const cache = memoryVerificationCache();
  const plan = await planJourneyVerification({ owner: "o", projectId: "p", contract: CONTRACT, graph, cache });
  await recordJourneyVerdicts({
    owner: "o", projectId: "p", cache, plan, snapshotId: "snap-1",
    results: { journeys: CONTRACT.journeys.map((j, i) => ({ id: j.id, status: i === 0 ? "fail" : "pass", failedSteps: i === 0 ? 2 : 0 })) },
  });

  const again = await planJourneyVerification({ owner: "o", projectId: "p", contract: CONTRACT, graph, cache });
  assert.ok(again.drive.some((d) => d.journey.id === CONTRACT.journeys[0].id),
    "a cached failure re-drives — a fixed build must never be blocked by stale evidence");
  assert.equal(again.reused.length, CONTRACT.journeys.length - 1);

  // Edit an owning module of a PASSING journey: its reuse invalidates too.
  const edited = { ...TREE };
  edited["src/data/newsletterSubscribers.js"] = `// touched\n${edited["src/data/newsletterSubscribers.js"]}`;
  const editedGraph = memoryGraph("o", "p", indexTree(edited));
  const afterEdit = await planJourneyVerification({ owner: "o", projectId: "p", contract: CONTRACT, graph: editedGraph, cache });
  assert.ok(afterEdit.drive.some((d) => d.journey.id === "newsletter-signup"),
    "the newsletter journey re-drives after its data module changed");
});

// ── WP-11 live evidence: a compile failure's brief must carry the compiler's own words ────────

test("a failing compile surfaces the stderr excerpt in problems — repairs are never briefed blind", async () => {
  const tree = { ...structuredClone(TREE) };
  const failed = await verifyStage(tree, {
    contract: CONTRACT, stage: { id: "data", journeys: [] },
    compile: async () => ({ ok: false, stderr: "src/routes/BookPage.jsx:41:7 error: 'slots' is not defined\n  at renderSlots" }),
  });
  assert.equal(failed.ok, false);
  assert.ok(failed.layers.d0d2.problems.some((p) => /the project does not compile/.test(p)));
  assert.ok(failed.layers.d0d2.problems.some((p) => /compiler output:/.test(p) && /'slots' is not defined/.test(p)),
    JSON.stringify(failed.layers.d0d2.problems));
});
