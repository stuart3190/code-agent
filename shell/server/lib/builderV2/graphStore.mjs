// Symbol/Dependency Graph Store (master plan Part 2 §4).
//
// The memory store is the production store's test twin — same API, same answers; parity is
// a C7 stop condition once the supabase twin lands (commit I). Queries are all owner-scoped
// by construction: the store is created per (owner, projectId) and never mixes tenants.

/** Build an in-memory graph from an indexTree() result. */
export function memoryGraph(owner, projectId, treeIndex) {
  const { files, edges, refs, treeHash } = treeIndex;

  const importersOf = new Map();   // path -> Set(paths that import it)
  const importsOf = new Map();     // path -> Set(resolved paths it imports)
  for (const edge of edges) {
    if (!edge.toPath) continue;
    if (!importersOf.has(edge.toPath)) importersOf.set(edge.toPath, new Set());
    importersOf.get(edge.toPath).add(edge.fromPath);
    if (!importsOf.has(edge.fromPath)) importsOf.set(edge.fromPath, new Set());
    importsOf.get(edge.fromPath).add(edge.toPath);
  }

  const callersOf = new Map();     // symbolName -> [{fromPath, fromSymbol}]
  for (const ref of refs) {
    if (!callersOf.has(ref.refName)) callersOf.set(ref.refName, []);
    callersOf.get(ref.refName).push({ fromPath: ref.fromPath, fromSymbol: ref.fromSymbol });
  }

  return {
    owner, projectId, treeHash,

    file(path) { return files.get(path) || null; },
    paths() { return [...files.keys()]; },

    importersOf(path) { return [...(importersOf.get(path) || [])].sort(); },
    importsOf(path) { return [...(importsOf.get(path) || [])].sort(); },

    callersOf(symbolName) {
      return (callersOf.get(symbolName) || [])
        .slice().sort((a, b) => a.fromPath.localeCompare(b.fromPath));
    },

    /** Files within `depth` import-hops of `path`, either direction. Deterministic order. */
    neighbors(path, { depth = 1, direction = "both" } = {}) {
      const seen = new Set([path]);
      let frontier = [path];
      for (let hop = 0; hop < depth; hop += 1) {
        const next = [];
        for (const p of frontier) {
          const around = [
            ...(direction !== "out" ? (importersOf.get(p) || []) : []),
            ...(direction !== "in" ? (importsOf.get(p) || []) : []),
          ];
          for (const candidate of around) {
            if (seen.has(candidate)) continue;
            seen.add(candidate);
            next.push(candidate);
          }
        }
        frontier = next;
      }
      seen.delete(path);
      return [...seen].sort();
    },

    /**
     * Which files own a journey: files whose symbols' entity/route/call metadata intersect
     * the journey's entities or whose path words match its id/title words. Deterministic;
     * used by the differential planner for owners_hash.
     */
    owners(journey) {
      const words = `${journey.id} ${journey.title || ""}`.toLowerCase().match(/[a-z]{4,}/g) || [];
      const entities = new Set((journey.entities || []).map((e) => String(e).toLowerCase()));
      const owned = [];
      for (const [path, index] of files) {
        const lowerPath = path.toLowerCase();
        const pathHit = words.some((w) => lowerPath.includes(w));
        const entityHit = index.symbols.some((s) => s.meta?.entities?.some((e) => entities.has(e.toLowerCase())));
        if (pathHit || entityHit) owned.push(path);
      }
      return owned.sort();
    },

    /** Hash over the owning modules' content — the verification-cache key half. */
    ownersHash(journey) {
      const owned = this.owners(journey);
      const pairs = owned.map((p) => `${p} ${files.get(p).contentHash}`);
      return require$hash(pairs.join("\n"));
    },

    /** Paths whose stored hash disagrees with `manifest` (path -> contentHash). */
    staleCheck(manifest) {
      const stale = [];
      for (const [path, hash] of Object.entries(manifest)) {
        const file = files.get(path);
        if (!file || file.contentHash !== hash) stale.push(path);
      }
      for (const path of files.keys()) if (!(path in manifest)) stale.push(path);
      return [...new Set(stale)].sort();
    },
  };
}

import crypto from "node:crypto";
function require$hash(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}
