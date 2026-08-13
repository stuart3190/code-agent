import { createHash } from "node:crypto";

export const GENERATED_RUNTIME_COLUMNS = Object.freeze({
  bv2_builds: Object.freeze(["project_id_text"]),
  diag_runs: Object.freeze(["project_id_text"]),
});

// Approved catalog after Package 12 migrations. The backup compares this evidence with the live
// thrallo_public_tables() RPC before reading any customer rows.
// The backup also compares its manifest with the live thrallo_public_tables() RPC at runtime.
export const PRODUCTION_PUBLIC_TABLES_70 = Object.freeze([
  "ai_requests", "analytics_daily", "analytics_events", "analytics_salts",
  "app_auth_events", "app_notifications", "app_password_resets", "app_users",
  "build_checkpoints", "build_jobs", "build_signals", "build_work_events",
  "build_work_jobs", "build_work_payloads", "build_work_results", "build_worker_nodes",
  "bv2_assets", "bv2_blobs", "bv2_builds", "bv2_contracts", "bv2_dependency_edges",
  "bv2_feature_flags", "bv2_file_revisions", "bv2_migration_state",
  "bv2_model_reservations", "bv2_patches", "bv2_project_knowledge",
  "bv2_project_pointers", "bv2_retrieval_traces", "bv2_shadow_checks",
  "bv2_shadow_run_files", "bv2_shadow_runs", "bv2_snapshot_files", "bv2_snapshots",
  "bv2_symbol_refs", "bv2_symbols", "bv2_verification_cache", "ca_agents",
  "ca_ai_credentials", "ca_ai_preferences", "ca_api_tokens", "ca_artifacts",
  "ca_automations", "ca_checkpoints", "ca_conversation_events", "ca_conversation_turns",
  "ca_conversations", "ca_github_installations", "ca_github_webhook_deliveries",
  "ca_memories", "ca_model_attempts", "ca_model_evaluation_results",
  "ca_model_evaluations", "ca_notifications", "ca_owner_profile", "ca_products",
  "ca_push_subscriptions", "ca_repositories", "ca_repository_index_chunks",
  "ca_repository_index_files", "ca_repository_indexes", "ca_repository_relations",
  "ca_repository_symbols", "ca_run_events", "ca_runs", "ca_subscriptions",
  "ca_tool_calls", "ca_usage_records", "custom_domains", "data_erasure_events",
  "data_erasure_jobs", "deployments", "diag_incidents",
  "diag_prefs", "diag_runs", "diag_steps", "entities", "health_checks", "health_status",
  "http_rate_limit_buckets", "project_logs", "projects", "publish_activation_intents", "publish_releases",
  "published_sites", "qa_runs",
]);

export const PRODUCTION_PUBLIC_TABLES_70_SHA256 =
  "ea98285c5aa1a7f0c8fcde38790c379aac4418d5f6f0250373a86635577ced5c";
export const EPHEMERAL_RUNTIME_TABLES = Object.freeze(["http_rate_limit_buckets"]);
export const PRODUCTION_PUBLIC_TABLES_68 = Object.freeze(PRODUCTION_PUBLIC_TABLES_70.filter((table) =>
  !["data_erasure_events", "data_erasure_jobs", "http_rate_limit_buckets"].includes(table)));
export const PRODUCTION_PUBLIC_TABLES_68_SHA256 =
  "aa975762e8d4c9dac1bb4da3f25c385025876ef541f5e3637c35b7148b451d73";
export const PRODUCTION_PUBLIC_TABLES_69 = Object.freeze(PRODUCTION_PUBLIC_TABLES_70.filter((table) =>
  table !== "http_rate_limit_buckets"));
export const PRODUCTION_PUBLIC_TABLES_69_SHA256 =
  "ef88486af70c561af24030058ce1d1392f90bf32e3bc614f8664767eadb6ef0d";

// Distinct child->parent table pairs from pg_constraint. Composite constraints are represented
// once because this list validates restore ordering, while PostgreSQL remains the authority for
// the complete column-level constraints during the isolated restore.
export const PRODUCTION_PUBLIC_FK_PAIRS_70 = Object.freeze([
  "build_jobs->bv2_builds", "build_jobs->diag_runs",
  "build_work_events->build_work_jobs", "build_work_events->projects",
  "build_work_jobs->build_jobs", "build_work_jobs->build_work_payloads",
  "build_work_jobs->build_work_results", "build_work_jobs->projects",
  "build_work_payloads->projects", "build_work_results->build_work_jobs",
  "build_work_results->projects", "build_worker_nodes->build_work_jobs",
  "bv2_assets->projects", "bv2_builds->bv2_contracts", "bv2_builds->bv2_snapshots",
  "bv2_builds->projects", "bv2_contracts->bv2_builds", "bv2_contracts->projects",
  "bv2_dependency_edges->bv2_file_revisions", "bv2_file_revisions->projects",
  "bv2_migration_state->projects", "bv2_model_reservations->bv2_builds",
  "bv2_patches->bv2_builds", "bv2_project_knowledge->bv2_builds",
  "bv2_project_knowledge->projects", "bv2_project_pointers->bv2_snapshots",
  "bv2_project_pointers->projects", "bv2_retrieval_traces->bv2_builds",
  "bv2_shadow_checks->bv2_shadow_runs", "bv2_shadow_run_files->bv2_file_revisions",
  "bv2_shadow_run_files->bv2_shadow_runs", "bv2_shadow_runs->projects",
  "bv2_snapshot_files->bv2_snapshots", "bv2_snapshots->bv2_builds",
  "bv2_snapshots->bv2_snapshots", "bv2_snapshots->projects",
  "bv2_symbol_refs->bv2_file_revisions", "bv2_symbol_refs->bv2_symbols",
  "bv2_symbols->bv2_file_revisions", "bv2_verification_cache->bv2_snapshots",
  "bv2_verification_cache->projects", "ca_agents->ca_repositories",
  "ca_artifacts->ca_runs", "ca_automations->ca_repositories", "ca_automations->ca_runs",
  "ca_checkpoints->ca_runs", "ca_conversation_events->ca_conversations",
  "ca_conversation_turns->ca_conversations", "ca_conversations->ca_products",
  "ca_memories->ca_products", "ca_model_attempts->ca_runs",
  "ca_model_evaluation_results->ca_model_evaluations", "ca_products->ca_repositories",
  "ca_repositories->ca_github_installations", "ca_repository_index_chunks->ca_repositories",
  "ca_repository_index_chunks->ca_repository_index_files",
  "ca_repository_index_files->ca_repositories", "ca_repository_indexes->ca_repositories",
  "ca_repository_relations->ca_repositories",
  "ca_repository_relations->ca_repository_index_files",
  "ca_repository_relations->ca_repository_symbols", "ca_repository_symbols->ca_repositories",
  "ca_repository_symbols->ca_repository_index_files", "ca_run_events->ca_runs",
  "ca_runs->ca_agents", "ca_runs->ca_automations", "ca_runs->ca_repositories",
  "ca_runs->ca_runs", "ca_tool_calls->ca_runs", "ca_usage_records->ca_runs",
  "data_erasure_events->data_erasure_jobs", "deployments->deployments", "diag_steps->diag_runs", "projects->bv2_snapshots",
  "projects->ca_products", "publish_activation_intents->deployments",
  "publish_activation_intents->publish_releases",
  "publish_activation_intents->published_sites", "publish_releases->deployments",
  "publish_releases->publish_releases", "publish_releases->published_sites",
  "published_sites->publish_releases", "qa_runs->build_work_jobs", "qa_runs->projects",
]);

export const PRODUCTION_PUBLIC_FK_PAIRS_70_SHA256 =
  "5b3a759507cf89247e387ab08256ae0a6e230bde0866da7c37a946841f2c2f77";
export const PRODUCTION_PUBLIC_FK_PAIRS_68 = Object.freeze(PRODUCTION_PUBLIC_FK_PAIRS_70.filter((pair) =>
  pair !== "data_erasure_events->data_erasure_jobs"));
export const PRODUCTION_PUBLIC_FK_PAIRS_68_SHA256 =
  "2b9a0e622e191ace556179b2d6837ed158e6f5fa42b65ce3664a68f8fd3b3bc2";

export function runtimeCatalogEvidence(migrationCount) {
  if (Number(migrationCount) === 68) return {
    migrationCount: 68, tables: PRODUCTION_PUBLIC_TABLES_68, tablesSha256: PRODUCTION_PUBLIC_TABLES_68_SHA256,
    fkPairs: PRODUCTION_PUBLIC_FK_PAIRS_68, fkPairsSha256: PRODUCTION_PUBLIC_FK_PAIRS_68_SHA256,
  };
  if (Number(migrationCount) === 69) return {
    migrationCount: 69, tables: PRODUCTION_PUBLIC_TABLES_69, tablesSha256: PRODUCTION_PUBLIC_TABLES_69_SHA256,
    fkPairs: PRODUCTION_PUBLIC_FK_PAIRS_70, fkPairsSha256: PRODUCTION_PUBLIC_FK_PAIRS_70_SHA256,
  };
  if ([70, 71, 72, 73, 74].includes(Number(migrationCount))) return {
    migrationCount: Number(migrationCount), tables: PRODUCTION_PUBLIC_TABLES_70, tablesSha256: PRODUCTION_PUBLIC_TABLES_70_SHA256,
    fkPairs: PRODUCTION_PUBLIC_FK_PAIRS_70, fkPairsSha256: PRODUCTION_PUBLIC_FK_PAIRS_70_SHA256,
  };
  throw new Error(`unsupported production migration count for backup/restore: ${migrationCount}`);
}

// Restore tooling can be newer than the backup being verified. Only tables that
// were canonical in the validated backup manifest may be queried or compared;
// otherwise a forward-deployed verifier would demand files for migrations that
// had not been applied when the backup was created.
export function backupTablesToVerify(knownTables, validatedTables) {
  const present = new Set(Object.keys(validatedTables || {}));
  return knownTables.filter((table) => present.has(table));
}

// Nullable links which participate in a real cycle or point forward in RESTORE_ORDER. They are
// restored as null and patched after all rows exist. No FK is disabled or weakened.
export const DEFERRED_RESTORE_FIELDS = Object.freeze({
  build_jobs: Object.freeze(["bv2_build_id", "diag_run_id"]),
  build_work_jobs: Object.freeze(["result_ref"]),
  bv2_contracts: Object.freeze(["build_id"]),
  bv2_project_knowledge: Object.freeze(["source_build"]),
  bv2_snapshots: Object.freeze(["build_id", "parent_snapshot"]),
  ca_automations: Object.freeze(["last_run_id"]),
  ca_runs: Object.freeze(["resumed_from_run_id"]),
  deployments: Object.freeze(["rolled_back_from"]),
  projects: Object.freeze(["bv2_green_snapshot_id"]),
  publish_releases: Object.freeze(["previous_release_id"]),
  published_sites: Object.freeze(["active_publish_release_id"]),
});

export const DEFERRED_RESTORE_PAIRS = new Set([
  "build_jobs->bv2_builds", "build_jobs->diag_runs",
  "build_work_jobs->build_work_results", "bv2_contracts->bv2_builds",
  "bv2_project_knowledge->bv2_builds", "bv2_snapshots->bv2_builds",
  "bv2_snapshots->bv2_snapshots", "ca_automations->ca_runs", "ca_runs->ca_runs",
  "deployments->deployments", "projects->bv2_snapshots",
  "publish_releases->publish_releases", "published_sites->publish_releases",
]);

export function sha256Lines(lines) {
  return createHash("sha256").update([...lines].sort().join("\n")).digest("hex");
}

export function prepareRowsForBackup(table, rows) {
  const generated = GENERATED_RUNTIME_COLUMNS[table];
  if (!generated) return rows;
  return rows.map((source) => {
    const row = { ...source };
    for (const column of generated) delete row[column];
    return row;
  });
}

export function canonicalRowsForRestoreComparison(table, rows) {
  return prepareRowsForBackup(table, rows);
}

export function findCatalogCoverageGaps(liveTables, backedUpTables, ignoredTables = []) {
  const live = new Set(liveTables);
  const backed = new Set(backedUpTables);
  const ignored = new Set(ignoredTables);
  return {
    missingFromBackup: [...live].filter((table) => !backed.has(table) && !ignored.has(table)).sort(),
    missingFromCatalog: [...backed].filter((table) => !live.has(table)).sort(),
  };
}

export function validateRestoreOrder(order, pairs = PRODUCTION_PUBLIC_FK_PAIRS_70) {
  const position = new Map(order.map((table, index) => [table, index]));
  const missingTables = [...new Set(pairs.flatMap((pair) => pair.split("->")))]
    .filter((table) => !position.has(table)).sort();
  const violations = [];
  for (const pair of pairs) {
    const [child, parent] = pair.split("->");
    if (DEFERRED_RESTORE_PAIRS.has(pair)) continue;
    if (child !== parent && position.get(parent) > position.get(child)) violations.push(pair);
  }
  return { missingTables, violations };
}

export function collectDeferredRestorePatches(table, rows) {
  const fields = DEFERRED_RESTORE_FIELDS[table] || [];
  const patches = [];
  const prepared = rows.map((source) => {
    const row = { ...source };
    for (const field of fields) {
      if (row[field] !== null && row[field] !== undefined) {
        patches.push({ table, id: row.id, field, value: row[field] });
        row[field] = null;
      }
    }
    return row;
  });
  return { rows: prepared, patches };
}

export function validateGeneratedProjectIds(table, rows) {
  if (!GENERATED_RUNTIME_COLUMNS[table]) return [];
  return rows.filter((row) => row.project_id_text !== String(row.project_id))
    .map((row) => `${table}:${row.id}: project_id_text mismatch`);
}

export function validateRuntimeBackupLinks(tables) {
  const errors = [];
  const projects = new Map((tables.projects || []).map((row) => [row.id, row]));
  const builds = new Map((tables.bv2_builds || []).map((row) => [row.id, row]));
  const snapshots = new Map((tables.bv2_snapshots || []).map((row) => [row.id, row]));
  const diagnostics = new Map((tables.diag_runs || []).map((row) => [row.id, row]));
  const reservations = tables.bv2_model_reservations || [];

  for (const row of reservations) {
    const build = builds.get(row.build_id);
    if (!build) errors.push(`reservation ${row.id} has no build ${row.build_id}`);
    else if (build.owner !== row.owner || build.project_id !== row.project_id) {
      errors.push(`reservation ${row.id} owner/project differs from build`);
    }
    if (!projects.has(row.project_id)) errors.push(`reservation ${row.id} has no project ${row.project_id}`);
    for (const field of ["provider", "model", "billing_lane"]) {
      if (!String(row[field] || "").trim()) errors.push(`reservation ${row.id} has no ${field} identity`);
    }
    if (!["held", "settled", "released"].includes(row.state)) errors.push(`reservation ${row.id} has invalid state ${row.state}`);
    if (row.state === "settled" && (!row.settled_at || row.actual_credits === null || row.actual_credits === undefined)) {
      errors.push(`reservation ${row.id} settled without durable actual usage`);
    }
    if (row.state === "released" && !row.released_at) errors.push(`reservation ${row.id} released without released_at`);
  }

  for (const job of tables.build_jobs || []) {
    if (job.bv2_build_id) {
      const build = builds.get(job.bv2_build_id);
      if (!build || build.owner !== job.owner || String(build.project_id) !== String(job.project_id)) {
        errors.push(`build job ${job.id} has an invalid V2 build link`);
      }
    }
    if (job.diag_run_id) {
      const diagnostic = diagnostics.get(job.diag_run_id);
      if (!diagnostic || diagnostic.owner !== job.owner || String(diagnostic.project_id) !== String(job.project_id)) {
        errors.push(`build job ${job.id} has an invalid diagnostic link`);
      }
    }
  }
  for (const project of projects.values()) {
    if (!project.bv2_green_snapshot_id) continue;
    const snapshot = snapshots.get(project.bv2_green_snapshot_id);
    if (!snapshot || snapshot.owner !== project.owner || snapshot.project_id !== project.id) {
      errors.push(`project ${project.id} has an invalid green snapshot link`);
    }
  }
  return errors;
}
