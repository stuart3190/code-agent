// Verification Engine facade + Differential Test Planner (finish plan WP-3; master plan
// Parts 2 §10/§11 and 9).
//
// ONE entry over the existing, production-proven gates — nothing is reimplemented. What v2
// adds is discipline: every D3 failure is ATTRIBUTED to owning modules when possible. An
// attribution miss is a separate platform defect and NEVER changes the journey verdict;
// repair instead receives a broad, bounded fallback file set. Journeys
// whose owning modules' content is unchanged REUSE their cached verdict — recorded as
// `reused` with the original evidence, never silently.

import crypto from "node:crypto";
import { runStageGate } from "../appBuild/stageGate.mjs";
import { verifyJourneys, journeySummary } from "../appBuild/journeyVerifier.mjs";
import { bindCapabilities } from "./contractTiering.mjs";

const sha256 = (text) => crypto.createHash("sha256").update(text).digest("hex");
const canonical = (value) => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
};

export const VERIFICATION_CACHE_VERSION = "journey-verifier/2026-08-06.1";
export const DEFAULT_VERIFICATION_CONTEXT = Object.freeze({
  verifierVersion: VERIFICATION_CACHE_VERSION,
  backendVersion: "generated-backend/1",
  runtimeVersion: "react-vite-runtime/1",
  environmentVersion: "preview-environment/1",
  configVersion: "journey-verification-config/1",
});

// ── attribution ───────────────────────────────────────────────────────────────────────────────

const FALLBACK_FILE_LIMIT = 16;
const FALLBACK_TOKEN_LIMIT = 6_000;

/** Deterministic emergency context for an unattributed failure, below repair's hard budget. */
export function boundedAttributionFallback(graph, {
  maxFiles = FALLBACK_FILE_LIMIT,
  maxTokens = FALLBACK_TOKEN_LIMIT,
} = {}) {
  if (!graph || maxFiles <= 0 || maxTokens <= 0) return [];
  const priority = (path) => {
    if (/^src\/(?:App|main|index)\.[^/]+$/i.test(path)) return 0;
    if (/^src\/(?:routes|components|data|lib)\//i.test(path)) return 1;
    if (/^src\//i.test(path)) return 2;
    return 3;
  };
  const candidates = graph.paths().slice().sort((a, b) => {
    const rank = priority(a) - priority(b);
    if (rank) return rank;
    const size = Number(graph.file(a)?.tokens || 0) - Number(graph.file(b)?.tokens || 0);
    return size || a.localeCompare(b);
  });
  const selected = [];
  let usedTokens = 0;
  for (const path of candidates) {
    if (selected.length >= maxFiles) break;
    const tokens = Math.max(0, Number(graph.file(path)?.tokens || 0));
    if (usedTokens + tokens > maxTokens) continue;
    selected.push(path);
    usedTokens += tokens;
  }
  return selected;
}

/**
 * Attach owning modules to every journey verdict. A failed journey with no owner remains
 * failed. The miss is recorded separately and repair receives bounded fallback references.
 */
export function attributeFailures(journeyResults, graph, contract) {
  const journeysById = new Map((contract?.journeys || []).map((j) => [j.id, j]));
  let fallbackRefs = null;
  return (journeyResults?.journeys || []).map((result) => {
    const journey = journeysById.get(result.id) || { id: result.id, title: result.title };
    const owners = graph ? graph.owners(journey) : [];
    if (result.status === "fail" && owners.length === 0) {
      fallbackRefs ||= boundedAttributionFallback(graph);
      return {
        ...result,
        owners,
        fallbackRefs,
        attributionStatus: "missing",
        attributionDefect: {
          code: "journey_ownership_missing",
          journeyId: result.id,
          message: "failed journey attributed to no owning module",
        },
      };
    }
    return { ...result, owners, attributionStatus: result.status === "fail" ? "attributed" : "not_required" };
  });
}

// ── the facade ────────────────────────────────────────────────────────────────────────────────

/**
 * D0-D2 (+stage-scoped honesty/expectations) through the EXISTING stage gate, unchanged.
 * Parity with direct runStageGate calls is asserted by test — the facade may never drift.
 */
export async function verifyStage(tree, options = {}) {
  // Builder V2 runs the expectation-copy check as advisory: the browser verifier drives the
  // real page and is the authority on whether an outcome appeared. See validationSeverity.mjs.
  const gate = await runStageGate(tree, { expectationsAdvisory: true, ...options });
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
    advisory: gate.advisory || [],
    tree: gate.tree,
    deterministicRepair: gate.deterministicRepair || null,
  };
}

/** D3 browser journeys through the existing verifier, with mandatory attribution. */
export async function verifyJourneysAttributed({ previewUrl, contract, graph, timeoutMs }) {
  const raw = await verifyJourneys({ previewUrl, contract, timeoutMs });
  const attributed = attributeFailures(raw, graph, contract);
  const failures = attributed.filter((j) => j.status === "fail");
  const platformDefects = attributed.flatMap((j) => j.attributionDefect ? [j.attributionDefect] : []);
  return {
    ...raw,
    journeys: attributed,
    failures,
    pass: raw.unavailable ? null : failures.filter((j) => j.priority === "primary").length === 0,
    failureRefs: [...new Set(failures.flatMap((j) => [...j.owners, ...(j.fallbackRefs || [])]))],
    platformDefects,
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

/**
 * Full differential-cache identity. The existing `owners_hash` database column stores the
 * final content-addressed key; all components are retained in verdict.cacheIdentity so a
 * reuse can prove exactly why it was valid without a schema migration.
 */
export function verificationCacheIdentity({ journey, contract, graph, context = {} }) {
  const effectiveContext = { ...DEFAULT_VERIFICATION_CONTEXT, ...context };
  const owners = graph.owners(journey).sort();
  const closure = new Set();
  const frontier = [...owners];
  while (frontier.length) {
    const path = frontier.shift();
    for (const dependency of graph.importsOf(path)) {
      if (owners.includes(dependency) || closure.has(dependency)) continue;
      closure.add(dependency);
      frontier.push(dependency);
    }
  }
  const fileIdentity = (path) => ({ path, contentHash: graph.file(path)?.contentHash || "missing" });
  const runtimeFiles = graph.paths()
    .filter((path) => /^src\/lib\/(?:backend|capabilities)\//.test(path) || path === "src/lib/visitorSession.js")
    .sort().map(fileIdentity);
  const components = {
    journeyId: journey.id,
    journeyDefinitionHash: sha256(canonical(journey)),
    contractHash: sha256(canonical(contract)),
    verifierVersion: effectiveContext.verifierVersion,
    owningModules: owners.map(fileIdentity),
    transitiveDependencyClosure: [...closure].sort().map(fileIdentity),
    capabilityVersions: bindCapabilities(contract)
      .map(({ name, version }) => ({ name, version })).sort((a, b) => a.name.localeCompare(b.name)),
    backendVersion: effectiveContext.backendVersion,
    runtimeVersion: effectiveContext.runtimeVersion,
    runtimeFiles,
    environmentVersion: effectiveContext.environmentVersion,
    configVersion: effectiveContext.configVersion,
  };
  return { key: sha256(canonical(components)), components, owners, cacheable: owners.length > 0 };
}

const DEFAULT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

export function memoryVerificationCache({ retentionMs = DEFAULT_RETENTION_MS, now = () => Date.now() } = {}) {
  const rows = new Map();
  const key = (o, p, j, h) => `${o}:${p}:${j}:${h}`;
  return {
    async get(owner, projectId, journeyId, ownersHash) {
      const cacheKey = key(owner, projectId, journeyId, ownersHash);
      const row = rows.get(cacheKey) || null;
      if (row && now() - Date.parse(row.created_at) > retentionMs) {
        rows.delete(cacheKey);
        return null;
      }
      return row;
    },
    async put(owner, projectId, journeyId, ownersHash, verdict, snapshotId) {
      rows.set(key(owner, projectId, journeyId, ownersHash), { verdict, snapshot_id: snapshotId, created_at: new Date(now()).toISOString() });
    },
    async invalidate(owner, projectId, journeyId = null) {
      let removed = 0;
      const prefix = `${owner}:${projectId}:`;
      for (const cacheKey of rows.keys()) {
        if (!cacheKey.startsWith(prefix) || (journeyId && !cacheKey.startsWith(`${prefix}${journeyId}:`))) continue;
        rows.delete(cacheKey);
        removed += 1;
      }
      return removed;
    },
    async prune() {
      let removed = 0;
      for (const [cacheKey, row] of rows) {
        if (now() - Date.parse(row.created_at) <= retentionMs) continue;
        rows.delete(cacheKey);
        removed += 1;
      }
      return removed;
    },
  };
}

export function supabaseVerificationCache(client, { retentionMs = DEFAULT_RETENTION_MS, now = () => Date.now() } = {}) {
  const cutoff = () => new Date(now() - retentionMs).toISOString();
  return {
    async get(owner, projectId, journeyId, ownersHash) {
      const { data, error } = await client.from("bv2_verification_cache").select("verdict,snapshot_id,created_at")
        .eq("owner", owner).eq("project_id", projectId)
        .eq("journey_id", journeyId).eq("owners_hash", ownersHash).gte("created_at", cutoff()).maybeSingle();
      if (error) return null; // a broken cache means re-verification, never a wrong reuse
      return data;
    },
    async put(owner, projectId, journeyId, ownersHash, verdict, snapshotId) {
      const { error } = await client.from("bv2_verification_cache").upsert({
        owner, project_id: projectId, journey_id: journeyId, owners_hash: ownersHash,
        verdict, snapshot_id: snapshotId, created_at: new Date(now()).toISOString(),
      }, { onConflict: "owner,project_id,journey_id,owners_hash" });
      if (error) console.error(`[bv2] verification cache write failed (re-verification will occur): ${error.message}`);
    },
    async invalidate(owner, projectId, journeyId = null) {
      let query = client.from("bv2_verification_cache").delete({ count: "exact" }).eq("owner", owner).eq("project_id", projectId);
      if (journeyId) query = query.eq("journey_id", journeyId);
      const { error, count } = await query;
      if (error) throw new Error(`verification cache invalidation: ${error.message}`);
      return count || 0;
    },
    async prune() {
      const { error, count } = await client.from("bv2_verification_cache").delete({ count: "exact" }).lt("created_at", cutoff());
      if (error) throw new Error(`verification cache retention: ${error.message}`);
      return count || 0;
    },
  };
}

/**
 * Which journeys must actually be DRIVEN for this tree state, and which verdicts are reused.
 * Reuse requires: a cached verdict under the journey's current owners-hash AND a passing one —
 * failures are always re-driven (a cached failure must never block a fixed build).
 */
export async function planJourneyVerification({
  owner, projectId, contract, identityContract = contract, graph, cache, verificationContext = {}, snapshotId = null,
}) {
  const drive = [];
  const reused = [];
  for (const journey of contract?.journeys || []) {
    const identity = verificationCacheIdentity({ journey, contract: identityContract, graph, context: verificationContext });
    const ownersHash = identity.key; // legacy column/API name; now the complete identity hash
    if (!identity.cacheable) {
      drive.push({ journey, ownersHash, identity, cacheable: false, reason: "journey has zero owning modules" });
      continue;
    }
    const cached = await cache.get(owner, projectId, journey.id, ownersHash);
    if (cached && cached.verdict?.status === "pass") {
      reused.push({
        journeyId: journey.id, ownersHash, identity, verdict: cached.verdict,
        originalEvidence: cached.verdict, evidenceSnapshot: cached.snapshot_id,
        reuseReason: "complete cache identity matched and original verdict passed",
      });
    } else {
      drive.push({ journey, ownersHash, identity, cacheable: true, reason: cached ? "cached verdict did not pass" : "no valid cache entry" });
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
  for (const { journey, ownersHash, identity, cacheable } of plan.drive) {
    if (!cacheable) continue;
    const outcome = byId.get(journey.id);
    if (!outcome) continue;
    await cache.put(owner, projectId, journey.id, ownersHash,
      {
        status: outcome.status,
        failedSteps: outcome.failedSteps || 0,
        steps: outcome.steps || [],
        backendEvidence: outcome.backendEvidence || null,
        cacheIdentity: identity.components,
      }, snapshotId);
  }
}
