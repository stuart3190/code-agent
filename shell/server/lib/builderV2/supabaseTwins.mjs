// Supabase persistence twins for the graph and snapshot stores (finish plan WP-1;
// master plan commits I and J).
//
// The CONTRACT is the memory twins': same APIs, same answers — parity failure is a C7
// hard stop, enforced by the parity suite which runs the identical test bodies against
// both. Persistence correctness is proven by ROUND-TRIP: rows are written, read back,
// and the reconstructed index must answer every graph question exactly as the in-memory
// index does.
//
// Everything is owner-scoped at the query level (C1); blobs above the inline threshold go
// to the artifact bucket under bv2/<owner>/<hash> so a hash is never reachable without
// the owner path segment.

import crypto from "node:crypto";
import { serviceClient } from "../supabase.mjs";
import { memoryGraph } from "./graphStore.mjs";
import { INDEXER_VERSION, treeHashOf } from "./indexer.mjs";
import { fileGraphHash, fileGraphPayload, manifestOf } from "./graphParity.mjs";

const sha256 = (text) => crypto.createHash("sha256").update(text).digest("hex");
const INLINE_LIMIT = 64_000; // bytes; beyond this a blob lives in the bucket
export const BV2_BUCKET_PREFIX = "bv2";
const ARTIFACT_BUCKET = process.env.CODE_AGENT_ARTIFACT_BUCKET || "thrallo-artifacts";

function unwrap({ data, error }, what) {
  if (error) throw new Error(`${what}: ${error.message}`);
  return data;
}

// ── graph persistence (commit I) ──────────────────────────────────────────────────────────────

/**
 * Persist an indexTree() result. Idempotent: a (path, content_hash) revision that already
 * exists is left alone with all its children — re-persisting an unchanged tree writes nothing.
 */
export async function persistIndex(owner, projectId, treeIndex, { client = serviceClient() } = {}) {
  const written = [];
  const repaired = [];
  for (const [path] of treeIndex.files) {
    const payload = fileGraphPayload(treeIndex, path);
    const result = unwrap(await client.rpc("bv2_persist_file_revision", {
      p_owner: owner,
      p_project_id: projectId,
      p_file: payload.file,
      p_symbols: payload.symbols,
      p_refs: payload.refs,
      p_edges: payload.edges,
      p_graph_hash: fileGraphHash(treeIndex, path),
      p_indexer_version: INDEXER_VERSION,
    }), `atomic revision persist (${path})`);
    if (result?.written) written.push(path);
    if (result?.repaired) repaired.push(path);
  }
  return { written, repaired, manifest: manifestOf(treeIndex) };
}

/**
 * Load the index for one manifest (path -> content_hash) back out of the database and
 * reconstruct the SAME shape indexTree() produces — so the graph built on it must answer
 * identically to the graph built in memory. Missing revisions are reported, never guessed.
 */
export async function loadIndex(owner, projectId, manifest, { client = serviceClient() } = {}) {
  const files = new Map();
  const edges = [];
  const refs = [];
  const missing = [];
  const incomplete = [];
  const integrity = [];
  const data = unwrap(await client.rpc("bv2_load_graph", {
    p_owner: owner,
    p_project_id: projectId,
    p_manifest: manifest,
  }), "graph batch load") || {};
  const revisions = data.revisions || [];
  const symbols = data.symbols || [];
  const refRows = data.refs || [];
  const edgeRows = data.edges || [];
  const revisionByPath = new Map(revisions.map((revision) => [revision.path, revision]));
  const childrenByRevision = (rows) => {
    const grouped = new Map();
    for (const row of rows) {
      if (!grouped.has(row.revision_id)) grouped.set(row.revision_id, []);
      grouped.get(row.revision_id).push(row);
    }
    return grouped;
  };
  const symbolsByRevision = childrenByRevision(symbols);
  const refsByRevision = childrenByRevision(refRows);
  const edgesByRevision = childrenByRevision(edgeRows);

  for (const [path, contentHash] of Object.entries(manifest)) {
    const revision = revisionByPath.get(path);
    if (!revision || revision.content_hash !== contentHash) { missing.push(path); continue; }
    if (revision.state !== "ready") {
      incomplete.push({ path, revisionId: revision.id, state: revision.state });
      missing.push(path);
      continue;
    }
    const revisionSymbols = (symbolsByRevision.get(revision.id) || []).sort((a, b) => a.ordinal - b.ordinal);
    const revisionRefs = (refsByRevision.get(revision.id) || []).sort((a, b) => a.ordinal - b.ordinal);
    const revisionEdges = (edgesByRevision.get(revision.id) || []).sort((a, b) => a.ordinal - b.ordinal);
    const symbolNameById = new Map(revisionSymbols.map((symbol) => [symbol.id, symbol.name]));
    const file = {
      path,
      contentHash: revision.content_hash,
      sizeBytes: revision.size_bytes,
      tokens: revision.tokens,
      opaque: revision.opaque,
      symbols: revisionSymbols.map((symbol) => ({
        name: symbol.name, kind: symbol.kind, exported: symbol.exported, isDefault: symbol.is_default,
        start: symbol.start_offset, end: symbol.end_offset, blockHash: symbol.block_hash, meta: symbol.meta,
      })),
      imports: revisionEdges.map((edge) => ({ specifier: edge.specifier })),
      refs: [],
    };
    files.set(path, file);
    for (const edge of revisionEdges) {
      edges.push({ fromPath: edge.from_path, toPath: edge.to_path, specifier: edge.specifier });
    }
    for (const ref of revisionRefs) {
      const fromSymbol = symbolNameById.get(ref.from_symbol);
      if (!fromSymbol) {
        integrity.push({ path, revisionId: revision.id, problem: "reference source symbol missing", refId: ref.id });
        continue;
      }
      refs.push({ fromPath: path, fromSymbol, refName: ref.ref_name, resolvedPath: ref.resolved_path });
      file.refs.push({ fromSymbol, refName: ref.ref_name });
    }
    const actualCounts = { symbols: revisionSymbols.length, refs: revisionRefs.length, edges: revisionEdges.length };
    const declaredCounts = { symbols: revision.symbol_count, refs: revision.ref_count, edges: revision.edge_count };
    if (JSON.stringify(actualCounts) !== JSON.stringify(declaredCounts)) {
      integrity.push({ path, revisionId: revision.id, problem: "child counts differ", declaredCounts, actualCounts });
    }
  }

  const loaded = { files, edges, refs, treeHash: treeHashOf(files), missing, incomplete, integrity };
  for (const [path] of files) {
    const revision = revisionByPath.get(path);
    const computed = fileGraphHash(loaded, path);
    if (computed !== revision.graph_hash) {
      integrity.push({ path, revisionId: revision.id, problem: "graph hash differs", expected: revision.graph_hash, actual: computed });
    }
  }
  return loaded;
}

/** The persisted graph: rows out of the database, answering through the SAME graph code. */
export async function supabaseGraph(owner, projectId, manifest, { client = serviceClient() } = {}) {
  const loaded = await loadIndex(owner, projectId, manifest, { client });
  if (loaded.missing.length || loaded.incomplete.length || loaded.integrity.length) {
    loaded.missing = [...new Set([
      ...loaded.missing,
      ...loaded.incomplete.map((row) => row.path),
      ...loaded.integrity.map((row) => row.path),
    ])];
    throw new Error(`graph store is stale — reindex needed for: ${loaded.missing.join(", ")}`);
  }
  return memoryGraph(owner, projectId, loaded);
}

// ── snapshot persistence (commit J) ───────────────────────────────────────────────────────────

/**
 * The snapshot storage seam over bv2_blobs / bv2_snapshots / bv2_snapshot_files /
 * bv2_project_pointers, drop-in for memorySnapshotStorage(). Large blobs go to the artifact
 * bucket; the row keeps the pointer. All reads owner-scoped.
 */
export function supabaseSnapshotStorage({ client = serviceClient(), bucket = ARTIFACT_BUCKET } = {}) {
  return {
    async putBlob(owner, contentHash, content) {
      const body = String(content);
      if (sha256(body) !== contentHash) throw new Error("blob content does not match content hash");
      const existing = unwrap(await client.from("bv2_blobs").select("content,storage_path")
        .eq("owner", owner).eq("content_hash", contentHash).maybeSingle(), "blob immutability probe");
      if (existing) {
        const prior = existing.content !== null && existing.content !== undefined
          ? existing.content
          : await (async () => {
            const { data, error } = await client.storage.from(bucket).download(existing.storage_path);
            if (error) return null;
            return Buffer.from(await data.arrayBuffer()).toString("utf8");
          })();
        if (prior === null || sha256(String(prior)) !== contentHash) throw new Error("immutable blob is corrupt");
        return;
      }
      const bytes = Buffer.byteLength(content);
      if (bytes <= INLINE_LIMIT) {
        unwrap(await client.from("bv2_blobs").upsert({
          owner, content_hash: contentHash, content, storage_path: null, size_bytes: bytes,
        }, { onConflict: "owner,content_hash" }), "blob upsert");
        const stored = await this.getBlob(owner, contentHash);
        if (stored === null || sha256(String(stored)) !== contentHash) throw new Error("blob byte verification failed");
        return;
      }
      const storagePath = `${BV2_BUCKET_PREFIX}/${owner}/${contentHash}`;
      const { error: upErr } = await client.storage.from(bucket)
        .upload(storagePath, Buffer.from(content), { upsert: true, contentType: "text/plain" });
      if (upErr) throw new Error(`blob bucket upload: ${upErr.message}`);
      unwrap(await client.from("bv2_blobs").upsert({
        owner, content_hash: contentHash, content: null, storage_path: storagePath, size_bytes: bytes,
      }, { onConflict: "owner,content_hash" }), "blob row upsert");
      const stored = await this.getBlob(owner, contentHash);
      if (stored === null || sha256(String(stored)) !== contentHash) throw new Error("blob byte verification failed");
    },

    async hasBlob(owner, contentHash) {
      const row = unwrap(await client.from("bv2_blobs").select("content_hash")
        .eq("owner", owner).eq("content_hash", contentHash).maybeSingle(), "blob probe");
      return !!row;
    },

    async getBlob(owner, contentHash) {
      const row = unwrap(await client.from("bv2_blobs").select("content,storage_path")
        .eq("owner", owner).eq("content_hash", contentHash).maybeSingle(), "blob read");
      if (!row) return null;
      if (row.content !== null && row.content !== undefined) return row.content;
      const { data, error } = await client.storage.from(bucket).download(row.storage_path);
      if (error) return null; // missing object = corrupt, caller marks the snapshot
      return Buffer.from(await data.arrayBuffer()).toString("utf8");
    },

    async deleteBlob(owner, contentHash) {
      const row = unwrap(await client.from("bv2_blobs").select("storage_path")
        .eq("owner", owner).eq("content_hash", contentHash).maybeSingle(), "blob delete probe");
      if (row?.storage_path) await client.storage.from(bucket).remove([row.storage_path]);
      unwrap(await client.from("bv2_blobs").delete()
        .eq("owner", owner).eq("content_hash", contentHash), "blob delete");
    },

    async listOwnerBlobHashes(owner) {
      const rows = unwrap(await client.from("bv2_blobs").select("content_hash")
        .eq("owner", owner), "blob list");
      return rows.map((r) => r.content_hash);
    },

    async insertSnapshot(row) {
      const inserted = unwrap(await client.from("bv2_snapshots").insert(row).select("id").single(), "snapshot insert");
      return inserted.id;
    },
    async updateSnapshot(id, patch) {
      unwrap(await client.from("bv2_snapshots").update(patch).eq("id", id), "snapshot update");
    },
    async finalizeSnapshot(id, { treeHash, fileCount }) {
      const row = unwrap(await client.from("bv2_snapshots").update({ state: "ready" })
        .eq("id", id).eq("state", "building").eq("tree_hash", treeHash).eq("file_count", fileCount)
        .select("id").maybeSingle(), "snapshot finalise");
      return !!row;
    },
    async getSnapshot(id) {
      return unwrap(await client.from("bv2_snapshots").select("*").eq("id", id).maybeSingle(), "snapshot read");
    },
    async listSnapshots(owner, projectId) {
      return unwrap(await client.from("bv2_snapshots").select("*")
        .eq("owner", owner).eq("project_id", projectId), "snapshot list");
    },
    async listOwnerSnapshots(owner) {
      return unwrap(await client.from("bv2_snapshots").select("*").eq("owner", owner), "snapshot owner list");
    },
    async deleteSnapshot(id) {
      unwrap(await client.from("bv2_snapshots").delete().eq("id", id), "snapshot delete");
    },

    async putManifest(id, entries) {
      if (!entries.length) return;
      unwrap(await client.from("bv2_snapshot_files")
        .insert(entries.map((e) => ({ snapshot_id: id, path: e.path, content_hash: e.contentHash }))), "manifest insert");
    },
    async getManifest(id) {
      const rows = unwrap(await client.from("bv2_snapshot_files").select("path,content_hash")
        .eq("snapshot_id", id), "manifest read");
      return rows.map((r) => ({ path: r.path, contentHash: r.content_hash }));
    },

    async setPointer(owner, projectId, label, snapshotId) {
      unwrap(await client.from("bv2_project_pointers").upsert({
        owner, project_id: projectId, label, snapshot_id: snapshotId,
        updated_at: new Date().toISOString(),
      }, { onConflict: "owner,project_id,label" }), "pointer write");
    },
    async getPointer(owner, projectId, label) {
      const row = unwrap(await client.from("bv2_project_pointers").select("snapshot_id")
        .eq("owner", owner).eq("project_id", projectId).eq("label", label).maybeSingle(), "pointer read");
      return row?.snapshot_id || null;
    },
    async compareAndSetPointer(owner, projectId, label, expected, snapshotId) {
      if (expected === null) {
        const { error } = await client.from("bv2_project_pointers").insert({
          owner, project_id: projectId, label, snapshot_id: snapshotId,
          updated_at: new Date().toISOString(),
        });
        if (error?.code === "23505") return false;
        if (error) throw new Error(`pointer compare-and-set: ${error.message}`);
        return true;
      }
      const row = unwrap(await client.from("bv2_project_pointers").update({
        snapshot_id: snapshotId, updated_at: new Date().toISOString(),
      }).eq("owner", owner).eq("project_id", projectId).eq("label", label)
        .eq("snapshot_id", expected).select("snapshot_id").maybeSingle(), "pointer compare-and-set");
      return row?.snapshot_id === snapshotId;
    },
  };
}

/** Remove every bv2 row a test owner created — the replay's cleanup. */
export async function purgeOwnerForTests(owner, { client = serviceClient(), bucket = ARTIFACT_BUCKET } = {}) {
  const blobRows = unwrap(await client.from("bv2_blobs").select("storage_path").eq("owner", owner), "purge blob list");
  const objects = blobRows.map((r) => r.storage_path).filter(Boolean);
  if (objects.length) await client.storage.from(bucket).remove(objects);
  for (const table of ["bv2_project_pointers", "bv2_snapshots", "bv2_blobs",
    "bv2_file_revisions", "bv2_project_knowledge", "bv2_builds", "bv2_contracts", "bv2_assets"]) {
    unwrap(await client.from(table).delete().eq("owner", owner), `purge ${table}`);
  }
}

export { sha256 as contentHashOf };
