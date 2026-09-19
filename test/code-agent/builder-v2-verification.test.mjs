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
  verifyStage, attributeFailures, boundedAttributionFallback, ownersHashOf,
  verificationCacheIdentity, memoryVerificationCache, supabaseVerificationCache,
  planJourneyVerification, recordJourneyVerdicts,
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

test("C2 — a failure attributed to no owning module stays blocking and records a platform defect", () => {
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
  assert.equal(ghost.status, "fail", "attribution failure must never make an essential journey green");
  assert.equal(ghost.attributionStatus, "missing");
  assert.equal(ghost.attributionDefect.code, "journey_ownership_missing");
  assert.match(ghost.attributionDefect.message, /no owning module/);
  assert.ok(ghost.fallbackRefs.length > 0, "repair receives fallback context instead of a downgraded verdict");
});

test("C2 — attribution fallback is deterministic, broad and strictly bounded", () => {
  const first = boundedAttributionFallback(graph, { maxFiles: 8, maxTokens: 1_500 });
  const second = boundedAttributionFallback(graph, { maxFiles: 8, maxTokens: 1_500 });
  assert.deepEqual(first, second);
  assert.ok(first.length > 0 && first.length <= 8);
  assert.ok(first.some((p) => /^src\//.test(p)), first.join(", "));
  const used = first.reduce((sum, p) => sum + Number(graph.file(p)?.tokens || 0), 0);
  assert.ok(used <= 1_500, `fallback used ${used} tokens`);
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
    assert.equal(row.reuseReason, "complete cache identity matched and original verdict passed");
    assert.deepEqual(row.originalEvidence, row.verdict);
    assert.equal(row.verdict.cacheIdentity.journeyId, row.journeyId);
  }
});

test("C3 — cache identity moves with journey, contract, transitive dependencies and runtime config", () => {
  const journey = CONTRACT.journeys.find((j) => j.id === "reserve-picking-slot");
  const before = verificationCacheIdentity({ journey, contract: CONTRACT, graph });
  assert.ok(before.cacheable && before.owners.length > 0);
  assert.ok(before.components.transitiveDependencyClosure.some((f) => f.path === "src/lib/utils.js"));
  assert.ok(before.components.capabilityVersions.length > 0);
  assert.ok(before.components.runtimeFiles.length > 0);

  const dependencyEdit = { ...TREE, "src/lib/utils.js": `// changed dependency\n${TREE["src/lib/utils.js"]}` };
  const dependencyGraph = memoryGraph("o", "p", indexTree(dependencyEdit));
  assert.equal(ownersHashOf(journey, dependencyGraph), ownersHashOf(journey, graph), "direct owners did not change");
  assert.notEqual(verificationCacheIdentity({ journey, contract: CONTRACT, graph: dependencyGraph }).key, before.key,
    "a changed transitive dependency invalidates reuse");

  const changedJourney = { ...journey, steps: [...journey.steps, { action: "reload", expect: "reservation persists" }] };
  assert.notEqual(verificationCacheIdentity({ journey: changedJourney, contract: CONTRACT, graph }).key, before.key);
  assert.notEqual(verificationCacheIdentity({ journey, contract: { ...CONTRACT, summary: "changed contract" }, graph }).key, before.key);
  assert.notEqual(verificationCacheIdentity({
    journey, contract: CONTRACT, graph, context: { configVersion: "journey-verification-config/2" },
  }).key, before.key);
});

test("C3 — zero-owner journeys are never read from or written to cache", async () => {
  let gets = 0;
  let puts = 0;
  const cache = {
    async get() { gets += 1; return { verdict: { status: "pass" } }; },
    async put() { puts += 1; },
  };
  const ghost = { id: "zzqx-ghost", title: "Qqzy unowned", priority: "primary", steps: [] };
  const contract = { ...CONTRACT, journeys: [ghost] };
  const plan = await planJourneyVerification({ owner: "o", projectId: "p", contract, graph, cache });
  assert.equal(gets, 0, "an empty owner set cannot look up the shared empty hash");
  assert.equal(plan.drive.length, 1);
  assert.equal(plan.drive[0].cacheable, false);
  await recordJourneyVerdicts({
    owner: "o", projectId: "p", cache, plan, snapshotId: "snap",
    results: { journeys: [{ id: ghost.id, status: "pass" }] },
  });
  assert.equal(puts, 0, "even a pass with zero owners is never cached");
});

test("C3 — cache retention and explicit invalidation are deterministic", async () => {
  let clock = Date.parse("2026-08-06T00:00:00Z");
  const cache = memoryVerificationCache({ retentionMs: 1_000, now: () => clock });
  await cache.put("o", "p", "j1", "h1", { status: "pass" }, "snap-1");
  await cache.put("o", "p", "j2", "h2", { status: "pass" }, "snap-2");
  assert.ok(await cache.get("o", "p", "j1", "h1"));
  assert.equal(await cache.invalidate("o", "p", "j1"), 1);
  assert.equal(await cache.get("o", "p", "j1", "h1"), null);
  clock += 1_001;
  assert.equal(await cache.prune(), 1);
  assert.equal(await cache.get("o", "p", "j2", "h2"), null);
});

test("C3 — Supabase cache applies retention on reads and exposes scoped invalidation/pruning", async () => {
  const calls = [];
  const client = {
    from(table) {
      const api = {
        select(columns) { calls.push(["select", table, columns]); return api; },
        eq(column, value) { calls.push(["eq", column, value]); return api; },
        gte(column, value) { calls.push(["gte", column, value]); return api; },
        lt(column, value) { calls.push(["lt", column, value]); return api; },
        upsert(payload, options) { calls.push(["upsert", payload, options]); return Promise.resolve({ error: null }); },
        delete(options) { calls.push(["delete", options]); return api; },
        maybeSingle() { return Promise.resolve({ data: { verdict: { status: "pass" }, snapshot_id: "s", created_at: "now" }, error: null }); },
        then(resolve, reject) { return Promise.resolve({ error: null, count: 2 }).then(resolve, reject); },
      };
      return api;
    },
  };
  const now = Date.parse("2026-08-06T00:00:00Z");
  const cache = supabaseVerificationCache(client, { retentionMs: 1_000, now: () => now });
  assert.ok(await cache.get("o", "p", "j", "h"));
  assert.deepEqual(calls.find((call) => call[0] === "gte"), ["gte", "created_at", "2026-08-05T23:59:59.000Z"]);
  await cache.put("o", "p", "j", "h", { status: "pass" }, "s");
  const upsert = calls.find((call) => call[0] === "upsert");
  assert.equal(upsert[1].created_at, "2026-08-06T00:00:00.000Z");
  assert.equal(await cache.invalidate("o", "p", "j"), 2);
  assert.ok(calls.some((call) => call[0] === "delete" && call[1]?.count === "exact"));
  assert.equal(await cache.prune(), 2);
  assert.ok(calls.some((call) => call[0] === "lt" && call[1] === "created_at"));
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
