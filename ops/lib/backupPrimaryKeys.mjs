// Primary keys from a fresh isolated database with all 89 migrations applied.
// Unknown tables fail closed; update alongside schema/backup coverage changes.
export const BACKUP_PRIMARY_KEYS = Object.freeze({
  "ai_requests": [
    "id"
  ],
  "analytics_daily": [
    "project_id",
    "day",
    "dimension",
    "key"
  ],
  "analytics_events": [
    "id"
  ],
  "analytics_salts": [
    "day"
  ],
  "app_account_policies": [
    "app_id"
  ],
  "app_audit_config": [
    "app_id"
  ],
  "app_audit_events": [
    "id"
  ],
  "app_auth_events": [
    "id"
  ],
  "app_booking_reservations": ["id"],
  "app_booking_request_keys": ["app_id", "owner", "request_id"],
  "app_billing_events": [
    "app_id",
    "event_id"
  ],
  "app_membership_events": [
    "id"
  ],
  "app_memberships": [
    "id"
  ],
  "app_notifications": [
    "id"
  ],
  "app_password_resets": [
    "id"
  ],
  "app_profiles": [
    "app_id",
    "auth_user_id"
  ],
  "app_settings": [
    "app_id",
    "scope",
    "scope_target",
    "key"
  ],
  "app_subscriptions": [
    "app_id",
    "subject"
  ],
  "app_users": [
    "id"
  ],
  "build_checkpoints": [
    "id"
  ],
  "build_jobs": [
    "id"
  ],
  "build_signals": [
    "id"
  ],
  "build_work_events": [
    "seq"
  ],
  "build_work_jobs": [
    "id"
  ],
  "build_work_payloads": [
    "id"
  ],
  "build_work_results": [
    "id"
  ],
  "build_worker_nodes": [
    "worker_id"
  ],
  "bv2_assets": [
    "id"
  ],
  "bv2_blobs": [
    "owner",
    "content_hash"
  ],
  "bv2_build_budget_approvals": [
    "id"
  ],
  "bv2_build_envelopes": [
    "id"
  ],
  "bv2_build_progress": [
    "id"
  ],
  "bv2_build_settlements": [
    "id"
  ],
  "bv2_builds": [
    "id"
  ],
  "bv2_contracts": [
    "id"
  ],
  "bv2_dependency_edges": [
    "id"
  ],
  "bv2_duration_extensions": [
    "id"
  ],
  "bv2_feature_flags": [
    "key"
  ],
  "bv2_file_revisions": [
    "id"
  ],
  "bv2_migration_state": [
    "owner",
    "project_id"
  ],
  "bv2_model_reservations": [
    "id"
  ],
  "bv2_patches": [
    "id"
  ],
  "bv2_project_knowledge": [
    "id"
  ],
  "bv2_project_pointers": [
    "owner",
    "project_id",
    "label"
  ],
  "bv2_recovery_approvals": [
    "id"
  ],
  "bv2_repair_strategies": [
    "id"
  ],
  "bv2_retrieval_traces": [
    "id"
  ],
  "bv2_shadow_checks": [
    "id"
  ],
  "bv2_shadow_run_files": [
    "shadow_run_id",
    "path"
  ],
  "bv2_shadow_runs": [
    "id"
  ],
  "bv2_snapshot_files": [
    "snapshot_id",
    "path"
  ],
  "bv2_snapshots": [
    "id"
  ],
  "bv2_symbol_refs": [
    "id"
  ],
  "bv2_symbols": [
    "id"
  ],
  "bv2_verification_cache": [
    "owner",
    "project_id",
    "journey_id",
    "owners_hash"
  ],
  "bv2_verification_defects": [
    "id"
  ],
  "ca_agents": [
    "id"
  ],
  "ca_ai_credentials": [
    "owner",
    "provider"
  ],
  "ca_ai_preferences": [
    "owner"
  ],
  "ca_api_tokens": [
    "id"
  ],
  "ca_artifacts": [
    "id"
  ],
  "ca_automations": [
    "id"
  ],
  "ca_checkpoints": [
    "id"
  ],
  "ca_conversation_events": [
    "id"
  ],
  "ca_conversation_turns": [
    "id"
  ],
  "ca_conversations": [
    "id"
  ],
  "ca_direct_model_reservations": [
    "id"
  ],
  "ca_github_installations": [
    "id"
  ],
  "ca_github_webhook_deliveries": [
    "delivery_id"
  ],
  "ca_lead_model_reservations": [
    "id"
  ],
  "ca_memories": [
    "id"
  ],
  "ca_model_attempts": [
    "id"
  ],
  "ca_model_call_identities": [
    "provider_request_fingerprint"
  ],
  "ca_model_evaluation_results": [
    "id"
  ],
  "ca_model_evaluations": [
    "id"
  ],
  "ca_notifications": [
    "id"
  ],
  "ca_owner_profile": [
    "owner"
  ],
  "ca_products": [
    "id"
  ],
  "ca_push_subscriptions": [
    "id"
  ],
  "ca_repositories": [
    "id"
  ],
  "ca_repository_index_chunks": [
    "id"
  ],
  "ca_repository_index_files": [
    "id"
  ],
  "ca_repository_indexes": [
    "repository_id"
  ],
  "ca_repository_relations": [
    "id"
  ],
  "ca_repository_symbols": [
    "id"
  ],
  "ca_run_events": [
    "id"
  ],
  "ca_runs": [
    "id"
  ],
  "ca_subscriptions": [
    "owner"
  ],
  "ca_tool_calls": [
    "id"
  ],
  "ca_usage_records": [
    "id"
  ],
  "credit_ledger": [
    "id"
  ],
  "custom_domains": [
    "domain"
  ],
  "data_erasure_events": [
    "seq"
  ],
  "data_erasure_jobs": [
    "id"
  ],
  "deployments": [
    "id"
  ],
  "diag_incidents": [
    "id"
  ],
  "diag_prefs": [
    "owner"
  ],
  "diag_runs": [
    "id"
  ],
  "diag_steps": [
    "id"
  ],
  "entities": [
    "id"
  ],
  "health_checks": [
    "id"
  ],
  "health_status": [
    "project_id"
  ],
  "http_rate_limit_buckets": [
    "key_hash",
    "route_class"
  ],
  "project_logs": [
    "id"
  ],
  "projects": [
    "id"
  ],
  "publish_activation_intents": [
    "id"
  ],
  "publish_releases": [
    "id"
  ],
  "published_sites": [
    "id"
  ],
  "qa_runs": [
    "id"
  ]
});
