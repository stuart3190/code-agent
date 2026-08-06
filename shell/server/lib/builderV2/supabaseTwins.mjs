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
import { treeHashOf } from "./indexer.mjs";

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
  for (const [path, file] of treeIndex.files) {
    const existing = unwrap(await client.from("bv2_file_revisions").select("id")
      .eq("owner", owner).eq("project_id", projectId)
      .eq("path", path).eq("content_hash", file.contentHash).maybeSingle(), "revision lookup");
    if (existing) continue;

    const revision = unwrap(await client.from("bv2_file_revisions").insert({
      owner, project_id: projectId, path,
      content_hash: file.contentHash, size_bytes: file.sizeBytes,
      tokens: file.tokens, opaque: file.opaque,
    }).select("id").single(), "revision insert");

    const symbolIds = new Map();
    for (const symbol of file.symbols) {
      const row = unwrap(await client.from("bv2_symbols").insert({
        owner, project_id: projectId, revision_id: revision.id, path,
        name: symbol.name, kind: symbol.kind,
        exported: symbol.exported, is_default: symbol.isDefault,
        start_offset: symbol.start, end_offset: symbol.end,
        block_hash: symbol.blockHash, meta: symbol.meta,
      }).select("id").single(), "symbol insert");
      symbolIds.set(symbol.name, row.id);
    }

    const refRows = treeIndex.refs
      .filter((r) => r.fromPath === path && symbolIds.has(r.fromSymbol))
      .map((r) => ({
        owner, project_id: projectId, revision_id: revision.id,
        from_symbol: symbolIds.get(r.fromSymbol),
        ref_name: r.refName, resolved_path: r.resolvedPath,
      }));
    if (refRows.length) unwrap(await client.from("bv2_symbol_refs").insert(refRows), "refs insert");

    const edgeRows = treeIndex.edges
      .filter((e) => e.fromPath === path)
      .map((e) => ({
        owner, project_id: projectId, revision_id: revision.id,
        from_path: e.fromPath, to_path: e.toPath, specifier: e.specifier,
      }));
    if (edgeRows.length) unwrap(await client.from("bv2_dependency_edges").insert(edgeRows), "edges insert");

    written.push(path);
  }
  return { written };
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

  for (const [path, contentHash] of Object.entries(manifest)) {
    const revision = unwrap(await client.from("bv2_file_revisions").select("*")
      .eq("owner", owner).eq("project_id", projectId)
      .eq("path", path).eq("content_hash", contentHash).maybeSingle(), "revision load");
    if (!revision) { missing.push(path); continue; }

    const symbols = unwrap(await client.from("bv2_symbols").select("*")
      .eq("revision_id", revision.id).order("start_offset"), "symbols load");
    const symbolNameById = new Map(symbols.map((s) => [s.id, s.name]));

    files.set(path, {
      path,
      contentHash: revision.content_hash,
      sizeBytes: revision.size_bytes,
      tokens: revision.tokens,
      opaque: revision.opaque,
      symbols: symbols.map((s) => ({
        name: s.name, kind: s.kind, exported: s.exported, isDefault: s.is_default,
        start: s.start_offset, end: s.end_offset, blockHash: s.block_hash, meta: s.meta,
      })),
      imports: [], // reconstructed below from edges (specifier-level)
      refs: [],
    });

    const revEdges = unwrap(await client.from("bv2_dependency_edges").select("*")
      .eq("revision_id", revision.id), "edges load");
    for (const edge of revEdges) {
      edges.push({ fromPath: edge.from_path, toPath: edge.to_path, specifier: edge.specifier });
      files.get(path).imports.push({ specifier: edge.specifier });
    }

    const revRefs = unwrap(await client.from("bv2_symbol_refs").select("*")
      .eq("revision_id", revision.id), "refs load");
    for (const ref of revRefs) {
      refs.push({
        fromPath: path,
        fromSymbol: symbolNameById.get(ref.from_symbol) || "?",
        refName: ref.ref_name,
        resolvedPath: ref.resolved_path,
      });
    }
  }

  return { files, edges, refs, treeHash: treeHashOf(files), missing };
}

/** The persisted graph: rows out of the database, answering through the SAME graph code. */
export async function supabaseGraph(owner, projectId, manifest, { client = serviceClient() } = {}) {
  const loaded = await loadIndex(owner, projectId, manifest, { client });
  if (loaded.missing.length) {
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
      const bytes = Buffer.byteLength(content);
      if (bytes <= INLINE_LIMIT) {
        unwrap(await client.from("bv2_blobs").upsert({
          owner, content_hash: contentHash, content, storage_path: null, size_bytes: bytes,
        }, { onConflict: "owner,content_hash" }), "blob upsert");
        return;
      }
      const storagePath = `${BV2_BUCKET_PREFIX}/${owner}/${contentHash}`;
      const { error: upErr } = await client.storage.from(bucket)
        .upload(storagePath, Buffer.from(content), { upsert: true, contentType: "text/plain" });
      if (upErr) throw new Error(`blob bucket upload: ${upErr.message}`);
      unwrap(await client.from("bv2_blobs").upsert({
        owner, content_hash: contentHash, content: null, storage_path: storagePath, size_bytes: bytes,
      }, { onConflict: "owner,content_hash" }), "blob row upsert");
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
