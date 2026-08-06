// Verification Engine facade + Differential Test Planner (finish plan WP-3; master plan
// Parts 2 §10/§11 and 9).
//
// ONE entry over the existing, production-proven gates — nothing is reimplemented. What v2
// adds is discipline: every D3 failure must be ATTRIBUTED to owning modules (or it degrades
// to a warning: a failure that names nothing cannot brief a targeted repair), and journeys
// whose owning modules' content is unchanged REUSE their cached verdict — recorded as
// `reused` with the original evidence, never silently.

import crypto from "node:crypto";
import { runStageGate } from "../appBuild/stageGate.mjs";
import { verifyJourneys, journeySummary } from "../appBuild/journeyVerifier.mjs";

const sha256 = (text) => crypto.createHash("sha256").update(text).digest("hex");

// ── attribution ───────────────────────────────────────────────────────────────────────────────

/**
 * Attach owning modules to every journey verdict. A FAILED journey that maps to no modules
 * downgrades to `warn`: it cannot brief a repair, so treating it as blocking would block a
 * build on evidence nobody can act on. Pure; exported for direct proof.
 */
export function attributeFailures(journeyResults, graph, contract) {
  const journeysById = new Map((contract?.journeys || []).map((j) => [j.id, j]));
  return (journeyResults?.journeys || []).map((result) => {
    const journey = journeysById.get(result.id) || { id: result.id, title: result.title };
    const owners = graph ? graph.owners(journey) : [];
    if (result.status === "fail" && owners.length === 0) {
      return { ...result, status: "warn", owners, downgraded: "failure attributed to no owning module" };
    }
    return { ...result, owners };
  });
}

// ── the facade ────────────────────────────────────────────────────────────────────────────────

/**
 * D0-D2 (+stage-scoped honesty/expectations) through the EXISTING stage gate, unchanged.
 * Parity with direct runStageGate calls is asserted by test — the facade may never drift.
 */
export async function verifyStage(tree, options = {}) {
  const gate = await runStageGate(tree, options);
  // A repair round can only fix what its brief names: "the project does not compile" with
  // no compiler output sent a live booking build into blind guessing until the stop rule.
  // The stderr excerpt rides WITH the problem so the next round sees file, line and error.
  const problems = [...(gate.problems || [])];
  if (!gate.ok && gate.stderr) {
    const excerpt = String(gate.stderr).split(/\r?\n/).filter((l) => l.trim()).slice(0, 15).join("\n");
    if (excerpt) problems.push(`compiler output:\n${excerpt}`);
  }
  return {
    ok: gate.ok,
    layers: { d0d2: { ok: gate.ok, checks: gate.checks, problems } },
    tree: gate.tree,
    deterministicRepair: gate.deterministicRepair || null,
  };
}

/** D3 browser journeys through the existing verifier, with mandatory attribution. */
export async function verifyJourneysAttributed({ previewUrl, contract, graph, timeoutMs }) {
  const raw = await verifyJourneys({ previewUrl, contract, timeoutMs });
  const attributed = attributeFailures(raw, graph, contract);
  const failures = attributed.filter((j) => j.status === "fail");
  return {
    ...raw,
    journeys: attributed,
    failures,
    pass: raw.unavailable ? null : failures.filter((j) => j.priority === "primary").length === 0,
    failureRefs: [...new Set(failures.flatMap((j) => j.owners))],
    summary: journeySummary(raw),
  };
}

// ── the differential planner ──────────────────────────────────────────────────────────────────

/** Hash over a journey's owning modules' CONTENT — the verification-cache key half. */
export function ownersHashOf(journey, graph) {
  const owners = graph.owners(journey);
  const pairs = owners.map((path) => `${path} ${graph.file(path)?.contentHash || "missing"}`);
  return sha256(pairs.join("\n"));
}

export function memoryVerificationCache() {
  const rows = new Map();
  const key = (o, p, j, h) => `${o}:${p}:${j}:${h}`;
  return {
    async get(owner, projectId, journeyId, ownersHash) {
      return rows.get(key(owner, projectId, journeyId, ownersHash)) || null;
    },
    async put(owner, projectId, journeyId, ownersHash, verdict, snapshotId) {
      rows.set(key(owner, projectId, journeyId, ownersHash), { verdict, snapshot_id: snapshotId, created_at: new Date().toISOString() });
    },
  };
}

export function supabaseVerificationCache(client) {
  return {
    async get(owner, projectId, journeyId, ownersHash) {
      const { data, error } = await client.from("bv2_verification_cache").select("verdict,snapshot_id,created_at")
        .eq("owner", owner).eq("project_id", projectId)
        .eq("journey_id", journeyId).eq("owners_hash", ownersHash).maybeSingle();
      if (error) return null; // a broken cache means re-verification, never a wrong reuse
      return data;
    },
    async put(owner, projectId, journeyId, ownersHash, verdict, snapshotId) {
      const { error } = await client.from("bv2_verification_cache").upsert({
        owner, project_id: projectId, journey_id: journeyId, owners_hash: ownersHash,
        verdict, snapshot_id: snapshotId,
      }, { onConflict: "owner,project_id,journey_id,owners_hash" });
      if (error) console.error(`[bv2] verification cache write failed (re-verification will occur): ${error.message}`);
    },
  };
}

/**
 * Which journeys must actually be DRIVEN for this tree state, and which verdicts are reused.
 * Reuse requires: a cached verdict under the journey's current owners-hash AND a passing one —
 * failures are always re-driven (a cached failure must never block a fixed build).
 */
export async function planJourneyVerification({ owner, projectId, contract, graph, cache, snapshotId = null }) {
  const drive = [];
  const reused = [];
  for (const journey of contract?.journeys || []) {
    const ownersHash = ownersHashOf(journey, graph);
    const cached = await cache.get(owner, projectId, journey.id, ownersHash);
    if (cached && cached.verdict?.status === "pass") {
      reused.push({ journeyId: journey.id, ownersHash, verdict: cached.verdict, evidenceSnapshot: cached.snapshot_id });
    } else {
      drive.push({ journey, ownersHash });
    }
  }
  return {
    drive,
    reused,
    summary: `drive ${drive.length}, reuse ${reused.length}`
      + (reused.length ? ` (${reused.map((r) => r.journeyId).join(", ")})` : ""),
  };
}

/** Store fresh verdicts after a drive so the NEXT identical state reuses them. */
export async function recordJourneyVerdicts({ owner, projectId, cache, plan, results, snapshotId }) {
  const byId = new Map((results?.journeys || []).map((j) => [j.id, j]));
  for (const { journey, ownersHash } of plan.drive) {
    const outcome = byId.get(journey.id);
    if (!outcome) continue;
    await cache.put(owner, projectId, journey.id, ownersHash,
      { status: outcome.status, failedSteps: outcome.failedSteps || 0 }, snapshotId);
  }
}
