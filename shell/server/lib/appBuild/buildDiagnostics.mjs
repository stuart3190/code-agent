// Permanent Build Diagnostics & Artifact System. Every build session (build → repair
// rounds → verification) gets one diag_runs row (the Build ID) and an append-only trail
// of diag_steps: agent prompts, compiler/test/lint/runtime output, terminal logs, file
// changes with diffs, token usage and cost per step. Steps are written incrementally and
// asynchronously (fire-and-forget with warnings), so the trail survives crashes and never
// blocks the pipeline. Nothing here is ever summarised at write time — raw output only.
//
// Failure explanations are evidence-or-nothing: explainBuildFailure quotes the exact
// stored output, and when no diagnostics exist it says so and names it a platform bug —
// fabricating a cause is banned by construction.

import { randomUUID } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { serviceClient } from "../supabase.mjs";
import { creditsForUsage } from "../../../../src/billing/costModel.mjs";

const GZ_THRESHOLD = 16 * 1024;      // inline text beyond this is stored gzip+base64
const STEP_INLINE_CAP = 12 * 1024;   // list/detail endpoints truncate outputs to this
export const DIAG_DEFAULT_RETENTION_DAYS = 90;
export const DIAG_RETENTION_CHOICES = [30, 90, 365, null]; // null = forever

function now() { return new Date().toISOString(); }

function packOutput(output) {
  const text = output == null ? null : String(output);
  if (text == null) return { output: null, output_gz: null };
  if (Buffer.byteLength(text, "utf8") <= GZ_THRESHOLD) return { output: text, output_gz: null };
  return { output: null, output_gz: gzipSync(Buffer.from(text, "utf8")).toString("base64") };
}

export function unpackOutput(row) {
  if (row?.output != null) return row.output;
  if (row?.output_gz) {
    try { return gunzipSync(Buffer.from(row.output_gz, "base64")).toString("utf8"); }
    catch { return "[diagnostics: stored log could not be decompressed]"; }
  }
  return null;
}

// Honest, cheap line diff: trim the common prefix/suffix, emit the changed hunk (capped).
export function simpleLineDiff(before = "", after = "") {
  if (before === after) return null;
  const a = String(before).split("\n");
  const b = String(after).split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) { endA -= 1; endB -= 1; }
  const removed = a.slice(start, endA + 1);
  const added = b.slice(start, endB + 1);
  const cap = (lines, sign) => {
    const out = lines.slice(0, 160).map((line) => `${sign} ${line}`);
    if (lines.length > 160) out.push(`${sign} … ${lines.length - 160} more line(s)`);
    return out;
  };
  return [`@@ line ${start + 1} @@`, ...cap(removed, "-"), ...cap(added, "+")].join("\n");
}

export function treeChanges(baseline = {}, tree = {}) {
  const created = [];
  const modified = [];
  const deleted = [];
  const diffs = {};
  for (const path of Object.keys(tree)) {
    if (!(path in baseline)) {
      created.push(path);
      diffs[path] = simpleLineDiff("", tree[path]);
    } else if (baseline[path] !== tree[path]) {
      modified.push(path);
      diffs[path] = simpleLineDiff(baseline[path], tree[path]);
    }
  }
  for (const path of Object.keys(baseline)) {
    if (!(path in tree)) deleted.push(path);
  }
  return { created: created.sort(), modified: modified.sort(), deleted: deleted.sort(), diffs };
}

const tail = (text, lines = 20, chars = 1600) =>
  String(text || "").split("\n").slice(-lines).join("\n").slice(-chars);

// The engine reports {input, output, cached, reasoning, total}; providers report
// {inputTokens, outputTokens, cachedTokens, reasoningTokens}. Normalize both.
export function normalizeTelemetry(usage) {
  if (!usage) return null;
  const input = Number(usage.input ?? usage.inputTokens ?? 0);
  const output = Number(usage.output ?? usage.outputTokens ?? 0);
  return {
    input,
    output,
    cached: Number(usage.cached ?? usage.cachedTokens ?? 0),
    reasoning: Number(usage.reasoning ?? usage.reasoningTokens ?? 0),
    total: Number(usage.total ?? usage.totalTokens ?? input + output),
  };
}

export function providerForModel(model = "") {
  const m = String(model).toLowerCase();
  if (m.startsWith("claude")) return "anthropic";
  if (m.startsWith("gemini")) return "google";
  if (m.startsWith("grok")) return "xai";
  if (m.startsWith("gpt") || m.startsWith("o")) return "openai";
  return m ? "openai" : null;
}

// ── The session ─────────────────────────────────────────────────────────────────────────

export async function createDiagSession({ owner, projectId = null, conversationId = null, kind, prompt, model = null, client = null }) {
  const db = client || serviceClient();
  const session = {
    id: randomUUID(),
    db,
    owner,
    seq: 0,
    round: 1,
    startedAt: Date.now(),
    agents: new Set(),
    totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0 },
    repairRounds: 0,
    byok: false,   // set by setByok(): whether usage bills the USER's own provider account
    failures: [],   // [{label, excerpt}] — feeds evidence-grounded failure messages
    _chain: Promise.resolve(),
  };
  const write = (fn) => {
    session._chain = session._chain.then(fn).catch((error) =>
      console.error(`[diag ${session.id.slice(0, 8)}]`, error.message));
    return session._chain;
  };
  write(() => db.from("diag_runs").insert({
    id: session.id, owner, project_id: projectId, conversation_id: conversationId,
    kind, status: "running", prompt: String(prompt || ""), model,
    started_at: now(),
  }));

  session.step = ({ agent = null, kind: stepKind = "log", label, status = "ok", prompt: stepPrompt = null, output = null, usage = null, model: stepModel = null, durationMs = null, round = session.round, contextMeta = null }) => {
    session.seq += 1;
    if (agent) session.agents.add(agent);
    const norm = normalizeTelemetry(usage);
    let cost = null;
    if (norm) {
      session.totals.inputTokens += norm.input;
      session.totals.outputTokens += norm.output;
      session.totals.totalTokens += norm.total;
      try {
        cost = creditsForUsage({ usage, model: stepModel || model || "" });
        session.totals.cost += cost || 0;
      } catch { cost = null; }
    }
    if (status === "failed" && output) {
      session.failures.push({ label: label || stepKind, excerpt: tail(output) });
    }
    const seq = session.seq;
    write(() => db.from("diag_steps").insert({
      id: randomUUID(), run_id: session.id, seq, round,
      agent, kind: stepKind, label: label || stepKind, status,
      prompt: stepPrompt == null ? null : String(stepPrompt),
      ...packOutput(output),
      usage: norm || null, cost,
      started_at: now(), duration_ms: durationMs,
    }));
    // Per-AI-request accounting: every usage-bearing step becomes an ai_requests row —
    // the source of truth for customer AI-cost summaries and admin analytics.
    if (norm) {
      const usedModel = stepModel || model || null;
      write(() => db.from("ai_requests").insert({
        id: randomUUID(), owner, provider: providerForModel(usedModel), model: usedModel,
        agent, input_tokens: norm.input, output_tokens: norm.output,
        cached_tokens: norm.cached, reasoning_tokens: norm.reasoning,
        duration_ms: durationMs, cost, build_id: session.id, project_id: projectId,
        byok: session.byok,
        trigger: contextMeta?.trigger || null,
        run_id: contextMeta?.runId || null,
        context: contextMeta ? { ...contextMeta, trigger: undefined, runId: undefined } : null,
        created_at: now(),
      }));
    }
    return seq;
  };

  session.repairDispatched = ({ prompt: repairText, round }) => {
    session.repairRounds += 1;
    session.round = round;
    session.step({ agent: "Lead Agent", kind: "repair", label: `Repair round ${round} dispatched`, prompt: repairText, round });
    write(() => db.from("diag_runs").update({ repair_rounds: session.repairRounds }).eq("id", session.id));
  };

  session.setPlan = (plan) => write(() => db.from("diag_runs").update({ plan: String(plan || "").slice(0, 100_000) }).eq("id", session.id));
  session.setByok = (value) => { session.byok = Boolean(value); };
  session.setModel = (m) => { if (m && !model) { model = m; write(() => db.from("diag_runs").update({ model: m }).eq("id", session.id)); } };

  session.finish = (status) => write(() => db.from("diag_runs").update({
    status,
    finished_at: now(),
    duration_ms: Date.now() - session.startedAt,
    agents: [...session.agents],
    totals: session.totals,
    repair_rounds: session.repairRounds,
  }).eq("id", session.id));

  // The exact stored output behind the most recent failures — quoted, never paraphrased.
  // RAW form (for Diagnostics / the explain endpoint / operator logs only).
  session.rawFailureEvidence = () => {
    if (!session.failures.length) {
      return "No diagnostics were captured for this failure — that is a platform bug in the diagnostics recorder, not an explanation of the build failure.";
    }
    const latest = session.failures.slice(-2);
    return [
      `Evidence from the stored diagnostics (Build ${session.id.slice(0, 8)}):`,
      ...latest.map((f) => `${f.label}:\n${f.excerpt.split("\n").map((l) => `> ${l}`).join("\n")}`),
      "The complete raw logs are in the Diagnostics view.",
    ].join("\n\n");
  };

  // CONVERSATION form: names which check failed and points at Diagnostics for the exact
  // output. Compiler/test text is never pasted into the chat (it carries server paths and
  // internals) — it stays in the owner-only Advanced Diagnostics surface.
  session.failureEvidence = () => {
    if (!session.failures.length) {
      return "No diagnostics were captured for this failure — that is a platform bug in the diagnostics recorder, not an explanation of the build failure.";
    }
    const labels = [...new Set(session.failures.slice(-3).map((f) => f.label))];
    return [
      `What failed: ${labels.join(", ")}.`,
      `The exact output is saved with this build — open Build Diagnostics (${session.id.slice(0, 8)}) to read it or ask me to explain it.`,
    ].join(" ");
  };

  // Per-job recorder handed to buildJobs.runJob (job.diag). Buffers this job's terminal
  // output and flushes it as one step when the job ends.
  session.recorderForJob = ({ round = session.round } = {}) => {
    const terminalLines = [];
    return {
      sessionId: session.id,
      setModel: (m) => session.setModel(m),
      setByok: (value) => session.setByok(value),
      terminal: (line) => { terminalLines.push(`${now()} ${String(line)}`); },
      step: (spec) => session.step({ ...spec, round }),
      files: (baseline, tree, { label = "File changes" } = {}) => {
        const changes = treeChanges(baseline, tree);
        if (!changes.created.length && !changes.modified.length && !changes.deleted.length) return;
        session.step({
          agent: "Builder", kind: "files", label, round,
          output: JSON.stringify(changes, null, 2),
        });
      },
      jobEnd: (status) => {
        if (terminalLines.length) {
          session.step({
            kind: "terminal", label: `Terminal output (round ${round})`, round,
            status: status === "complete" ? "ok" : "failed",
            output: terminalLines.join("\n"),
          });
        }
      },
    };
  };

  return session;
}

// No-op session for paths where diagnostics must never throw (e.g. storage down): every
// method exists and does nothing, and failureEvidence reports the capture gap honestly.
export function nullDiagSession() {
  const noop = () => {};
  return {
    id: null, step: noop, repairDispatched: noop, setPlan: noop, setModel: noop, finish: noop,
    failureEvidence: () => "No diagnostics were captured for this failure — that is a platform bug in the diagnostics recorder, not an explanation of the build failure.",
    rawFailureEvidence: () => "No diagnostics were captured for this failure — that is a platform bug in the diagnostics recorder, not an explanation of the build failure.",
    recorderForJob: () => ({ sessionId: null, setModel: noop, setByok: noop, terminal: noop, step: noop, files: noop, jobEnd: noop }),
  };
}

export async function startDiagSessionSafe(spec) {
  try {
    return await createDiagSession(spec);
  } catch (error) {
    console.error("[diag] session unavailable:", error.message);
    return nullDiagSession();
  }
}

// ── Queries (owner-scoped) ──────────────────────────────────────────────────────────────

export async function listDiagRuns(owner, { projectId = null, limit = 40, client = null } = {}) {
  const db = client || serviceClient();
  let query = db.from("diag_runs").select("id, project_id, conversation_id, kind, status, prompt, model, agents, repair_rounds, totals, started_at, finished_at, duration_ms")
    .eq("owner", owner).order("started_at", { ascending: false }).limit(limit);
  if (projectId) query = query.eq("project_id", projectId);
  const { data, error } = await query;
  if (error) throw new Error(`diagnostics list failed: ${error.message}`);
  return (data || []).map((run) => ({ ...run, prompt: String(run.prompt || "").slice(0, 300) }));
}

export async function getDiagRun(owner, runId, { client = null, full = false } = {}) {
  const db = client || serviceClient();
  const { data: run } = await db.from("diag_runs").select("*").eq("id", runId).eq("owner", owner).maybeSingle();
  if (!run) return null;
  const { data: steps } = await db.from("diag_steps").select("*").eq("run_id", runId).order("seq");
  return {
    ...run,
    steps: (steps || []).map((step) => {
      const output = unpackOutput(step);
      const truncated = !full && output != null && output.length > STEP_INLINE_CAP;
      return {
        seq: step.seq, round: step.round, agent: step.agent, kind: step.kind, label: step.label,
        status: step.status, prompt: step.prompt, usage: step.usage, cost: step.cost,
        startedAt: step.started_at, durationMs: step.duration_ms,
        output: truncated ? output.slice(0, STEP_INLINE_CAP) : output,
        truncated,
      };
    }),
  };
}

export async function getDiagStepOutput(owner, runId, seq, { client = null } = {}) {
  const db = client || serviceClient();
  const { data: run } = await db.from("diag_runs").select("id").eq("id", runId).eq("owner", owner).maybeSingle();
  if (!run) return null;
  const { data: step } = await db.from("diag_steps").select("*").eq("run_id", runId).eq("seq", seq).maybeSingle();
  if (!step) return null;
  return { seq: step.seq, label: step.label, output: unpackOutput(step) ?? "", prompt: step.prompt };
}

// ── Evidence-grounded failure explanation ───────────────────────────────────────────────

export function failingSteps(run) {
  return (run?.steps || []).filter((step) => step.status === "failed"
    && ["compiler", "test", "lint", "runtime", "verification", "terminal"].includes(step.kind));
}

export async function explainBuildFailure(owner, runId, { client = null, provider = null } = {}) {
  const run = await getDiagRun(owner, runId, { client, full: true });
  if (!run) return { found: false, explanation: "That Build ID has no stored diagnostics for your account." };

  const failures = failingSteps(run);
  if (!failures.length) {
    if (run.status === "passed" || run.status === "complete_unverified") {
      return { found: true, explanation: "This build did not fail — its stored diagnostics contain no failing compiler, test, lint, runtime or verification output." };
    }
    return {
      found: true,
      explanation: "Diagnostics were not captured for this failure: the run is recorded, but no failing compiler, test, lint or runtime output was stored. That is a platform bug in the diagnostics recorder — I won't invent a cause without evidence.",
      missingDiagnostics: true,
    };
  }

  const evidence = failures.slice(-3).map((step) =>
    `── ${step.label} (${step.kind}, round ${step.round}) ──\n${tail(step.output, 60, 6000)}`).join("\n\n");
  const quoted = `Exact stored output responsible:\n\n${evidence}`;

  if (!provider) {
    try {
      const { createCodingModel } = await import("../modelGateway.mjs");
      provider = createCodingModel("auto");
    } catch { provider = null; }
  }
  if (provider) {
    try {
      const turn = await provider.turn({
        instructions: [
          "You are explaining a failed software build to its owner using ONLY the stored diagnostic logs provided.",
          "Rules: quote the exact failing lines verbatim (in code blocks) as your evidence; never speculate beyond what the logs show;",
          "if the logs are insufficient to determine a cause, say exactly that. Keep it under 250 words, plain language, and end with the most likely smallest fix IF the logs support one.",
        ].join(" "),
        input: `Original request: ${String(run.prompt || "").slice(0, 500)}\nFinal status: ${run.status} after ${run.repair_rounds || 0} repair round(s).\n\nSTORED FAILING OUTPUT:\n${evidence}`,
        tools: [],
      });
      if (turn?.text?.trim()) return { found: true, explanation: turn.text.trim(), evidence: quoted };
    } catch (error) {
      console.error("[diag] explain model call failed:", error.message);
    }
  }
  return { found: true, explanation: quoted, evidence: quoted };
}

// ── Retention: prefs, compression of aged logs, cleanup ─────────────────────────────────

export async function getDiagPrefs(owner, { client = null } = {}) {
  const db = client || serviceClient();
  const { data } = await db.from("diag_prefs").select("retention_days").eq("owner", owner).maybeSingle();
  return { retentionDays: data ? data.retention_days : DIAG_DEFAULT_RETENTION_DAYS };
}

export async function setDiagPrefs(owner, retentionDays, { client = null } = {}) {
  if (!DIAG_RETENTION_CHOICES.includes(retentionDays)) {
    const error = new Error("Retention must be 30, 90, 365 days, or forever.");
    error.status = 400;
    throw error;
  }
  const db = client || serviceClient();
  const { error } = await db.from("diag_prefs").upsert({ owner, retention_days: retentionDays, updated_at: now() });
  if (error) throw new Error(`could not save retention: ${error.message}`);
  return { retentionDays };
}

export async function sweepDiagnostics({ client = null, nowMs = Date.now() } = {}) {
  const db = client || serviceClient();
  const results = { purgedRuns: 0, compressedSteps: 0, interrupted: 0 };

  // Runs whose process died stay "running" forever otherwise — mark them honestly.
  const staleCutoff = new Date(nowMs - 2 * 60 * 60_000).toISOString();
  const { data: stale } = await db.from("diag_runs").select("id").eq("status", "running").lt("started_at", staleCutoff);
  for (const run of stale || []) {
    await db.from("diag_runs").update({ status: "interrupted", finished_at: now() }).eq("id", run.id);
    results.interrupted += 1;
  }

  // Retention cleanup per owner (default 90 days; null pref = forever).
  const { data: owners } = await db.from("diag_runs").select("owner").not("status", "eq", "running");
  const distinct = [...new Set((owners || []).map((r) => r.owner))];
  for (const owner of distinct) {
    const { retentionDays } = await getDiagPrefs(owner, { client: db });
    if (retentionDays == null) continue;
    const cutoff = new Date(nowMs - retentionDays * 86_400_000).toISOString();
    const { data: expired } = await db.from("diag_runs").select("id").eq("owner", owner).lt("started_at", cutoff);
    for (const run of expired || []) {
      await db.from("diag_steps").delete().eq("run_id", run.id);
      await db.from("diag_runs").delete().eq("id", run.id);
      results.purgedRuns += 1;
      console.log(JSON.stringify({ audit: "diagnostics_retention_purge", owner, run: run.id, retentionDays, at: now() }));
    }
  }

  // Compress inline logs on runs older than 7 days.
  const compressCutoff = new Date(nowMs - 7 * 86_400_000).toISOString();
  const { data: aged } = await db.from("diag_runs").select("id").lt("started_at", compressCutoff);
  for (const run of aged || []) {
    const { data: steps } = await db.from("diag_steps").select("id, output").eq("run_id", run.id).not("output", "is", null);
    for (const step of steps || []) {
      if (!step.output || Buffer.byteLength(step.output, "utf8") < 512) continue;
      await db.from("diag_steps").update({
        output: null,
        output_gz: gzipSync(Buffer.from(step.output, "utf8")).toString("base64"),
      }).eq("id", step.id);
      results.compressedSteps += 1;
    }
  }
  return results;
}

let sweepTimer = null;
export function startDiagnosticsSweeper() {
  if (sweepTimer) return;
  const interval = Math.max(Number(process.env.DIAG_SWEEP_MS || 6 * 60 * 60_000), 60_000);
  sweepTimer = setInterval(() => {
    sweepDiagnostics()
      .then(({ purgedRuns, compressedSteps, interrupted }) => {
        if (purgedRuns || compressedSteps || interrupted) {
          console.log(`[diag] sweep: purged=${purgedRuns} compressed=${compressedSteps} interrupted=${interrupted}`);
        }
      })
      .catch((error) => console.error("[diag] sweep:", error.message));
  }, interval);
  sweepTimer.unref?.();
}
export function stopDiagnosticsSweeper() {
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
}
