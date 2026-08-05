// Project Knowledge — persistent per-project facts that survive builds (master plan Part 2 §2).
//
// v1 relearns everything per build; v2 records what a project IS once and renders it into a
// deterministic, byte-stable brief every prompt can share (stable text = cacheable prefix
// segment). Storage is pluggable: the memory store is the test twin of the supabase store,
// with the same shape — parity is asserted in tests, per the C7 stop conditions.

import { serviceClient } from "../supabase.mjs";

export const FACT_KINDS = Object.freeze([
  "entity",        // { name, fields?, owned? }
  "route",         // { path, name, file? }
  "decision",      // { text, why? }
  "design",        // { family, typography?, palette? }
  "constraint",    // { text }
  "capability",    // { name, version, pinnedMajor }
  "contract_ref",  // { contractId, version }
  "asset_style",   // { directive } — "darker photography" etc., feeds the Asset Service
]);

export function validateFact({ kind, key, value }) {
  const problems = [];
  if (!FACT_KINDS.includes(kind)) problems.push(`unknown kind "${kind}"`);
  if (!key || typeof key !== "string" || key.length > 200) problems.push("key must be a short string");
  if (value === undefined || value === null) problems.push("value is required");
  try {
    if (JSON.stringify(value).length > 20_000) problems.push("value too large — knowledge is facts, not blobs");
  } catch {
    problems.push("value must be JSON-serialisable");
  }
  return { ok: problems.length === 0, problems };
}

export function memoryKnowledgeStore() {
  const rows = new Map(); // `${owner}:${projectId}:${kind}:${key}` -> row
  return {
    async upsert(row) {
      rows.set(`${row.owner}:${row.project_id}:${row.kind}:${row.key}`, { ...row, updated_at: new Date().toISOString() });
    },
    async list(owner, projectId) {
      return [...rows.values()].filter((r) => r.owner === owner && r.project_id === projectId);
    },
    async remove(owner, projectId) {
      for (const [k, r] of rows) if (r.owner === owner && r.project_id === projectId) rows.delete(k);
    },
  };
}

export function supabaseKnowledgeStore(client = serviceClient()) {
  return {
    async upsert(row) {
      const { error } = await client.from("bv2_project_knowledge")
        .upsert({ ...row, updated_at: new Date().toISOString() }, { onConflict: "owner,project_id,kind,key" });
      if (error) throw new Error(`knowledge upsert: ${error.message}`);
    },
    async list(owner, projectId) {
      const { data, error } = await client.from("bv2_project_knowledge")
        .select("*").eq("owner", owner).eq("project_id", projectId);
      if (error) throw new Error(`knowledge list: ${error.message}`);
      return data || [];
    },
    async remove(owner, projectId) {
      const { error } = await client.from("bv2_project_knowledge")
        .delete().eq("owner", owner).eq("project_id", projectId);
      if (error) throw new Error(`knowledge remove: ${error.message}`);
    },
  };
}

export async function recordFact(owner, projectId, { kind, key, value, sourceBuild = null }, { store = supabaseKnowledgeStore() } = {}) {
  const check = validateFact({ kind, key, value });
  if (!check.ok) throw new Error(`invalid knowledge fact: ${check.problems.join("; ")}`);
  await store.upsert({ owner, project_id: projectId, kind, key, value, source_build: sourceBuild });
}

export async function getKnowledge(owner, projectId, { store = supabaseKnowledgeStore() } = {}) {
  const rows = await store.list(owner, projectId).catch((error) => {
    // Read-miss/failure NEVER blocks a build — empty knowledge is a slower build, not a dead one.
    console.error(`[bv2] knowledge unreadable for ${String(projectId).slice(0, 8)}: ${error.message}`);
    return [];
  });
  const byKind = {};
  for (const kind of FACT_KINDS) byKind[kind] = [];
  for (const row of rows) if (byKind[row.kind]) byKind[row.kind].push(row);
  for (const kind of FACT_KINDS) byKind[kind].sort((a, b) => a.key.localeCompare(b.key));
  return byKind;
}

/**
 * The knowledge brief — ≤1.5k tokens, BYTE-STABLE for identical facts (sorted kinds, sorted
 * keys, canonical JSON), so it can sit inside a cacheable prompt prefix segment.
 */
export function knowledgeBrief(byKind) {
  const lines = ["PROJECT KNOWLEDGE (persistent; do not rediscover any of this):"];
  for (const kind of FACT_KINDS) {
    const rows = byKind[kind] || [];
    if (!rows.length) continue;
    lines.push(`${kind}:`);
    for (const row of rows) lines.push(`  ${row.key}: ${canonical(row.value)}`);
  }
  if (lines.length === 1) return "PROJECT KNOWLEDGE: none recorded yet.";
  const text = lines.join("\n");
  // Hard bound: a brief that outgrows its budget keeps the FRONT (kinds are ordered by how
  // load-bearing they are) and says so, rather than silently exploding the prefix.
  const MAX_CHARS = 6_000; // ≈1.5k tokens
  return text.length <= MAX_CHARS ? text : `${text.slice(0, MAX_CHARS)}\n  …(knowledge truncated at budget)`;
}

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
}
