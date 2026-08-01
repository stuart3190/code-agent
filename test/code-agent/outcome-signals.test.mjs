// Outcome signal producers.
//
// scripts/feature-health.mjs reported "outcome learning signals: NEVER" — the endpoint and
// recordBuildSignal both worked, but nothing had ever posted a signal, so the User Success Score
// and the outcome-weighted ranking were permanently inert.
//
// These producers emit only from events that ALREADY happen server-side, where the outcome is a
// fact rather than an inference. No client-side behaviour tracking is involved, so there is no
// telemetry beacon and no new privacy surface.

process.env.CODE_AGENT_STORE = "memory";

import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  SIGNALS, recordBuildSignal, signalBuildOutcome, latestBuildIdForProject,
  deriveOutcome, summariseOutcomes, userSuccessScore,
} from "../../shell/server/lib/buildOutcomes.mjs";

const read = (rel) => readFile(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

// Stand-in for diag_runs + build_signals, including the unique (build_id, signal) index.
function fakeDb({ runs = [], failInsert = false } = {}) {
  const signals = [];
  return {
    signals,
    from(table) {
      const filters = {};
      const api = {
        select() { return api; },
        eq(column, value) { filters[column] = value; return api; },
        order() { return api; },
        limit() { return api; },
        maybeSingle: async () => {
          if (table !== "diag_runs") return { data: null, error: null };
          const match = runs
            .filter((r) => r.owner === filters.owner && r.project_id === filters.project_id)
            .sort((a, b) => (a.started_at < b.started_at ? 1 : -1))[0];
          return { data: match ? { id: match.id } : null, error: null };
        },
        insert(row) {
          if (failInsert) return Promise.resolve({ error: { message: "storage unavailable" } });
          // The production unique index on (build_id, signal).
          if (signals.some((s) => s.build_id === row.build_id && s.signal === row.signal)) {
            return Promise.resolve({ error: { message: 'duplicate key value violates unique constraint' } });
          }
          signals.push(row);
          return Promise.resolve({ error: null });
        },
      };
      return api;
    },
  };
}

const RUN = { id: "build-1", owner: "owner-1", project_id: "proj-1", started_at: "2026-08-01T10:00:00Z" };

test("a signal is resolved to the project's most recent build, owner-scoped", async () => {
  const db = fakeDb({ runs: [
    { ...RUN, id: "old", started_at: "2026-07-01T10:00:00Z" },
    { ...RUN, id: "newest", started_at: "2026-08-01T10:00:00Z" },
    { id: "other-owner", owner: "owner-2", project_id: "proj-1", started_at: "2026-08-02T10:00:00Z" },
  ] });
  assert.equal(await latestBuildIdForProject("owner-1", "proj-1", db), "newest");
  // Another owner's build is never reachable, even for the same project id.
  assert.equal(await latestBuildIdForProject("owner-3", "proj-1", db), null);
});

test("exported and deployed are recorded against the build", async () => {
  const db = fakeDb({ runs: [RUN] });
  for (const signal of ["exported", "deployed"]) {
    const result = await signalBuildOutcome({ owner: "owner-1", projectId: "proj-1", signal, client: db });
    assert.equal(result.recorded, true, signal);
    assert.equal(result.buildId, "build-1");
  }
  assert.deepEqual(db.signals.map((s) => s.signal).sort(), ["deployed", "exported"]);
  assert.ok(db.signals.every((s) => s.owner === "owner-1"), "writes stay owner-scoped");
});

test("rolled_back is recorded directly against a known build id", async () => {
  const db = fakeDb();
  const result = await signalBuildOutcome({ owner: "owner-1", buildId: "build-9", signal: "rolled_back", client: db });
  assert.equal(result.recorded, true);
  assert.equal(db.signals[0].build_id, "build-9", "no lookup needed when the lifecycle knows the build");
});

test("repeating an action records ONE signal", async () => {
  const db = fakeDb({ runs: [RUN] });
  for (let i = 0; i < 4; i += 1) {
    await signalBuildOutcome({ owner: "owner-1", projectId: "proj-1", signal: "exported", client: db });
  }
  assert.equal(db.signals.length, 1, "the unique (build_id, signal) index deduplicates");
});

test("a signal failure never breaks the operation that produced it", async () => {
  // Storage down.
  const broken = fakeDb({ runs: [RUN], failInsert: true });
  await assert.doesNotReject(() => signalBuildOutcome({ owner: "owner-1", projectId: "proj-1", signal: "exported", client: broken }));

  // Lookup throws outright.
  const throwing = { from() { throw new Error("connection reset"); } };
  const result = await signalBuildOutcome({ owner: "owner-1", projectId: "proj-1", signal: "deployed", client: throwing });
  assert.equal(result.recorded, false);
  assert.equal(result.reason, "error");

  // A project with no build yet is a no-op, not an error.
  const empty = fakeDb({ runs: [] });
  const none = await signalBuildOutcome({ owner: "owner-1", projectId: "proj-404", signal: "exported", client: empty });
  assert.equal(none.recorded, false);
  assert.equal(none.reason, "no_build");
});

test("an unknown signal is refused", async () => {
  await assert.rejects(
    () => recordBuildSignal({ buildId: "b", owner: "o", signal: "liked_it" }),
    /Unknown build signal/,
  );
});

// ── Where the producers are wired ───────────────────────────────────────────────────────

test("export, publish and checkpoint restore each produce their signal", async () => {
  const build = await read("../../shell/server/lib/appBuild/appBuildService.mjs");
  const publish = await read("../../shell/server/lib/appBuild/appPublishService.mjs");

  // exported — only AFTER the artifact is proven free of secrets.
  const exportFn = build.slice(build.indexOf("export async function exportProject"), build.indexOf("async function persistBuildResult"));
  assert.match(exportFn, /signal: "exported"/);
  assert.ok(exportFn.indexOf("assertNoPlatformSecrets") < exportFn.indexOf('signal: "exported"'),
    "a failed safety check must not record a successful export");
  assert.match(exportFn, /signalBuildOutcome\([^)]*\)\.catch\(\(\) => \{\}\)/s, "must be fire-and-forget");

  // deployed — only after the site is actually serving.
  assert.match(publish, /signal: "deployed"/);
  const publishFn = publish.slice(publish.indexOf("export async function publishApp"), publish.indexOf("export async function connectDomain"));
  assert.ok(publishFn.indexOf("provisiond(\"/publish\"") < publishFn.indexOf('signal: "deployed"'),
    "the signal must follow the actual publish, not precede it");

  // rolled_back — only when a restore actually happened.
  const stopFn = build.slice(build.indexOf("async function stopWithMessage"), build.indexOf("async function handleProviderSwitch"));
  assert.match(stopFn, /signal: "rolled_back"/);
  assert.match(stopFn, /if \(restored\?\.restored\)/, "no restore means no signal");
});

test("preview_opened is deliberately NOT produced", async () => {
  const build = await read("../../shell/server/lib/appBuild/appBuildService.mjs");
  const publish = await read("../../shell/server/lib/appBuild/appPublishService.mjs");
  for (const source of [build, publish]) {
    assert.doesNotMatch(source, /signal: "preview_opened"/,
      "preview_opened needs client-side behaviour tracking and a separate product decision");
  }
  assert.ok(SIGNALS.includes("preview_opened"), "it stays a valid signal the endpoint accepts");
});

test("regenerated is deliberately NOT produced, because it would double-count", async () => {
  const build = await read("../../shell/server/lib/appBuild/appBuildService.mjs");
  assert.doesNotMatch(build, /signal: "regenerated"/);

  // The two candidate events are already represented, and emitting `regenerated` for either
  // would ALSO suppress `accepted` — corrupting the metric it feeds.
  const autonomousRepair = deriveOutcome({
    run: { status: "passed", finished_at: "2026-08-01T10:00:00Z", repair_rounds: 2 },
    signals: ["exported"], followUps: 0, superseded: false, now: Date.parse("2026-08-01T12:00:00Z"),
  });
  assert.equal(autonomousRepair.repairCycles, 2, "repairs are already counted from repair_rounds");
  assert.equal(autonomousRepair.accepted, true, "a repaired-then-exported build is still accepted");

  const withRegenerated = deriveOutcome({
    run: { status: "passed", finished_at: "2026-08-01T10:00:00Z", repair_rounds: 2 },
    signals: ["exported", "regenerated"], followUps: 0, superseded: false, now: Date.parse("2026-08-01T12:00:00Z"),
  });
  assert.equal(withRegenerated.accepted, false,
    "emitting regenerated for an autonomous repair would wrongly mark accepted builds as rejected");

  // And a later build superseding an earlier one is already modelled.
  const superseded = deriveOutcome({
    run: { status: "passed", finished_at: "2026-08-01T10:00:00Z", repair_rounds: 0 },
    signals: [], followUps: 0, superseded: true, now: Date.parse("2026-08-01T10:05:00Z"),
  });
  assert.equal(superseded.settled, true, "superseded already captures 'they built it again'");
});

// ── The evidence actually feeds the score ───────────────────────────────────────────────

test("produced signals move the outcome and the User Success Score", async () => {
  const finished = "2026-08-01T10:00:00Z";
  const now = Date.parse("2026-08-01T12:00:00Z");
  const run = { status: "passed", finished_at: finished, repair_rounds: 0 };

  const withoutSignals = deriveOutcome({ run, signals: [], followUps: 5, now });
  const withExport = deriveOutcome({ run, signals: ["exported"], followUps: 5, now });
  assert.equal(withExport.accepted, true, "an export proves the user kept it");
  assert.equal(withExport.exported, true);

  const rolledBack = deriveOutcome({ run, signals: ["rolled_back"], followUps: 0, now });
  assert.equal(rolledBack.accepted, false, "a rollback means it was not kept");
  assert.equal(rolledBack.rolledBack, true);

  // And the score responds to the difference.
  const good = userSuccessScore(summariseOutcomes([withExport, withExport]));
  const bad = userSuccessScore(summariseOutcomes([rolledBack, rolledBack]));
  assert.ok(good > bad, `exported builds must score above rolled-back ones (${good} vs ${bad})`);
  assert.ok(withoutSignals.accepted === false || withExport.accepted, "signals are what create acceptance evidence");
});

test("routing weights are untouched — only the evidence is new", async () => {
  const intelligence = await read("../../shell/server/lib/providerIntelligence.mjs");
  // The outcome-aware weights already existed; this work supplies the evidence they wait for.
  assert.match(intelligence, /WEIGHTS_WITH_OUTCOMES/);
  assert.match(intelligence, /userSuccess: 0\.45/, "weights must not be re-tuned by this change");
  assert.match(intelligence, /costPerVerified: 0\.5/);
});
