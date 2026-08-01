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

export function createCheckpointStore({ max = DEFAULT_MAX_CHECKPOINTS } = {}) {
  const entries = [];
  let seq = 0;

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
      const entry = {
        id: `cp-${seq}`,
        seq,
        // Shallow copy: the tree is a flat path -> string map, so this is a real snapshot
        // and callers cannot mutate a stored checkpoint by editing the live tree.
        tree: tree ? { ...tree } : null,
        fileCount: tree ? Object.keys(tree).length : 0,
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
