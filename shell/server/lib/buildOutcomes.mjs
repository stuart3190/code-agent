// Real-world outcome learning. Technical benchmarks say a build compiled and verified;
// these signals say whether the USER actually got something they kept, exported and
// deployed. Auto ranks on the combination, so a model that costs slightly more but
// produces projects people finish outranks a cheaper one that needs many retries.
//
// Privacy: no prompt text and no user-identifiable data are ever stored or returned.
// Owner ids exist only to scope writes; analytics output is aggregate-only. Most signals
// are DERIVED at read time from durable records rather than tracked, so there is no
// behavioural telemetry beacon and nothing extra to leak.

import { randomUUID } from "node:crypto";
import { serviceClient } from "./supabase.mjs";

// Explicit signals the product reports (the rest are derived).
export const SIGNALS = ["preview_opened", "exported", "deployed", "rolled_back", "regenerated"];

export async function recordBuildSignal({ buildId, owner, signal, client = null } = {}) {
  if (!SIGNALS.includes(signal) || !buildId) {
    const error = new Error("Unknown build signal.");
    error.status = 400;
    throw error;
  }
  const db = client || serviceClient();
  // Idempotent: a user opening the preview five times is one "opened" signal.
  const { error } = await db.from("build_signals").insert({
    id: randomUUID(), build_id: buildId, owner, signal, created_at: new Date().toISOString(),
  });
  if (error && !/duplicate key/i.test(error.message || "")) {
    console.error("[outcomes] signal write:", error.message);
  }
  return { signal, buildId };
}

// ── Trusted server-side producers ───────────────────────────────────────────────────────
//
// The signals above existed with NO producer: the endpoint and writer worked, but nothing ever
// posted one, so outcome learning and the User Success Score were permanently inert — surfaced
// by scripts/feature-health.mjs on 2026-08-01 ("outcome learning signals: NEVER").
//
// These emit only from events that ALREADY happen server-side, where the outcome is a fact
// rather than an inference: a project was exported, a site went live, a checkpoint was restored.
// Nothing observes user behaviour, so there is no telemetry beacon and no new privacy surface.
//
// `preview_opened` is deliberately NOT produced — it would require client-side behaviour
// tracking and a separate product decision.

// A signal belongs to a BUILD (a diag run). Producers know the project, so this resolves the
// most recent build for it — owner-scoped, so one owner can never attribute a signal to
// another's build.
export async function latestBuildIdForProject(owner, projectId, client = null) {
  if (!owner || !projectId) return null;
  const db = client || serviceClient();
  const { data, error } = await db.from("diag_runs")
    .select("id")
    .eq("owner", owner)
    .eq("project_id", String(projectId))
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error("[outcomes] build lookup:", error.message);
    return null;
  }
  return data?.id || null;
}

// Fire-and-forget by contract. An outcome signal is bookkeeping: it must never fail an export,
// a deploy or a restore, and it must never delay the user's result. Deduplication is enforced
// by the unique index on (build_id, signal), so repeating an action records one signal.
export async function signalBuildOutcome({ owner, projectId = null, buildId = null, signal, client = null }) {
  try {
    const id = buildId || await latestBuildIdForProject(owner, projectId, client);
    if (!id) return { recorded: false, reason: "no_build" };
    await recordBuildSignal({ buildId: id, owner, signal, client });
    return { recorded: true, buildId: id, signal };
  } catch (error) {
    console.error(`[outcomes] ${signal} signal skipped:`, error.message);
    return { recorded: false, reason: "error" };
  }
}

// ── Derivation ──────────────────────────────────────────────────────────────────────────

const ABANDON_AFTER_MS = 30 * 60_000; // no further activity for 30 min after a build ends

// One outcome row per build, combining explicit signals with behaviour derived from the
// conversation and project records. Anonymous: only counts and timings survive.
export function deriveOutcome({ run, signals = [], followUps = 0, lastActivityAt = null, deployed = false, superseded = false, now = Date.now() }) {
  const set = new Set(signals);
  const finishedAt = run.finished_at ? new Date(run.finished_at).getTime() : null;
  const lastActivity = lastActivityAt ? new Date(lastActivityAt).getTime() : null;
  const editingMs = finishedAt && lastActivity && lastActivity > finishedAt ? lastActivity - finishedAt : 0;
  const verified = run.status === "passed";
  const repairCycles = Number(run.repair_rounds || 0);
  const exported = set.has("exported");
  const deployedFlag = deployed || set.has("deployed");
  const rolledBack = set.has("rolled_back");
  const regenerated = set.has("regenerated");
  // Accepted = the user kept it: they exported, deployed, or simply stopped editing a
  // verified build without rolling back or regenerating.
  // Settled = the user has moved on: either a later build superseded this one, or nothing
  // has happened for long enough that they are clearly finished with it.
  const settled = superseded
    || (finishedAt ? (now - Math.max(finishedAt, lastActivity || 0)) > ABANDON_AFTER_MS : false);
  const accepted = Boolean(verified && !rolledBack && !regenerated && (exported || deployedFlag || (settled && followUps <= 3)));
  const firstPass = Boolean(accepted && followUps === 0 && repairCycles === 0);
  // Abandoned = never verified or immediately dropped with nothing kept.
  const abandoned = Boolean(settled && !accepted && !exported && !deployedFlag);
  return {
    buildId: run.id,
    model: run.model || null,
    verified,
    followUps,
    repairCycles,
    previewOpened: set.has("preview_opened"),
    exported,
    deployed: deployedFlag,
    rolledBack,
    regenerated,
    accepted,
    firstPass,
    abandoned,
    editingMs,
    settled,
  };
}

// ── Aggregation into user-success metrics ──────────────────────────────────────────────

const pct = (n, d) => (d ? Number(((n / d) * 100).toFixed(1)) : null);

export function summariseOutcomes(outcomes) {
  const total = outcomes.length;
  if (!total) return null;
  const accepted = outcomes.filter((o) => o.accepted).length;
  const firstPass = outcomes.filter((o) => o.firstPass).length;
  return {
    builds: total,
    acceptanceRate: pct(accepted, total),
    firstPassAcceptanceRate: pct(firstPass, total),
    exportRate: pct(outcomes.filter((o) => o.exported).length, total),
    deploymentRate: pct(outcomes.filter((o) => o.deployed).length, total),
    previewOpenRate: pct(outcomes.filter((o) => o.previewOpened).length, total),
    rollbackRate: pct(outcomes.filter((o) => o.rolledBack).length, total),
    regenerationRate: pct(outcomes.filter((o) => o.regenerated).length, total),
    completionRate: pct(outcomes.filter((o) => o.accepted || o.exported || o.deployed).length, total),
    abandonmentRate: pct(outcomes.filter((o) => o.abandoned).length, total),
    avgFollowUps: Number((outcomes.reduce((a, o) => a + o.followUps, 0) / total).toFixed(2)),
    avgRepairCycles: Number((outcomes.reduce((a, o) => a + o.repairCycles, 0) / total).toFixed(2)),
    avgEditingMs: Math.round(outcomes.reduce((a, o) => a + o.editingMs, 0) / total),
  };
}

// The User Success Score: 0-100, weighted toward what actually matters — the user kept it
// and didn't have to fight for it. Published so any score can be re-derived by hand.
export const SUCCESS_WEIGHTS = {
  acceptance: 0.35,      // they kept the build
  completion: 0.25,      // exported / deployed / finished
  firstPass: 0.20,       // no iteration needed
  lowFriction: 0.20,     // few follow-ups and repairs, no rollback
};

export function userSuccessScore(summary) {
  if (!summary) return null;
  const frictionPenalty = Math.min(
    ((summary.avgFollowUps || 0) / 5) * 0.5
    + ((summary.avgRepairCycles || 0) / 3) * 0.3
    + ((summary.rollbackRate || 0) / 100) * 0.2,
    1,
  );
  const score = SUCCESS_WEIGHTS.acceptance * ((summary.acceptanceRate ?? 0) / 100)
    + SUCCESS_WEIGHTS.completion * ((summary.completionRate ?? 0) / 100)
    + SUCCESS_WEIGHTS.firstPass * ((summary.firstPassAcceptanceRate ?? 0) / 100)
    + SUCCESS_WEIGHTS.lowFriction * (1 - frictionPenalty);
  return Number((score * 100).toFixed(1));
}

// ── Collection from production records (anonymous) ─────────────────────────────────────

export async function collectOutcomes({ client = null, windowDays = 60, now = new Date() } = {}) {
  const db = client || serviceClient();
  const since = new Date(now.getTime() - windowDays * 86_400_000).toISOString();
  const [{ data: runs }, { data: signals }, { data: sites }] = await Promise.all([
    db.from("diag_runs")
      .select("id, owner, conversation_id, project_id, model, status, repair_rounds, started_at, finished_at")
      .gte("started_at", since).limit(10_000),
    db.from("build_signals").select("build_id, signal").gte("created_at", since).limit(50_000),
    db.from("published_sites").select("project_id").limit(10_000),
  ]);

  const signalsByBuild = new Map();
  for (const row of signals || []) {
    if (!signalsByBuild.has(row.build_id)) signalsByBuild.set(row.build_id, []);
    signalsByBuild.get(row.build_id).push(row.signal);
  }
  const deployedProjects = new Set((sites || []).map((s) => s.project_id));

  // Follow-up prompts + last activity, derived per conversation (counts only — the
  // content of those messages is never read).
  const conversationIds = [...new Set((runs || []).map((r) => r.conversation_id).filter(Boolean))];
  const followUpsByConversation = new Map();
  const lastActivityByConversation = new Map();
  for (const conversationId of conversationIds) {
    const { data: turns } = await db.from("ca_conversation_turns")
      .select("role, created_at").eq("conversation_id", conversationId).order("created_at").limit(500);
    followUpsByConversation.set(conversationId, turns || []);
    const last = (turns || [])[turns?.length - 1];
    if (last) lastActivityByConversation.set(conversationId, last.created_at);
  }

  // A build's outcome window ends when the NEXT build in the same conversation starts.
  // Counting to the end of the conversation would blame an early build for every later
  // piece of unrelated work — it made every build in a long session look abandoned.
  const nextBuildStart = new Map();
  const runsByConversation = new Map();
  for (const run of runs || []) {
    if (!run.conversation_id) continue;
    if (!runsByConversation.has(run.conversation_id)) runsByConversation.set(run.conversation_id, []);
    runsByConversation.get(run.conversation_id).push(run);
  }
  for (const list of runsByConversation.values()) {
    const ordered = [...list].sort((a, b) => String(a.started_at).localeCompare(String(b.started_at)));
    for (let i = 0; i < ordered.length - 1; i += 1) {
      nextBuildStart.set(ordered[i].id, new Date(ordered[i + 1].started_at).getTime());
    }
  }

  return (runs || [])
    .filter((run) => ["passed", "failed", "complete_unverified", "interrupted"].includes(run.status))
    .map((run) => {
      const turns = followUpsByConversation.get(run.conversation_id) || [];
      const finishedAt = run.finished_at ? new Date(run.finished_at).getTime() : null;
      const windowEnd = nextBuildStart.get(run.id) ?? Infinity;
      const inWindow = finishedAt
        ? turns.filter((t) => {
          const at = new Date(t.created_at).getTime();
          return at > finishedAt && at < windowEnd;
        })
        : [];
      const followUps = inWindow.filter((t) => t.role === "user").length;
      // Last activity for THIS build: the final turn inside its own window. A superseded
      // build is settled the moment the next build begins.
      const lastInWindow = inWindow.length ? inWindow[inWindow.length - 1].created_at : null;
      const supersededAt = nextBuildStart.get(run.id) || null;
      return deriveOutcome({
        run,
        signals: signalsByBuild.get(run.id) || [],
        followUps,
        lastActivityAt: lastInWindow
          || (supersededAt ? new Date(supersededAt).toISOString() : lastActivityByConversation.get(run.conversation_id) || null),
        deployed: run.project_id ? deployedProjects.has(run.project_id) : false,
        superseded: Boolean(supersededAt),
        now: now.getTime(),
      });
    });
}

// Per-model (and optionally per-task) user-success metrics, gated by the same evidence
// floor as the technical benchmarks so nothing is claimed without data.
export function outcomesByModel(outcomes, { minSamples = 5 } = {}) {
  const byModel = new Map();
  for (const outcome of outcomes) {
    if (!outcome.model) continue;
    if (!byModel.has(outcome.model)) byModel.set(outcome.model, []);
    byModel.get(outcome.model).push(outcome);
  }
  const result = {};
  for (const [model, list] of byModel) {
    const summary = summariseOutcomes(list);
    result[model] = list.length >= minSamples
      ? { ...summary, userSuccessScore: userSuccessScore(summary), collecting: false }
      : { builds: list.length, collecting: true };
  }
  return result;
}
