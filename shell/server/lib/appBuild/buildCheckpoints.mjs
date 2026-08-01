// Lightweight restorable checkpoints for the app-build repair loop.
//
// The defect this closes: persistBuildResult wrote the tree for ANY completed job — including
// one whose checks failed — and repair jobs hydrate the stored tree when dispatched without
// one. A failed repair therefore permanently replaced a better project state with a worse
// one, with no way back.
//
// Deliberately NOT ca_checkpoints: that table belongs to the repo-agent runs pipeline
// (git shas, sandbox snapshot ids) and coupling the two would make each pipeline's retention
// and semantics the other's problem. This is an in-memory, bounded, per-lifecycle store —
// the lifetime a repair loop actually needs — plus a restore that writes the chosen tree
// back through the same projects update the pipeline already uses.

// Quality ranking. "Last known good" is the highest-ranked checkpoint recorded so far, so a
// verified state always outranks a merely-compiling one.
export const CHECKPOINT_MARKS = Object.freeze({
  "verification-failed": 0,
  generated: 1,
  compiled: 2,
  "preview-ready": 3,
  "verification-passed": 4,
});

export const DEFAULT_MAX_CHECKPOINTS = 6;

// Retention: a lifecycle's checkpoints outlive it long enough to recover from a restart
// that happened mid-build, then expire. Env-overridable for operators.
export function checkpointRetentionHours() {
  const value = Number(process.env.THRALLO_CHECKPOINT_RETENTION_HOURS || 0);
  return Number.isFinite(value) && value > 0 ? value : 48;
}

// Nothing secret may enter a checkpoint payload. The SAVED tree is already env-free by
// construction (withRuntimeEnv only decorates the RUNTIME copy), but a checkpoint is a new
// durable copy of user code, so it is scrubbed explicitly rather than by assumption.
const SECRET_PATH = /(^|\/)\.env(\.|$)|(^|\/)\.npmrc$|(^|\/)(secrets?|credentials?)\.(json|ya?ml|txt)$|\.pem$|\.key$/i;
const SECRET_LINE = /\b(api[_-]?key|secret[_-]?key|access[_-]?token|service[_-]?role|password|client[_-]?secret|private[_-]?key|bearer)\b\s*[:=]/i;

export function scrubTree(tree) {
  if (!tree) return null;
  const out = {};
  let removed = 0;
  for (const [path, contents] of Object.entries(tree)) {
    if (SECRET_PATH.test(path)) { removed += 1; continue; }
    if (typeof contents === "string" && SECRET_LINE.test(contents)) {
      // Redact the offending assignments rather than dropping the user's file.
      out[path] = contents.split("\n")
        .map((line) => (SECRET_LINE.test(line) ? line.replace(/([:=]\s*).*$/, "$1[redacted]") : line))
        .join("\n");
      removed += 1;
      continue;
    }
    out[path] = contents;
  }
  return { tree: out, redacted: removed };
}

export function markForState({ compileOk = null, previewOk = null, verificationPassed = null } = {}) {
  if (verificationPassed === true) return "verification-passed";
  if (verificationPassed === false) return "verification-failed";
  if (previewOk === true) return "preview-ready";
  if (compileOk === true) return "compiled";
  return "generated";
}

export function checkpointRank(mark) {
  return CHECKPOINT_MARKS[mark] ?? 0;
}

// `persist` is an async writer invoked fire-and-forget after each create; `seed` hydrates a
// store from rows already in the database (a lifecycle resuming after a restart). Both are
// optional, so the pure in-memory behaviour shipped in #119 is unchanged when they're absent.
export function createCheckpointStore({ max = DEFAULT_MAX_CHECKPOINTS, persist = null, seed = [] } = {}) {
  const entries = [];
  let seq = 0;

  for (const row of seed || []) {
    seq = Math.max(seq, Number(row.seq) || 0);
    entries.push({
      id: row.id,
      seq: Number(row.seq) || 0,
      tree: row.tree || null,
      fileCount: Number(row.file_count) || (row.tree ? Object.keys(row.tree).length : 0),
      buildId: row.build_id || null,
      jobId: row.job_id || null,
      attempt: Number(row.attempt) || 1,
      status: row.status || null,
      compileOk: row.compile_ok,
      previewOk: row.preview_ok,
      verificationPassed: row.verification_passed,
      mark: row.mark || "generated",
      diagRef: null,
      usageTotals: row.usage_totals || null,
      label: row.label || null,
      createdAtSeq: Number(row.seq) || 0,
      persisted: true,
    });
  }
  entries.sort((a, b) => a.seq - b.seq);

  // Retention: keep the most recent `max`, but NEVER evict the best-ranked checkpoint —
  // that one is the safety net the whole feature exists for.
  const prune = () => {
    while (entries.length > max) {
      const best = bestIndex();
      const victim = entries.findIndex((_, i) => i !== best);
      if (victim === -1) break;
      entries.splice(victim, 1);
    }
  };

  const bestIndex = () => {
    let best = -1;
    let bestScore = -1;
    entries.forEach((entry, index) => {
      const score = checkpointRank(entry.mark);
      // Ties go to the later checkpoint: same quality, more recent work.
      if (score >= bestScore) { bestScore = score; best = index; }
    });
    return best;
  };

  return {
    create({
      tree, buildId = null, jobId = null, attempt = 1, status = null,
      compileOk = null, previewOk = null, verificationPassed = null,
      diagRef = null, usageTotals = null, label = null,
    } = {}) {
      seq += 1;
      // Scrubbed before it is stored anywhere — in memory or durably. A checkpoint is a
      // durable copy of user code and must never carry a credential.
      const scrubbed = scrubTree(tree);
      const entry = {
        id: `cp-${seq}`,
        seq,
        // Shallow copy: the tree is a flat path -> string map, so this is a real snapshot
        // and callers cannot mutate a stored checkpoint by editing the live tree.
        tree: scrubbed ? scrubbed.tree : null,
        fileCount: scrubbed ? Object.keys(scrubbed.tree).length : 0,
        redacted: scrubbed ? scrubbed.redacted : 0,
        buildId, jobId, attempt, status,
        compileOk, previewOk, verificationPassed,
        mark: markForState({ compileOk, previewOk, verificationPassed }),
        diagRef,
        usageTotals: usageTotals ? { ...usageTotals } : null,
        label,
        createdAtSeq: seq,
      };
      entries.push(entry);
      prune();
      // Durability is best-effort and never blocks a build: a failed write costs the
      // restart-recovery safety net, not the user's work.
      if (persist) { try { persist(entry); } catch { /* logged by the writer */ } }
      return entry;
    },

    list() { return entries.map((e) => ({ ...e, tree: undefined })); },
    size() { return entries.length; },
    latest() { return entries.length ? entries[entries.length - 1] : null; },

    // The best state this lifecycle has reached.
    lastKnownGood() {
      const index = bestIndex();
      return index === -1 ? null : entries[index];
    },

    get(id) { return entries.find((e) => e.id === id) || null; },

    // The checkpoint to fall back to when the newest state is worse than an earlier one.
    // Returns null when the latest IS the best — there is nothing better to restore.
    betterThanLatest() {
      const latest = this.latest();
      const good = this.lastKnownGood();
      if (!latest || !good || good.id === latest.id) return null;
      return checkpointRank(good.mark) > checkpointRank(latest.mark) ? good : null;
    },
  };
}

// ── Durable storage ─────────────────────────────────────────────────────────────────────
// build_checkpoints is service-role only (RLS on, zero policies) and every query filters by
// owner, so a checkpoint is reachable by exactly one tenant.

export const CHECKPOINT_TABLE = "build_checkpoints";

export function checkpointWriter({ client, owner, projectId, buildId }) {
  return (entry) => {
    const expiresAt = new Date(Date.now() + checkpointRetentionHours() * 3_600_000).toISOString();
    Promise.resolve(client.from(CHECKPOINT_TABLE).insert({
      owner, build_id: buildId, project_id: projectId,
      job_id: entry.jobId, attempt: entry.attempt, seq: entry.seq,
      mark: entry.mark, compile_ok: entry.compileOk, preview_ok: entry.previewOk,
      verification_passed: entry.verificationPassed, status: entry.status,
      label: entry.label, file_count: entry.fileCount,
      tree: entry.tree || {}, usage_totals: entry.usageTotals,
      expires_at: expiresAt,
    })).then(({ error } = {}) => {
      if (error) console.error("[checkpoints] persist:", error.message);
    }).catch((error) => console.error("[checkpoints] persist:", error.message));
  };
}

// Rows for a lifecycle, oldest first, bounded to the same ring size.
export async function loadCheckpointRows({ client, owner, buildId = null, projectId = null, max = DEFAULT_MAX_CHECKPOINTS }) {
  try {
    let query = client.from(CHECKPOINT_TABLE).select("*").eq("owner", owner);
    query = buildId ? query.eq("build_id", buildId) : query.eq("project_id", projectId);
    const { data, error } = await query.order("seq", { ascending: false }).limit(max);
    if (error) { console.error("[checkpoints] load:", error.message); return []; }
    return (data || []).slice().reverse();
  } catch (error) {
    console.error("[checkpoints] load:", error.message);
    return [];
  }
}

// A store hydrated from durable rows — the restart-recovery entry point.
export async function restoreCheckpointStore({ client, owner, buildId = null, projectId = null, max = DEFAULT_MAX_CHECKPOINTS }) {
  const seed = await loadCheckpointRows({ client, owner, buildId, projectId, max });
  return createCheckpointStore({
    max, seed,
    persist: buildId ? checkpointWriter({ client, owner, projectId, buildId }) : null,
  });
}

// Retention sweep: drop expired rows, and keep each lifecycle bounded even if a build wrote
// more checkpoints than the ring would have kept. The best-marked row per lifecycle is never
// deleted while the lifecycle is inside its retention window.
export async function sweepCheckpoints({ client, now = new Date(), batch = 500 } = {}) {
  try {
    const { data, error } = await client.from(CHECKPOINT_TABLE)
      .delete().lt("expires_at", now.toISOString()).limit(batch).select("id");
    if (error) { console.error("[checkpoints] sweep:", error.message); return 0; }
    return data?.length || 0;
  } catch (error) {
    console.error("[checkpoints] sweep:", error.message);
    return 0;
  }
}

// Lifecycle completion: a finished build keeps only its best checkpoint (the safety net for
// a later "put it back" request) and releases the rest immediately.
export async function releaseLifecycleCheckpoints({ client, owner, buildId, keepBest = true }) {
  try {
    const rows = await loadCheckpointRows({ client, owner, buildId, max: 100 });
    if (!rows.length) return 0;
    const best = keepBest
      ? rows.reduce((a, b) => (checkpointRank(b.mark) >= checkpointRank(a.mark) ? b : a))
      : null;
    const doomed = rows.filter((row) => row.id !== best?.id).map((row) => row.id);
    if (!doomed.length) return 0;
    const { error } = await client.from(CHECKPOINT_TABLE).delete().eq("owner", owner).in("id", doomed);
    if (error) { console.error("[checkpoints] release:", error.message); return 0; }
    return doomed.length;
  } catch (error) {
    console.error("[checkpoints] release:", error.message);
    return 0;
  }
}

// Restore writes a checkpoint's tree back as the project's current state. The caller owns
// the client so this stays testable and so the pipeline keeps one persistence path.
export async function restoreCheckpoint(checkpoint, { client, owner, projectId }) {
  if (!checkpoint?.tree) return { restored: false, reason: "checkpoint carries no tree" };
  const { error } = await client.from("projects").update({
    tree: checkpoint.tree,
    updated_at: new Date().toISOString(),
  }).eq("id", projectId).eq("owner", owner);
  if (error) return { restored: false, reason: error.message };
  return { restored: true, checkpointId: checkpoint.id, mark: checkpoint.mark, fileCount: checkpoint.fileCount };
}
