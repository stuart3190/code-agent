// Immutable Snapshot Store (master plan Part 2 §6 + Part 8, corrections C1 and C2).
//
// C1 — blobs are content-addressed PER OWNER: (owner, contentHash) is the identity. Two
// owners storing identical bytes hold independent entries; resolution, GC and snapshot
// materialisation are owner-scoped everywhere, so no tenant can probe or perturb another.
//
// C2 — creation is ATOMIC in effect: blobs are persisted and verified first, the snapshot
// row is born `building`, the complete manifest is written, the tree hash is recomputed
// FROM THE STORED MANIFEST AND BLOBS and compared, and only then does the snapshot flip to
// `ready`. Anything interrupted stays `building` — unpromotable, unmaterialisable, swept by
// GC. Promotion is one pointer write per label; rollback is one pointer write back.

import crypto from "node:crypto";

const sha256 = (text) => crypto.createHash("sha256").update(text).digest("hex");
const canonicalJson = (value) => JSON.stringify(value, (_, current) => (
  current && typeof current === "object" && !Array.isArray(current)
    ? Object.fromEntries(Object.entries(current).sort(([a], [b]) => a.localeCompare(b)))
    : current
));

export function treeHashFromPairs(pairs) {
  return sha256(pairs.map(([path, hash]) => `${path} ${hash}`).sort().join("\n"));
}

export const PROMOTABLE_LABELS = Object.freeze(["green", "preview", "published"]);
export const CANDIDATE_REASON_PREFIX = "candidate:";

/** The storage seam. Memory twin below; the supabase twin (commit J) implements the same shape. */
export function memorySnapshotStorage() {
  const blobs = new Map();      // `${owner}:${hash}` -> content
  const snapshots = new Map();  // id -> row
  const manifests = new Map();  // id -> [{path, contentHash}]
  const pointers = new Map();   // `${owner}:${projectId}:${label}` -> snapshotId
  let idCounter = 0;
  return {
    async putBlob(owner, contentHash, content) {
      const bytes = String(content);
      if (sha256(bytes) !== contentHash) throw new Error("blob content does not match content hash");
      const key = `${owner}:${contentHash}`;
      if (blobs.has(key) && blobs.get(key) !== bytes) throw new Error("immutable blob collision");
      if (!blobs.has(key)) blobs.set(key, bytes);
    },
    async hasBlob(owner, contentHash) { return blobs.has(`${owner}:${contentHash}`); },
    async getBlob(owner, contentHash) {
      // C1: resolution is owner-scoped — another owner's identical hash is invisible here.
      return blobs.has(`${owner}:${contentHash}`) ? blobs.get(`${owner}:${contentHash}`) : null;
    },
    async deleteBlob(owner, contentHash) { blobs.delete(`${owner}:${contentHash}`); },
    async listOwnerBlobHashes(owner) {
      const prefix = owner + ":";
      return [...blobs.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
    },

    async insertSnapshot(row) { const id = `snap-${++idCounter}`; snapshots.set(id, { ...row, id }); return id; },
    async updateSnapshot(id, patch) { Object.assign(snapshots.get(id), patch); },
    async finalizeSnapshot(id, { treeHash, fileCount }) {
      const row = snapshots.get(id);
      if (!row || row.state !== "building" || row.tree_hash !== treeHash || row.file_count !== fileCount) return false;
      row.state = "ready";
      return true;
    },
    async getSnapshot(id) { return snapshots.get(id) || null; },
    async listSnapshots(owner, projectId) {
      return [...snapshots.values()].filter((s) => s.owner === owner && s.project_id === projectId);
    },
    async listOwnerSnapshots(owner) {
      return [...snapshots.values()].filter((s) => s.owner === owner);
    },
    async deleteSnapshot(id) { snapshots.delete(id); manifests.delete(id); },

    async putManifest(id, entries) {
      if (manifests.has(id)) throw new Error("snapshot manifest is immutable");
      manifests.set(id, entries.map((e) => ({ ...e })));
    },
    async getManifest(id) { return (manifests.get(id) || []).map((e) => ({ ...e })); },

    async setPointer(owner, projectId, label, snapshotId) { pointers.set(`${owner}:${projectId}:${label}`, snapshotId); },
    async getPointer(owner, projectId, label) { return pointers.get(`${owner}:${projectId}:${label}`) || null; },
    async compareAndSetPointer(owner, projectId, label, expected, snapshotId) {
      const key = `${owner}:${projectId}:${label}`;
      const current = pointers.get(key) || null;
      if (current !== expected) return false;
      pointers.set(key, snapshotId);
      return true;
    },
  };
}

export function createSnapshotStore(storage = memorySnapshotStorage()) {
  async function reusableReadySnapshot(owner, projectId, treeHash, entries, assetManifest) {
    const existing = (await storage.listSnapshots(owner, projectId))
      .find((snapshot) => snapshot.owner === owner && snapshot.project_id === projectId
        && snapshot.tree_hash === treeHash && snapshot.state === "ready"
        && canonicalJson(snapshot.asset_manifest || []) === canonicalJson(assetManifest || []));
    if (!existing) return null;
    const expected = entries.map((entry) => `${entry.path}:${entry.contentHash}`).sort();
    const actual = (await storage.getManifest(existing.id))
      .map((entry) => `${entry.path}:${entry.contentHash}`).sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error("content-addressed snapshot identity has a mismatched manifest");
    }
    for (const entry of entries) {
      const content = await storage.getBlob(owner, entry.contentHash);
      if (content === null || sha256(String(content)) !== entry.contentHash) {
        throw new Error(`content-addressed snapshot is corrupt for ${entry.path}`);
      }
    }
    return { ...existing, reused: true };
  }

  return {
    /**
     * C2 creation protocol. Throws (and leaves nothing usable) rather than ever exposing a
     * half-written snapshot. Returns the ready snapshot row.
     */
    async createSnapshot(owner, projectId, tree, { buildId = null, parent = null, reason = "initial", assetManifest = [] } = {}) {
      // 1. persist and VERIFY every blob first.
      const entries = [];
      for (const [path, content] of Object.entries(tree)) {
        const contentHash = sha256(String(content));
        await storage.putBlob(owner, contentHash, String(content));
        const storedContent = await storage.getBlob(owner, contentHash);
        if (storedContent === null || sha256(String(storedContent)) !== contentHash) {
          throw new Error(`snapshot aborted: blob bytes for ${path} do not match content hash`);
        }
        entries.push({ path, contentHash });
      }
      const expectedTreeHash = treeHashFromPairs(entries.map((e) => [e.path, e.contentHash]));

      // Snapshot identity is content-addressed per project. A repair that restores the exact
      // previous green bytes must reuse that immutable row rather than fail its unique index or
      // create duplicate history. Manifest and blob bytes are re-proven before reuse.
      const existing = await reusableReadySnapshot(owner, projectId, expectedTreeHash, entries, assetManifest);
      if (existing) return existing;

      // 2. snapshot row is born INERT.
      let id;
      try {
        id = await storage.insertSnapshot({
          owner, project_id: projectId, build_id: buildId, parent_snapshot: parent,
          tree_hash: expectedTreeHash, reason, state: "building",
          file_count: entries.length,
          total_tokens: Object.values(tree).reduce((t, c) => t + Math.ceil(String(c).length / 4), 0),
          asset_manifest: assetManifest, created_at: new Date().toISOString(),
        });
      } catch (error) {
        // Concurrent identical finalisation may have won after the first probe. Reuse only a fully
        // ready, byte-proven winner; an incomplete/broken row still fails loudly and is retryable.
        const winner = await reusableReadySnapshot(owner, projectId, expectedTreeHash, entries, assetManifest);
        if (winner) return winner;
        throw error;
      }

      // 3. complete manifest.
      await storage.putManifest(id, entries);

      // 4. VALIDATE from what was actually stored: every blob present, recomputed hash equal.
      const stored = await storage.getManifest(id);
      if (stored.length !== entries.length) throw new Error("snapshot aborted: manifest incomplete");
      for (const entry of stored) {
        const content = await storage.getBlob(owner, entry.contentHash);
        if (content === null || sha256(String(content)) !== entry.contentHash) {
          throw new Error(`snapshot aborted: corrupt blob for ${entry.path}`);
        }
      }
      const recomputed = treeHashFromPairs(stored.map((e) => [e.path, e.contentHash]));
      if (recomputed !== expectedTreeHash) throw new Error("snapshot aborted: tree hash mismatch");

      // 5. only now does it become usable.
      if (!(await storage.finalizeSnapshot(id, { treeHash: expectedTreeHash, fileCount: entries.length }))) {
        throw new Error("snapshot aborted: finalisation precondition failed");
      }
      return { ...(await storage.getSnapshot(id)) };
    },

    async getSnapshot(id) { return storage.getSnapshot(id); },

    /** Locate the newest immutable checkpoint for one owner/project/build. */
    async latestForBuild(owner, projectId, buildId, { reasonPrefix = null, reasonPrefixes = null } = {}) {
      const prefixes = reasonPrefixes || (reasonPrefix ? [reasonPrefix] : []);
      return (await storage.listSnapshots(owner, projectId))
        .filter((snapshot) => snapshot.owner === owner && snapshot.project_id === projectId
          && snapshot.build_id === buildId && snapshot.state === "ready"
          && (!prefixes.length || prefixes.some((prefix) => String(snapshot.reason || "").startsWith(prefix))))
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0] || null;
    },

    /**
     * Advance an immutable candidate's metadata only after deterministic, compile and browser
     * verification gates pass.
     * Bytes and manifest never change. A candidate cannot be pointed at while this transition is
     * pending; a reused previously-qualified snapshot is returned unchanged.
     */
    async markCandidateValidated(owner, projectId, snapshotId, { reason }) {
      if (!String(reason || "").startsWith("working:")) throw new Error("validated candidate needs a working:* reason");
      const snapshot = await storage.getSnapshot(snapshotId);
      if (!snapshot || snapshot.owner !== owner || snapshot.project_id !== projectId) {
        throw new Error("candidate snapshot not found for this owner/project");
      }
      if (snapshot.state !== "ready") throw new Error(`candidate snapshot is ${snapshot.state}, not ready`);
      await this.materialize(owner, snapshotId);
      if (String(snapshot.reason || "").startsWith(CANDIDATE_REASON_PREFIX)) {
        await storage.updateSnapshot(snapshotId, { reason });
        return { ...(await storage.getSnapshot(snapshotId)) };
      }
      return { ...snapshot, reusedQualified: true };
    },

    /**
     * Cancellation discards unpromoted checkpoints for exactly one build. Failed/blocked builds
     * deliberately retain their newest checkpoint for targeted resume; ordinary GC bounds them.
     */
    async discardWorking(owner, projectId, buildId) {
      const pointed = new Set();
      for (const label of PROMOTABLE_LABELS) {
        const target = await storage.getPointer(owner, projectId, label);
        if (target) pointed.add(target);
      }
      const matches = (await storage.listSnapshots(owner, projectId)).filter((snapshot) => (
        snapshot.owner === owner && snapshot.project_id === projectId && snapshot.build_id === buildId
        && (String(snapshot.reason || "").startsWith("working:")
          || String(snapshot.reason || "").startsWith(CANDIDATE_REASON_PREFIX)) && !pointed.has(snapshot.id)
      ));
      for (const snapshot of matches) await storage.deleteSnapshot(snapshot.id);
      if (matches.length) await this.gc(owner, projectId, { keepLatest: 20 });
      return { removed: matches.map((snapshot) => snapshot.id).sort() };
    },

    /** Owner-checked materialisation of a READY snapshot back into a tree. */
    async materialize(owner, id) {
      const snapshot = await storage.getSnapshot(id);
      if (!snapshot || snapshot.owner !== owner) throw new Error("snapshot not found for this owner");
      if (snapshot.state !== "ready") throw new Error(`snapshot is ${snapshot.state}, not ready`);
      const tree = {};
      const manifest = await storage.getManifest(id);
      if (manifest.length !== snapshot.file_count) {
        await storage.updateSnapshot(id, { state: "corrupt" });
        throw new Error("snapshot corrupt: manifest file count mismatch");
      }
      for (const entry of manifest) {
        const content = await storage.getBlob(owner, entry.contentHash);
        if (content === null || sha256(String(content)) !== entry.contentHash) {
          await storage.updateSnapshot(id, { state: "corrupt" });
          throw new Error(`snapshot corrupt: blob bytes do not match content hash for ${entry.path}`);
        }
        tree[entry.path] = content;
      }
      const materializedHash = treeHashFromPairs(manifest.map((entry) => [entry.path, sha256(String(tree[entry.path]))]));
      if (materializedHash !== snapshot.tree_hash) {
        await storage.updateSnapshot(id, { state: "corrupt" });
        throw new Error("snapshot corrupt: materialized tree hash mismatch");
      }
      return tree;
    },

    async diff(idA, idB) {
      const a = new Map((await storage.getManifest(idA)).map((e) => [e.path, e.contentHash]));
      const b = new Map((await storage.getManifest(idB)).map((e) => [e.path, e.contentHash]));
      const added = [...b.keys()].filter((p) => !a.has(p)).sort();
      const removed = [...a.keys()].filter((p) => !b.has(p)).sort();
      const changed = [...b.keys()].filter((p) => a.has(p) && a.get(p) !== b.get(p)).sort();
      return { added, removed, changed };
    },

    /** Promotion: one atomic pointer write; only READY snapshots, only known labels. */
    async promote(owner, projectId, label, snapshotId) {
      if (!PROMOTABLE_LABELS.includes(label)) throw new Error(`unknown promotion label ${label}`);
      const snapshot = await storage.getSnapshot(snapshotId);
      if (!snapshot || snapshot.owner !== owner || snapshot.project_id !== projectId) {
        throw new Error("snapshot not found for this owner/project");
      }
      if (snapshot.state !== "ready") throw new Error(`only ready snapshots promote (this one is ${snapshot.state})`);
      if (String(snapshot.reason || "").startsWith(CANDIDATE_REASON_PREFIX)) {
        throw new Error("candidate snapshots are internal and cannot promote before validation");
      }
      await this.materialize(owner, snapshotId); // byte proof immediately before activation
      const previous = await storage.getPointer(owner, projectId, label);
      if (!(await storage.compareAndSetPointer(owner, projectId, label, previous, snapshotId))) {
        throw new Error("snapshot promotion conflict: pointer changed concurrently");
      }
      return { label, snapshotId, previous };
    },

    async pointer(owner, projectId, label) { return storage.getPointer(owner, projectId, label); },

    /** Rollback IS promotion of the previous snapshot: one pointer write. */
    async rollback(owner, projectId, label, previousSnapshotId) {
      return this.promote(owner, projectId, label, previousSnapshotId);
    },

    /**
     * GC: sweeps `building` strays and unlabelled snapshots beyond `keepLatest`, then any of
     * THIS OWNER's blobs no retained snapshot references. Never touches another owner's blobs
     * (C1) and never a pointer target.
     */
    async gc(owner, projectId, { keepLatest = 20 } = {}) {
      const all = (await storage.listSnapshots(owner, projectId))
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
      const pointed = new Set();
      for (const label of PROMOTABLE_LABELS) {
        const target = await storage.getPointer(owner, projectId, label);
        if (target) pointed.add(target);
      }
      const keep = new Set(pointed);
      let kept = 0;
      for (const snapshot of all) {
        if (snapshot.state === "ready" && (kept < keepLatest || keep.has(snapshot.id))) {
          keep.add(snapshot.id);
          kept += 1;
        }
      }
      const removedSnapshots = [];
      for (const snapshot of all) {
        if (keep.has(snapshot.id)) continue;
        await storage.deleteSnapshot(snapshot.id);
        removedSnapshots.push(snapshot.id);
      }
      // Blob sweep — this owner only, and referenced means referenced by ANY of the owner's
      // surviving snapshots in ANY project: per-owner dedup means two projects can share a
      // hash, and a per-project reference check would delete the other project's bytes.
      const referenced = new Set();
      for (const snapshot of await storage.listOwnerSnapshots(owner)) {
        for (const entry of await storage.getManifest(snapshot.id)) referenced.add(entry.contentHash);
      }
      const removedBlobs = [];
      for (const hash of await storage.listOwnerBlobHashes(owner)) {
        if (!referenced.has(hash)) {
          await storage.deleteBlob(owner, hash);
          removedBlobs.push(hash);
        }
      }
      return { removedSnapshots, removedBlobs };
    },
  };
}
