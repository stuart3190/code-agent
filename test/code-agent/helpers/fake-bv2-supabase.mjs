export function createFakeBv2Supabase() {
  const tables = new Map();
  const objects = new Map();
  const writes = [];
  let idCounter = 0;
  let failurePoint = null;
  const rowsOf = (name) => { if (!tables.has(name)) tables.set(name, []); return tables.get(name); };
  const nextId = () => `row-${++idCounter}`;
  const cloneTables = () => new Map([...tables].map(([name, rows]) => [name, structuredClone(rows)]));
  const restoreTables = (snapshot) => {
    tables.clear();
    for (const [name, rows] of snapshot) tables.set(name, rows);
  };

  function chain(tableName) {
    const state = {
      filters: [], op: "select", payload: null, single: false, maybe: false,
      order: null, ascending: true, limit: null, from: null, to: null,
      onConflict: null, selectAfter: false,
    };
    const matches = (row) => state.filters.every(([col, val]) => row[col] === val);
    const runQuery = () => {
      const rows = rowsOf(tableName);
      if (state.op === "select") {
        let out = rows.filter(matches).map((row) => ({ ...row }));
        if (state.order) out.sort((a, b) => (a[state.order] > b[state.order] ? 1 : -1) * (state.ascending ? 1 : -1));
        if (state.from !== null) out = out.slice(state.from, state.to + 1);
        if (state.limit !== null) out = out.slice(0, state.limit);
        if (state.single || state.maybe) {
          if (state.single && out.length !== 1) return { data: null, error: { message: `expected 1 row, got ${out.length}` } };
          return { data: out[0] || null, error: null };
        }
        return { data: out, error: null };
      }
      if (state.op === "insert") {
        writes.push({ table: tableName, kind: "insert", payload: structuredClone(state.payload) });
        const inserted = (Array.isArray(state.payload) ? state.payload : [state.payload]).map((row) => {
          const withId = { id: row.id || nextId(), ...row };
          rows.push(withId);
          return { ...withId };
        });
        return { data: state.single ? inserted[0] : inserted, error: null };
      }
      if (state.op === "upsert") {
        writes.push({ table: tableName, kind: "upsert", payload: structuredClone(state.payload) });
        const payload = Array.isArray(state.payload) ? state.payload : [state.payload];
        const keys = (state.onConflict || "id").split(",").filter(Boolean);
        for (const item of payload) {
          const existing = rows.find((row) => keys.every((key) => row[key] === item[key]));
          if (existing) Object.assign(existing, item);
          else rows.push({ id: item.id || nextId(), ...item });
        }
        return { data: null, error: null };
      }
      if (state.op === "update") {
        writes.push({ table: tableName, kind: "update", payload: structuredClone(state.payload) });
        const updated = [];
        for (const row of rows) if (matches(row)) { Object.assign(row, state.payload); updated.push({ ...row }); }
        return { data: state.selectAfter ? (state.single || state.maybe ? updated[0] || null : updated) : null, error: null };
      }
      if (state.op === "delete") {
        writes.push({ table: tableName, kind: "delete" });
        const keep = rows.filter((row) => !matches(row));
        rows.length = 0;
        rows.push(...keep);
        return { data: null, error: null };
      }
      return { data: null, error: { message: `unsupported op ${state.op}` } };
    };
    const api = {
      select() { if (state.op !== "select") state.selectAfter = true; return api; },
      insert(payload) { state.op = "insert"; state.payload = payload; return api; },
      upsert(payload, options = {}) { state.op = "upsert"; state.payload = payload; state.onConflict = options.onConflict; return api; },
      update(payload) { state.op = "update"; state.payload = payload; return api; },
      delete() { state.op = "delete"; return api; },
      eq(column, value) { state.filters.push([column, value]); return api; },
      order(column, options = {}) { state.order = column; state.ascending = options.ascending !== false; return api; },
      limit(value) { state.limit = value; return api; },
      range(from, to) { state.from = from; state.to = to; return api; },
      single() { state.single = true; return Promise.resolve(runQuery()); },
      maybeSingle() { state.maybe = true; return Promise.resolve(runQuery()); },
      then(resolve, reject) { return Promise.resolve(runQuery()).then(resolve, reject); },
    };
    return api;
  }

  async function rpc(name, args) {
    try {
      if (name === "bv2_persist_file_revision") return { data: persistRevision(args), error: null };
      if (name === "bv2_load_graph") return { data: loadGraph(args), error: null };
      if (name === "bv2_begin_shadow_run") return { data: beginShadow(args), error: null };
      if (name === "bv2_record_shadow_check") return { data: recordCheck(args), error: null };
      if (name === "bv2_gc_file_revisions") return { data: gcRevisions(args), error: null };
      return { data: null, error: { message: `unknown rpc ${name}` } };
    } catch (error) {
      return { data: null, error: { message: error.message, code: error.code } };
    }
  }

  function persistRevision(args) {
    const before = cloneTables();
    try {
      const revisions = rowsOf("bv2_file_revisions");
      let revision = revisions.find((row) => row.owner === args.p_owner
        && row.project_id === args.p_project_id
        && row.path === args.p_file.path
        && row.content_hash === args.p_file.content_hash);
      const existing = !!revision;
      const childCount = (table) => rowsOf(table).filter((row) => row.revision_id === revision?.id).length;
      if (revision?.state === "ready") {
        if (revision.graph_hash !== args.p_graph_hash || revision.indexer_version !== args.p_indexer_version
          || revision.size_bytes !== args.p_file.size_bytes || revision.tokens !== args.p_file.tokens
          || revision.opaque !== args.p_file.opaque) throw new Error("conflicting graph for immutable file revision");
        if (revision.symbol_count === args.p_symbols.length && revision.ref_count === args.p_refs.length
          && revision.edge_count === args.p_edges.length
          && childCount("bv2_symbols") === args.p_symbols.length
          && childCount("bv2_symbol_refs") === args.p_refs.length
          && childCount("bv2_dependency_edges") === args.p_edges.length) {
          return { revision_id: revision.id, written: false, repaired: false };
        }
      }
      if (!revision) {
        revision = {
          id: nextId(), owner: args.p_owner, project_id: args.p_project_id,
          ...args.p_file, state: "building", indexed_at: new Date().toISOString(),
        };
        revisions.push(revision);
      } else Object.assign(revision, args.p_file, { state: "building" });
      if (failurePoint === "after_revision") throw new Error("injected after revision");
      for (const table of ["bv2_symbol_refs", "bv2_symbols", "bv2_dependency_edges"]) {
        tables.set(table, rowsOf(table).filter((row) => row.revision_id !== revision.id));
      }
      const symbolIds = [];
      for (const [ordinal, symbol] of args.p_symbols.entries()) {
        const row = {
          id: nextId(), owner: args.p_owner, project_id: args.p_project_id,
          revision_id: revision.id, path: args.p_file.path, ordinal, ...symbol,
        };
        rowsOf("bv2_symbols").push(row);
        symbolIds.push(row.id);
        if (failurePoint === "halfway_symbols" && ordinal === Math.max(0, Math.floor(args.p_symbols.length / 2))) {
          throw new Error("injected halfway through symbols");
        }
      }
      for (const [ordinal, ref] of args.p_refs.entries()) {
        rowsOf("bv2_symbol_refs").push({
          id: nextId(), owner: args.p_owner, project_id: args.p_project_id,
          revision_id: revision.id, ordinal, from_symbol: symbolIds[ref.from_symbol_ordinal],
          ref_name: ref.ref_name, resolved_path: ref.resolved_path, count: ref.count,
        });
        if (failurePoint === "refs") throw new Error("injected during refs");
      }
      for (const [ordinal, edge] of args.p_edges.entries()) {
        rowsOf("bv2_dependency_edges").push({
          id: nextId(), owner: args.p_owner, project_id: args.p_project_id,
          revision_id: revision.id, ordinal, from_path: args.p_file.path,
          to_path: edge.to_path, specifier: edge.specifier,
        });
        if (failurePoint === "edges") throw new Error("injected during edges");
      }
      Object.assign(revision, {
        state: "ready", indexer_version: args.p_indexer_version, graph_hash: args.p_graph_hash,
        symbol_count: args.p_symbols.length, ref_count: args.p_refs.length, edge_count: args.p_edges.length,
        completed_at: new Date().toISOString(),
      });
      writes.push({ table: "bv2_file_revisions", kind: "rpc", payload: structuredClone(args.p_file) });
      return { revision_id: revision.id, written: true, repaired: existing };
    } catch (error) {
      restoreTables(before);
      throw error;
    } finally {
      failurePoint = null;
    }
  }

  function loadGraph(args) {
    const revisions = rowsOf("bv2_file_revisions").filter((row) => row.owner === args.p_owner
      && row.project_id === args.p_project_id && args.p_manifest[row.path] === row.content_hash);
    const ids = new Set(revisions.map((row) => row.id));
    return {
      revisions: structuredClone(revisions),
      symbols: structuredClone(rowsOf("bv2_symbols").filter((row) => ids.has(row.revision_id))),
      refs: structuredClone(rowsOf("bv2_symbol_refs").filter((row) => ids.has(row.revision_id))),
      edges: structuredClone(rowsOf("bv2_dependency_edges").filter((row) => ids.has(row.revision_id))),
    };
  }

  function beginShadow(args) {
    const revisions = rowsOf("bv2_file_revisions");
    const pinned = Object.entries(args.p_manifest).map(([path, contentHash]) => revisions.find((row) => row.owner === args.p_owner
      && row.project_id === args.p_project_id && row.path === path && row.content_hash === contentHash && row.state === "ready"));
    if (pinned.some((row) => !row)) throw new Error("shadow manifest references missing or incomplete revisions");
    const id = nextId();
    const indexedAt = new Date().toISOString();
    rowsOf("bv2_shadow_runs").push({
      id, owner: args.p_owner, project_id: args.p_project_id, build_id: args.p_build_id,
      tree_hash: args.p_tree_hash, file_count: pinned.length, status: "validating", indexed_at: indexedAt,
    });
    pinned.forEach((revision) => rowsOf("bv2_shadow_run_files").push({
      shadow_run_id: id, owner: args.p_owner, project_id: args.p_project_id,
      path: revision.path, content_hash: revision.content_hash, revision_id: revision.id,
    }));
    const states = rowsOf("bv2_migration_state");
    const prior = states.find((row) => row.owner === args.p_owner && row.project_id === args.p_project_id);
    const state = {
      owner: args.p_owner, project_id: args.p_project_id, state: "shadow", last_shadow_at: indexedAt,
      notes: { buildId: args.p_build_id, treeHash: args.p_tree_hash, files: pinned.length, shadowRunId: id, status: "validating" },
    };
    if (prior) Object.assign(prior, state); else states.push(state);
    writes.push({ table: "bv2_migration_state", kind: "upsert", payload: structuredClone(state) });
    return id;
  }

  function recordCheck(args) {
    const run = rowsOf("bv2_shadow_runs").find((row) => row.id === args.p_shadow_run_id
      && row.owner === args.p_owner && row.project_id === args.p_project_id);
    if (!run) throw new Error("shadow run does not belong to owner/project");
    const id = nextId();
    rowsOf("bv2_shadow_checks").push({
      id, shadow_run_id: run.id, owner: run.owner, project_id: run.project_id,
      status: args.p_status, evidence: structuredClone(args.p_evidence), checked_at: new Date().toISOString(),
    });
    run.status = args.p_status;
    run.validated_at = new Date().toISOString();
    return id;
  }

  function gcRevisions(args) {
    const revisions = rowsOf("bv2_file_revisions");
    const pinned = new Set(rowsOf("bv2_shadow_run_files").map((row) => row.revision_id));
    const snapshots = rowsOf("bv2_snapshots");
    for (const file of rowsOf("bv2_snapshot_files")) {
      const snapshot = snapshots.find((row) => row.id === file.snapshot_id);
      if (!snapshot || snapshot.owner !== args.p_owner || snapshot.project_id !== args.p_project_id) continue;
      for (const revision of revisions) {
        if (revision.owner === args.p_owner && revision.project_id === args.p_project_id
          && revision.path === file.path && revision.content_hash === file.content_hash) pinned.add(revision.id);
      }
    }
    const latest = new Map();
    for (const revision of revisions.filter((row) => row.owner === args.p_owner && row.project_id === args.p_project_id)) {
      const prior = latest.get(revision.path);
      if (!prior || prior.indexed_at < revision.indexed_at) latest.set(revision.path, revision);
    }
    const removable = new Set(revisions.filter((revision) => revision.owner === args.p_owner
      && revision.project_id === args.p_project_id && revision.indexed_at < args.p_before
      && latest.get(revision.path)?.id !== revision.id && !pinned.has(revision.id)).map((row) => row.id));
    tables.set("bv2_file_revisions", revisions.filter((row) => !removable.has(row.id)));
    for (const table of ["bv2_symbols", "bv2_symbol_refs", "bv2_dependency_edges"]) {
      tables.set(table, rowsOf(table).filter((row) => !removable.has(row.revision_id)));
    }
    return removable.size;
  }

  return {
    from: (name) => chain(name),
    rpc,
    storage: {
      from: () => ({
        upload: async (key, bytes) => { objects.set(key, Buffer.from(bytes)); return { error: null }; },
        download: async (key) => objects.has(key)
          ? { data: { arrayBuffer: async () => objects.get(key) }, error: null }
          : { data: null, error: { message: "not found" } },
        remove: async (keys) => { for (const key of keys) objects.delete(key); return { error: null }; },
      }),
    },
    failNext(point) { failurePoint = point; },
    table(name) { return rowsOf(name); },
    _tables: tables,
    _objects: objects,
    writes,
  };
}
