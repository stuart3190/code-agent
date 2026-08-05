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

export function treeHashFromPairs(pairs) {
  return sha256(pairs.map(([path, hash]) => `${path} ${hash}`).sort().join("\n"));
}

export const PROMOTABLE_LABELS = Object.freeze(["green", "preview", "published"]);

/** The storage seam. Memory twin below; the supabase twin (commit J) implements the same shape. */
export function memorySnapshotStorage() {
  const blobs = new Map();      // `${owner}:${hash}` -> content
  const snapshots = new Map();  // id -> row
  const manifests = new Map();  // id -> [{path, contentHash}]
  const pointers = new Map();   // `${owner}:${projectId}:${label}` -> snapshotId
  let idCounter = 0;
  return {
    async putBlob(owner, contentHash, content) { blobs.set(`${owner}:${contentHash}`, content); },
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
    async getSnapshot(id) { return snapshots.get(id) || null; },
    async listSnapshots(owner, projectId) {
      return [...snapshots.values()].filter((s) => s.owner === owner && s.project_id === projectId);
    },
    async listOwnerSnapshots(owner) {
      return [...snapshots.values()].filter((s) => s.owner === owner);
    },
    async deleteSnapshot(id) { snapshots.delete(id); manifests.delete(id); },

    async putManifest(id, entries) { manifests.set(id, entries.map((e) => ({ ...e }))); },
    async getManifest(id) { return (manifests.get(id) || []).map((e) => ({ ...e })); },

    async setPointer(owner, projectId, label, snapshotId) { pointers.set(`${owner}:${projectId}:${label}`, snapshotId); },
    async getPointer(owner, projectId, label) { return pointers.get(`${owner}:${projectId}:${label}`) || null; },
  };
}

export function createSnapshotStore(storage = memorySnapshotStorage()) {
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
        if (!(await storage.hasBlob(owner, contentHash))) {
          throw new Error(`snapshot aborted: blob for ${path} did not persist`);
        }
        entries.push({ path, contentHash });
      }
      const expectedTreeHash = treeHashFromPairs(entries.map((e) => [e.path, e.contentHash]));

      // 2. snapshot row is born INERT.
      const id = await storage.insertSnapshot({
        owner, project_id: projectId, build_id: buildId, parent_snapshot: parent,
        tree_hash: expectedTreeHash, reason, state: "building",
        file_count: entries.length,
        total_tokens: Object.values(tree).reduce((t, c) => t + Math.ceil(String(c).length / 4), 0),
        asset_manifest: assetManifest, created_at: new Date().toISOString(),
      });

      // 3. complete manifest.
      await storage.putManifest(id, entries);

      // 4. VALIDATE from what was actually stored: every blob present, recomputed hash equal.
      const stored = await storage.getManifest(id);
      if (stored.length !== entries.length) throw new Error("snapshot aborted: manifest incomplete");
      for (const entry of stored) {
        if (!(await storage.hasBlob(owner, entry.contentHash))) {
          throw new Error(`snapshot aborted: missing blob for ${entry.path}`);
        }
      }
      const recomputed = treeHashFromPairs(stored.map((e) => [e.path, e.contentHash]));
      if (recomputed !== expectedTreeHash) throw new Error("snapshot aborted: tree hash mismatch");

      // 5. only now does it become usable.
      await storage.updateSnapshot(id, { state: "ready" });
      return { ...(await storage.getSnapshot(id)) };
    },

    async getSnapshot(id) { return storage.getSnapshot(id); },

    /** Owner-checked materialisation of a READY snapshot back into a tree. */
    async materialize(owner, id) {
      const snapshot = await storage.getSnapshot(id);
      if (!snapshot || snapshot.owner !== owner) throw new Error("snapshot not found for this owner");
      if (snapshot.state !== "ready") throw new Error(`snapshot is ${snapshot.state}, not ready`);
      const tree = {};
      for (const entry of await storage.getManifest(id)) {
        const content = await storage.getBlob(owner, entry.contentHash);
        if (content === null) {
          await storage.updateSnapshot(id, { state: "corrupt" });
          throw new Error(`snapshot corrupt: missing blob for ${entry.path}`);
        }
        tree[entry.path] = content;
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
      const previous = await storage.getPointer(owner, projectId, label);
      await storage.setPointer(owner, projectId, label, snapshotId);
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
