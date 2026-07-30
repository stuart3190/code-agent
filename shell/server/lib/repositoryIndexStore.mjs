import { optionalEnv } from "./env.mjs";
import { newId } from "./codeAgentContracts.mjs";
import { serviceClient } from "./supabase.mjs";

const now = () => new Date().toISOString();

export class MemoryRepositoryIndexStore {
  constructor() {
    this.indexes = new Map();
    this.files = new Map();
    this.chunks = new Map();
    this.symbols = new Map();
    this.relations = new Map();
  }

  async beginIndex(owner, repositoryId, headSha, embeddingModel) {
    const current = this.indexes.get(repositoryId);
    const row = {
      repository_id: repositoryId,
      owner,
      version: Number(current?.version || 0) + 1,
      head_sha: headSha,
      status: "indexing",
      file_count: Number(current?.file_count || 0),
      chunk_count: Number(current?.chunk_count || 0),
      indexed_bytes: Number(current?.indexed_bytes || 0),
      embedding_model: embeddingModel,
      progress_phase: "scanning",
      progress_current: 0,
      progress_total: 0,
      last_error: null,
      started_at: now(),
      completed_at: null,
      created_at: current?.created_at || now(),
      updated_at: now(),
    };
    this.indexes.set(repositoryId, row);
    return row;
  }

  async getIndex(owner, repositoryId) {
    const row = this.indexes.get(repositoryId);
    return row?.owner === owner ? row : null;
  }

  async indexStatusCounts() {
    const counts = {};
    for (const row of this.indexes.values()) {
      const status = row.status || "unknown";
      counts[status] = (counts[status] || 0) + 1;
    }
    return counts;
  }

  async requestRefresh(owner, repositoryId, {
    reason = "manual",
    requestedBy = null,
    requestedHeadSha = null,
  } = {}) {
    const current = this.indexes.get(repositoryId);
    const row = current || {
      repository_id: repositoryId,
      owner,
      version: 0,
      file_count: 0,
      chunk_count: 0,
      indexed_bytes: 0,
      symbol_count: 0,
      relation_count: 0,
      dependency_count: 0,
      embedding_model: null,
      created_at: now(),
    };
    const alreadyIndexing = current?.status === "indexing";
    Object.assign(row, {
      owner,
      status: alreadyIndexing ? "indexing" : "queued",
      refresh_reason: reason,
      refresh_requested_by: requestedBy,
      refresh_requested_at: now(),
      requested_head_sha: requestedHeadSha,
      claimed_at: alreadyIndexing ? current.claimed_at : null,
      progress_phase: alreadyIndexing ? current.progress_phase : "queued",
      progress_current: alreadyIndexing ? current.progress_current : 0,
      progress_total: alreadyIndexing ? current.progress_total : 0,
      last_error: null,
      updated_at: now(),
    });
    this.indexes.set(repositoryId, row);
    return row;
  }

  async claimRefreshes(limit = 1) {
    const rows = [...this.indexes.values()]
      .filter((row) => row.status === "queued")
      .sort((a, b) => String(a.refresh_requested_at).localeCompare(String(b.refresh_requested_at)))
      .slice(0, Math.min(Math.max(Number(limit) || 1, 1), 10));
    for (const row of rows) {
      Object.assign(row, {
        status: "indexing",
        claimed_at: now(),
        started_at: now(),
        completed_at: null,
        progress_phase: "provisioning",
        progress_current: 0,
        progress_total: 0,
        updated_at: now(),
      });
    }
    return rows;
  }

  async updateProgress(owner, repositoryId, phase, current = 0, total = 0) {
    const row = await this.getIndex(owner, repositoryId);
    if (!row) return null;
    Object.assign(row, {
      progress_phase: phase,
      progress_current: Math.max(Number(current) || 0, 0),
      progress_total: Math.max(Number(total) || 0, 0),
      updated_at: now(),
    });
    return row;
  }

  async listFiles(owner, repositoryId) {
    return [...this.files.values()].filter((row) => row.owner === owner && row.repository_id === repositoryId);
  }

  async upsertFile(owner, repositoryId, input) {
    const existing = [...this.files.values()]
      .find((row) => row.repository_id === repositoryId && row.path_hash === input.path_hash);
    const row = {
      id: existing?.id || newId(),
      owner,
      repository_id: repositoryId,
      created_at: existing?.created_at || now(),
      ...existing,
      ...input,
    };
    this.files.set(row.id, row);
    return row;
  }

  async replaceFileChunks(owner, repositoryId, fileId, chunks) {
    for (const [id, row] of this.chunks) {
      if (row.file_id === fileId) this.chunks.delete(id);
    }
    const rows = chunks.map((input) => ({
      id: newId(),
      owner,
      repository_id: repositoryId,
      file_id: fileId,
      created_at: now(),
      metadata: {},
      ...input,
    }));
    for (const row of rows) this.chunks.set(row.id, row);
    return rows;
  }

  async replaceRepositoryGraph(owner, repositoryId, symbols, relations) {
    for (const [id, row] of this.relations) {
      if (row.owner === owner && row.repository_id === repositoryId) this.relations.delete(id);
    }
    for (const [id, row] of this.symbols) {
      if (row.owner === owner && row.repository_id === repositoryId) this.symbols.delete(id);
    }
    for (const input of symbols) {
      const row = { created_at: now(), metadata: {}, ...input, owner, repository_id: repositoryId };
      this.symbols.set(row.id, row);
    }
    for (const input of relations) {
      const row = { created_at: now(), metadata: {}, ...input, owner, repository_id: repositoryId };
      this.relations.set(row.id, row);
    }
    return { symbolCount: symbols.length, relationCount: relations.length };
  }

  async findSymbols(owner, repositoryId, nameHashes, limit = 30) {
    const hashes = new Set(nameHashes || []);
    return [...this.symbols.values()]
      .filter((row) => row.owner === owner && row.repository_id === repositoryId && hashes.has(row.name_hash))
      .sort((a, b) => Number(a.start_line) - Number(b.start_line))
      .slice(0, Math.min(Math.max(Number(limit) || 30, 1), 100));
  }

  async relationsForSymbols(owner, repositoryId, symbolIds, nameHashes, limit = 200) {
    const ids = new Set(symbolIds || []);
    const hashes = new Set(nameHashes || []);
    return [...this.relations.values()]
      .filter((row) => row.owner === owner && row.repository_id === repositoryId
        && (ids.has(row.target_symbol_id) || hashes.has(row.target_name_hash)))
      .slice(0, Math.min(Math.max(Number(limit) || 200, 1), 500));
  }

  async fileRelations(owner, repositoryId, fileId, limit = 500) {
    return [...this.relations.values()]
      .filter((row) => row.owner === owner && row.repository_id === repositoryId
        && (row.source_file_id === fileId || row.target_file_id === fileId))
      .slice(0, Math.min(Math.max(Number(limit) || 500, 1), 1_000));
  }

  async filesByIds(owner, repositoryId, ids) {
    const wanted = new Set(ids || []);
    return [...this.files.values()]
      .filter((row) => row.owner === owner && row.repository_id === repositoryId && wanted.has(row.id));
  }

  async symbolsByIds(owner, repositoryId, ids) {
    const wanted = new Set(ids || []);
    return [...this.symbols.values()]
      .filter((row) => row.owner === owner && row.repository_id === repositoryId && wanted.has(row.id));
  }

  async deleteFiles(owner, repositoryId, ids) {
    const targets = new Set(ids);
    for (const id of targets) {
      const file = this.files.get(id);
      if (!file || file.owner !== owner || file.repository_id !== repositoryId) continue;
      this.files.delete(id);
      for (const [chunkId, chunk] of this.chunks) {
        if (chunk.file_id === id) this.chunks.delete(chunkId);
      }
    }
  }

  async countChunks(owner, repositoryId) {
    return [...this.chunks.values()]
      .filter((row) => row.owner === owner && row.repository_id === repositoryId).length;
  }

  async completeIndex(owner, repositoryId, patch) {
    const current = await this.getIndex(owner, repositoryId);
    if (!current) throw new Error("Repository index disappeared.");
    const requeue = current.refresh_requested_at
      && current.started_at
      && Date.parse(current.refresh_requested_at) > Date.parse(current.started_at);
    Object.assign(current, {
      ...patch,
      status: requeue ? "queued" : "ready",
      progress_phase: requeue ? "queued" : "ready",
      progress_current: Number(patch.file_count || current.file_count || 0),
      progress_total: Number(patch.file_count || current.file_count || 0),
      refresh_reason: requeue ? current.refresh_reason : null,
      refresh_requested_by: requeue ? current.refresh_requested_by : null,
      refresh_requested_at: requeue ? current.refresh_requested_at : null,
      requested_head_sha: requeue ? current.requested_head_sha : null,
      claimed_at: null,
      last_error: null,
      completed_at: now(),
      updated_at: now(),
    });
    return current;
  }

  async failIndex(owner, repositoryId, error) {
    const current = await this.getIndex(owner, repositoryId);
    if (!current) return null;
    const requeue = current.refresh_requested_at
      && current.started_at
      && Date.parse(current.refresh_requested_at) > Date.parse(current.started_at);
    Object.assign(current, {
      status: requeue ? "queued" : "error",
      progress_phase: requeue ? "queued" : "error",
      progress_current: requeue ? 0 : current.progress_current,
      progress_total: requeue ? 0 : current.progress_total,
      claimed_at: null,
      last_error: requeue ? null : String(error || "Indexing failed").slice(0, 2_000),
      completed_at: now(),
      updated_at: now(),
    });
    return current;
  }

  async search(owner, repositoryId, { embedding, tokenHashes, limit = 12 }) {
    const queryTokens = new Set(tokenHashes || []);
    const rows = [...this.chunks.values()]
      .filter((row) => row.owner === owner && row.repository_id === repositoryId)
      .map((row) => {
        const keyword = (row.token_hashes || []).filter((token) => queryTokens.has(token)).length;
        const semantic = embedding && row.embedding ? cosineSimilarity(embedding, row.embedding) : 0;
        return { ...row, score: keyword * 0.08 + semantic };
      })
      .filter((row) => row.score > 0)
      .sort((a, b) => b.score - a.score || a.start_line - b.start_line)
      .slice(0, Math.min(Math.max(Number(limit) || 12, 1), 30));
    return rows.map((row) => ({ ...row, file: this.files.get(row.file_id) }));
  }
}

export class SupabaseRepositoryIndexStore {
  constructor(client = serviceClient()) {
    this.client = client;
  }

  async beginIndex(owner, repositoryId, headSha, embeddingModel) {
    const current = await this.getIndex(owner, repositoryId);
    const { data, error } = await this.client.from("ca_repository_indexes").upsert({
      owner,
      repository_id: repositoryId,
      version: Number(current?.version || 0) + 1,
      head_sha: headSha,
      status: "indexing",
      embedding_model: embeddingModel,
      progress_phase: "scanning",
      progress_current: 0,
      progress_total: 0,
      last_error: null,
      started_at: now(),
      completed_at: null,
      updated_at: now(),
    }, { onConflict: "repository_id" }).select("*").single();
    return unwrapOne(data, error);
  }

  async getIndex(owner, repositoryId) {
    return unwrapMaybe(await this.client.from("ca_repository_indexes").select("*")
      .eq("owner", owner).eq("repository_id", repositoryId).maybeSingle());
  }

  async indexStatusCounts() {
    const rows = unwrap(await this.client.from("ca_repository_indexes")
      .select("status").limit(5_000));
    const counts = {};
    for (const row of rows) {
      const status = row.status || "unknown";
      counts[status] = (counts[status] || 0) + 1;
    }
    return counts;
  }

  async requestRefresh(owner, repositoryId, {
    reason = "manual",
    requestedBy = null,
    requestedHeadSha = null,
  } = {}) {
    const current = await this.getIndex(owner, repositoryId);
    const alreadyIndexing = current?.status === "indexing";
    const { data, error } = await this.client.from("ca_repository_indexes").upsert({
      owner,
      repository_id: repositoryId,
      status: alreadyIndexing ? "indexing" : "queued",
      refresh_reason: reason,
      refresh_requested_by: requestedBy,
      refresh_requested_at: now(),
      requested_head_sha: requestedHeadSha,
      claimed_at: alreadyIndexing ? current.claimed_at : null,
      progress_phase: alreadyIndexing ? current.progress_phase : "queued",
      progress_current: alreadyIndexing ? current.progress_current : 0,
      progress_total: alreadyIndexing ? current.progress_total : 0,
      last_error: null,
      updated_at: now(),
    }, { onConflict: "repository_id" }).select("*").single();
    return unwrapOne(data, error);
  }

  async claimRefreshes(limit = 1) {
    const { data, error } = await this.client.rpc("claim_repository_index_refreshes", {
      p_limit: Math.min(Math.max(Number(limit) || 1, 1), 10),
    });
    return unwrap({ data, error });
  }

  async updateProgress(owner, repositoryId, phase, current = 0, total = 0) {
    const { data, error } = await this.client.from("ca_repository_indexes").update({
      progress_phase: phase,
      progress_current: Math.max(Number(current) || 0, 0),
      progress_total: Math.max(Number(total) || 0, 0),
      updated_at: now(),
    }).eq("owner", owner).eq("repository_id", repositoryId).select("*").maybeSingle();
    return unwrapMaybe({ data, error });
  }

  async listFiles(owner, repositoryId) {
    return unwrap(await this.client.from("ca_repository_index_files").select("*")
      .eq("owner", owner).eq("repository_id", repositoryId));
  }

  async upsertFile(owner, repositoryId, input) {
    const { data, error } = await this.client.from("ca_repository_index_files").upsert({
      owner,
      repository_id: repositoryId,
      ...input,
    }, { onConflict: "repository_id,path_hash" }).select("*").single();
    return unwrapOne(data, error);
  }

  async replaceFileChunks(owner, repositoryId, fileId, chunks) {
    const { error: deleteError } = await this.client.from("ca_repository_index_chunks")
      .delete().eq("owner", owner).eq("repository_id", repositoryId).eq("file_id", fileId);
    if (deleteError) throw new Error(deleteError.message);
    if (!chunks.length) return [];
    const rows = [];
    for (let offset = 0; offset < chunks.length; offset += 100) {
      const { data, error } = await this.client.from("ca_repository_index_chunks")
        .insert(chunks.slice(offset, offset + 100).map((input) => ({
          owner,
          repository_id: repositoryId,
          file_id: fileId,
          ...input,
        }))).select("*");
      rows.push(...unwrapOne(data || [], error));
    }
    return rows;
  }

  async replaceRepositoryGraph(owner, repositoryId, symbols, relations) {
    const { error: relationDeleteError } = await this.client.from("ca_repository_relations")
      .delete().eq("owner", owner).eq("repository_id", repositoryId);
    if (relationDeleteError) throw new Error(relationDeleteError.message);
    const { error: deleteError } = await this.client.from("ca_repository_symbols")
      .delete().eq("owner", owner).eq("repository_id", repositoryId);
    if (deleteError) throw new Error(deleteError.message);
    for (let offset = 0; offset < symbols.length; offset += 250) {
      const { error } = await this.client.from("ca_repository_symbols")
        .insert(symbols.slice(offset, offset + 250).map((row) => ({
          ...row,
          owner,
          repository_id: repositoryId,
        })));
      if (error) throw new Error(error.message);
    }
    for (let offset = 0; offset < relations.length; offset += 250) {
      const { error } = await this.client.from("ca_repository_relations")
        .insert(relations.slice(offset, offset + 250).map((row) => ({
          ...row,
          owner,
          repository_id: repositoryId,
        })));
      if (error) throw new Error(error.message);
    }
    return { symbolCount: symbols.length, relationCount: relations.length };
  }

  async findSymbols(owner, repositoryId, nameHashes, limit = 30) {
    if (!nameHashes?.length) return [];
    return unwrap(await this.client.from("ca_repository_symbols").select("*")
      .eq("owner", owner).eq("repository_id", repositoryId).in("name_hash", nameHashes)
      .order("start_line").limit(Math.min(Math.max(Number(limit) || 30, 1), 100)));
  }

  async relationsForSymbols(owner, repositoryId, symbolIds, nameHashes, limit = 200) {
    const rows = [];
    const boundedLimit = Math.min(Math.max(Number(limit) || 200, 1), 500);
    if (symbolIds?.length) {
      rows.push(...unwrap(await this.client.from("ca_repository_relations").select("*")
        .eq("owner", owner).eq("repository_id", repositoryId)
        .in("target_symbol_id", symbolIds).limit(boundedLimit)));
    }
    if (nameHashes?.length && rows.length < boundedLimit) {
      rows.push(...unwrap(await this.client.from("ca_repository_relations").select("*")
        .eq("owner", owner).eq("repository_id", repositoryId)
        .in("target_name_hash", nameHashes).limit(boundedLimit - rows.length)));
    }
    return [...new Map(rows.map((row) => [row.id, row])).values()].slice(0, boundedLimit);
  }

  async fileRelations(owner, repositoryId, fileId, limit = 500) {
    return unwrap(await this.client.from("ca_repository_relations").select("*")
      .eq("owner", owner).eq("repository_id", repositoryId)
      .or(`source_file_id.eq.${fileId},target_file_id.eq.${fileId}`)
      .limit(Math.min(Math.max(Number(limit) || 500, 1), 1_000)));
  }

  async filesByIds(owner, repositoryId, ids) {
    if (!ids?.length) return [];
    return unwrap(await this.client.from("ca_repository_index_files").select("*")
      .eq("owner", owner).eq("repository_id", repositoryId).in("id", ids));
  }

  async symbolsByIds(owner, repositoryId, ids) {
    if (!ids?.length) return [];
    return unwrap(await this.client.from("ca_repository_symbols").select("*")
      .eq("owner", owner).eq("repository_id", repositoryId).in("id", ids));
  }

  async deleteFiles(owner, repositoryId, ids) {
    if (!ids.length) return;
    const { error } = await this.client.from("ca_repository_index_files").delete()
      .eq("owner", owner).eq("repository_id", repositoryId).in("id", ids);
    if (error) throw new Error(error.message);
  }

  async countChunks(owner, repositoryId) {
    const { count, error } = await this.client.from("ca_repository_index_chunks")
      .select("id", { count: "exact", head: true })
      .eq("owner", owner).eq("repository_id", repositoryId);
    if (error) throw new Error(error.message);
    return Number(count || 0);
  }

  async completeIndex(owner, repositoryId, patch) {
    const current = await this.getIndex(owner, repositoryId);
    const requeue = current?.refresh_requested_at
      && current?.started_at
      && Date.parse(current.refresh_requested_at) > Date.parse(current.started_at);
    const { data, error } = await this.client.from("ca_repository_indexes").update({
      ...patch,
      status: requeue ? "queued" : "ready",
      progress_phase: requeue ? "queued" : "ready",
      progress_current: Number(patch.file_count || 0),
      progress_total: Number(patch.file_count || 0),
      refresh_reason: requeue ? current.refresh_reason : null,
      refresh_requested_by: requeue ? current.refresh_requested_by : null,
      refresh_requested_at: requeue ? current.refresh_requested_at : null,
      requested_head_sha: requeue ? current.requested_head_sha : null,
      claimed_at: null,
      last_error: null,
      completed_at: now(),
      updated_at: now(),
    }).eq("owner", owner).eq("repository_id", repositoryId).select("*").single();
    return unwrapOne(data, error);
  }

  async failIndex(owner, repositoryId, errorValue) {
    const current = await this.getIndex(owner, repositoryId);
    const requeue = current?.refresh_requested_at
      && current?.started_at
      && Date.parse(current.refresh_requested_at) > Date.parse(current.started_at);
    const { data, error } = await this.client.from("ca_repository_indexes").update({
      status: requeue ? "queued" : "error",
      progress_phase: requeue ? "queued" : "error",
      progress_current: requeue ? 0 : current?.progress_current,
      progress_total: requeue ? 0 : current?.progress_total,
      claimed_at: null,
      last_error: requeue ? null : String(errorValue || "Indexing failed").slice(0, 2_000),
      completed_at: now(),
      updated_at: now(),
    }).eq("owner", owner).eq("repository_id", repositoryId).select("*").maybeSingle();
    return unwrapMaybe({ data, error });
  }

  async search(owner, repositoryId, { embedding, tokenHashes, limit = 12 }) {
    const { data: ranked, error: rankError } = await this.client.rpc("search_repository_index", {
      p_owner: owner,
      p_repository_id: repositoryId,
      p_query_embedding: embedding || null,
      p_token_hashes: tokenHashes || [],
      p_match_count: Math.min(Math.max(Number(limit) || 12, 1), 30),
    });
    if (rankError) throw new Error(rankError.message);
    const chunkIds = (ranked || []).map((row) => row.chunk_id);
    if (!chunkIds.length) return [];
    const chunks = unwrap(await this.client.from("ca_repository_index_chunks").select("*")
      .eq("owner", owner).eq("repository_id", repositoryId).in("id", chunkIds));
    const fileIds = [...new Set(chunks.map((row) => row.file_id))];
    const files = unwrap(await this.client.from("ca_repository_index_files").select("*")
      .eq("owner", owner).eq("repository_id", repositoryId).in("id", fileIds));
    const scoreById = new Map((ranked || []).map((row) => [row.chunk_id, Number(row.score || 0)]));
    const fileById = new Map(files.map((row) => [row.id, row]));
    return chunks
      .map((row) => ({ ...row, score: scoreById.get(row.id) || 0, file: fileById.get(row.file_id) }))
      .sort((a, b) => b.score - a.score);
  }
}

function cosineSimilarity(a, b) {
  if (!a?.length || a.length !== b?.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    dot += a[index] * b[index];
    normA += a[index] ** 2;
    normB += b[index] ** 2;
  }
  return normA && normB ? dot / Math.sqrt(normA * normB) : 0;
}

function unwrap({ data, error }) {
  if (error) throw new Error(error.message);
  return data || [];
}

function unwrapOne(data, error) {
  if (error) throw new Error(error.message);
  return data;
}

function unwrapMaybe({ data, error }) {
  if (error) throw new Error(error.message);
  return data || null;
}

let singleton;
export function repositoryIndexStore() {
  if (singleton) return singleton;
  singleton = optionalEnv("CODE_AGENT_STORE", "memory").toLowerCase() === "supabase"
    ? new SupabaseRepositoryIndexStore()
    : new MemoryRepositoryIndexStore();
  return singleton;
}

export function resetRepositoryIndexStoreForTests() {
  singleton = null;
}

export function publicIndexStatus(row) {
  if (!row) return {
    status: "pending",
    version: 0,
    fileCount: 0,
    chunkCount: 0,
    indexedBytes: 0,
    symbolCount: 0,
    relationCount: 0,
    dependencyCount: 0,
    headSha: null,
    embeddingModel: null,
    lastError: null,
    startedAt: null,
    completedAt: null,
    progress: { phase: "pending", current: 0, total: 0 },
    refreshReason: null,
    refreshRequestedAt: null,
  };
  return {
    status: row.status,
    version: Number(row.version || 0),
    fileCount: Number(row.file_count || 0),
    chunkCount: Number(row.chunk_count || 0),
    indexedBytes: Number(row.indexed_bytes || 0),
    symbolCount: Number(row.symbol_count || 0),
    relationCount: Number(row.relation_count || 0),
    dependencyCount: Number(row.dependency_count || 0),
    headSha: row.head_sha || null,
    embeddingModel: row.embedding_model || null,
    lastError: row.last_error || null,
    startedAt: row.started_at || null,
    completedAt: row.completed_at || null,
    progress: {
      phase: row.progress_phase || row.status || "pending",
      current: Number(row.progress_current || 0),
      total: Number(row.progress_total || 0),
    },
    refreshReason: row.refresh_reason || null,
    refreshRequestedAt: row.refresh_requested_at || null,
  };
}
