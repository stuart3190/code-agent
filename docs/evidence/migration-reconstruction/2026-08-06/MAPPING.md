# Local-to-production migration mapping

Captured from commit `43d706441ecc9a0f2457280ea6b139910c1ff11c`. The archive preserves every original byte;
the active history is reconstructed separately from the production ledger. A non-exact SQL
classification is not automatically a schema difference: comments, formatting, or consolidated
follow-up migrations can change text while producing the same final catalog.

| Current local file | Authoritative production migration(s) | SQL equivalence | Representation | Final reconstructed file(s) |
|---|---|---|---|---|
| `20260721131113_platform_foundations.sql` | None by mapped name | no authoritative ledger migration by mapped name | no production migration | None |
| `20260721131732_foundation_fk_indexes.sql` | None by mapped name | no authoritative ledger migration by mapped name | no production migration | None |
| `20260721132051_qa_runs.sql` | None by mapped name | no authoritative ledger migration by mapped name | no production migration | None |
| `20260721133223_saas_payments_runtime.sql` | None by mapped name | no authoritative ledger migration by mapped name | no production migration | None |
| `20260721133847_saas_payment_fk_indexes.sql` | None by mapped name | no authoritative ledger migration by mapped name | no production migration | None |
| `20260721133945_visual_brand_kits.sql` | None by mapped name | no authoritative ledger migration by mapped name | no production migration | None |
| `20260721134315_owner_console_controls.sql` | None by mapped name | no authoritative ledger migration by mapped name | no production migration | None |
| `20260721135020_app_integrations_notifications.sql` | None by mapped name | no authoritative ledger migration by mapped name | no production migration | None |
| `20260721135445_app_analytics_events.sql` | None by mapped name | no authoritative ledger migration by mapped name | no production migration | None |
| `20260721140139_project_templates.sql` | None by mapped name | no authoritative ledger migration by mapped name | no production migration | None |
| `20260721152000_connector_hub.sql` | None by mapped name | no authoritative ledger migration by mapped name | no production migration | None |
| `20260721224922_capability_runtime.sql` | None by mapped name | no authoritative ledger migration by mapped name | no production migration | None |
| `20260721231924_capability_runtime_fk_indexes.sql` | None by mapped name | no authoritative ledger migration by mapped name | no production migration | None |
| `20260721232626_capability_runtime_rollout.sql` | None by mapped name | no authoritative ledger migration by mapped name | no production migration | None |
| `20260722091357_meta_publishing_connectors.sql` | None by mapped name | no authoritative ledger migration by mapped name | no production migration | None |
| `20260729122234_code_agent_control_plane.sql` | `20260729164522_code_agent_control_plane` | not text-equivalent; catalog/semantic comparison required | one production migration | `20260729164522_code_agent_control_plane.sql` |
| `20260729140251_github_app_installations.sql` | `20260729164535_github_app_installations` | not text-equivalent; catalog/semantic comparison required | one production migration | `20260729164535_github_app_installations.sql` |
| `20260729164642_harden_code_agent_schema.sql` | `20260729164721_harden_code_agent_schema` | not text-equivalent; catalog/semantic comparison required | one production migration | `20260729164721_harden_code_agent_schema.sql` |
| `20260729165131_lock_down_code_agent_anon_access.sql` | `20260729165144_lock_down_code_agent_anon_access` | not text-equivalent; catalog/semantic comparison required | one production migration | `20260729165144_lock_down_code_agent_anon_access.sql` |
| `20260729231426_github_webhook_ledger.sql` | `20260729231426_github_webhook_ledger` | canonical SQL exact | one production migration | `20260729231426_github_webhook_ledger.sql` |
| `20260729232141_restrict_code_agent_policy_roles.sql` | `20260729232141_restrict_code_agent_policy_roles` | not text-equivalent; catalog/semantic comparison required | one production migration | `20260729232141_restrict_code_agent_policy_roles.sql` |
| `20260729234551_ai_provider_connections.sql` | `20260729234551_ai_provider_connections` | canonical SQL exact | one production migration | `20260729234551_ai_provider_connections.sql` |
| `20260729234651_reject_anonymous_code_agent_access.sql` | `20260729234651_reject_anonymous_code_agent_access` | canonical SQL exact | one production migration | `20260729234651_reject_anonymous_code_agent_access.sql` |
| `20260730001803_repository_hybrid_index.sql` | `20260730001803_repository_hybrid_index` | canonical SQL exact | one production migration | `20260730001803_repository_hybrid_index.sql` |
| `20260730063059_repository_code_intelligence.sql` | `20260730063059_repository_code_intelligence` | not text-equivalent; catalog/semantic comparison required | one production migration | `20260730063059_repository_code_intelligence.sql` |
| `20260730083259_model_routing_and_evaluations.sql` | `20260730083259_model_routing_and_evaluations` | not text-equivalent; catalog/semantic comparison required | one production migration | `20260730083259_model_routing_and_evaluations.sql` |
| `20260730143000_subscriptions_budgets_telemetry.sql` | `20260730091313_subscriptions_budgets_telemetry` | canonical SQL exact | one production migration | `20260730091313_subscriptions_budgets_telemetry.sql` |
| `20260730170000_approval_policies_resume_artifacts.sql` | `20260730100937_approval_policies_resume_artifacts` | canonical SQL exact | one production migration | `20260730100937_approval_policies_resume_artifacts.sql` |
| `20260730200000_egress_command_policies_retention.sql` | `20260730102731_egress_command_policies_retention` | canonical SQL exact | one production migration | `20260730102731_egress_command_policies_retention.sql` |
| `20260730220000_conversation_platform.sql` | `20260730203059_conversation_platform` | canonical SQL exact | one production migration | `20260730203059_conversation_platform.sql` |
| `20260730223000_api_tokens.sql` | `20260730104416_api_tokens` | canonical SQL exact | one production migration | `20260730104416_api_tokens.sql` |
| `20260731003000_review_runs.sql` | `20260730110931_review_runs` | canonical SQL exact | one production migration | `20260730110931_review_runs.sql` |
| `20260731020000_automations.sql` | `20260730114324_automations` | canonical SQL exact | one production migration | `20260730114324_automations.sql` |
| `20260731100000_app_build_platform.sql` | `20260730212120_app_build_platform` | canonical SQL exact | one production migration | `20260730212120_app_build_platform.sql` |
| `20260731150000_app_publish_platform.sql` | `20260730233508_app_publish_platform` | canonical SQL exact | one production migration | `20260730233508_app_publish_platform.sql` |
| `20260801090000_owner_accounts.sql` | `20260731100621_owner_accounts` | canonical SQL exact | one production migration | `20260731100621_owner_accounts.sql` |
| `20260801120000_repair_pipeline_hardening.sql` | `20260801160607_repair_pipeline_hardening` | not text-equivalent; catalog/semantic comparison required | one production migration | `20260801160607_repair_pipeline_hardening.sql` |
| `20260801150000_per_app_runtime.sql` | `20260731113457_per_app_runtime` | not text-equivalent; catalog/semantic comparison required | one production migration | `20260731113457_per_app_runtime.sql` |
| `20260801160000_persistent_build_checkpoints.sql` | `20260801162814_persistent_build_checkpoints` | not text-equivalent; catalog/semantic comparison required | one production migration | `20260801162814_persistent_build_checkpoints.sql` |
| `20260801180000_provider_constraints_and_telemetry_grants.sql` | `20260801180459_provider_constraints_and_telemetry_grants` | not text-equivalent; catalog/semantic comparison required | one production migration | `20260801180459_provider_constraints_and_telemetry_grants.sql` |
| `20260801200000_qa_runs_thrallo.sql` | `20260801195851_qa_runs_thrallo` | not text-equivalent; catalog/semantic comparison required | one production migration | `20260801195851_qa_runs_thrallo.sql` |
| `20260801200000_soft_delete.sql` | `20260731151901_soft_delete` | not text-equivalent; catalog/semantic comparison required | one production migration | `20260731151901_soft_delete.sql` |
| `20260801220000_app_notifications.sql` | `20260801202309_app_notifications`<br>`20260801202626_app_notifications_source_is_trusted_only`<br>`20260801203017_app_notifications_column_grants` | not text-equivalent; catalog/semantic comparison required | 3 production migrations | `20260801202309_app_notifications.sql`<br>`20260801202626_app_notifications_source_is_trusted_only.sql`<br>`20260801203017_app_notifications_column_grants.sql` |
| `20260801220000_build_diagnostics.sql` | `20260801000408_build_diagnostics` | canonical SQL exact | one production migration | `20260801000408_build_diagnostics.sql` |
| `20260802100000_ai_requests.sql` | `20260801080238_ai_requests` | canonical SQL exact | one production migration | `20260801080238_ai_requests.sql` |
| `20260802120000_ai_requests_context.sql` | `20260801082604_ai_requests_context` | canonical SQL exact | one production migration | `20260801082604_ai_requests_context.sql` |
| `20260802140000_conversation_model_pref.sql` | `20260801090748_conversation_model_pref` | canonical SQL exact | one production migration | `20260801090748_conversation_model_pref.sql` |
| `20260802160000_diag_incidents.sql` | `20260801120332_diag_incidents` | canonical SQL exact | one production migration | `20260801120332_diag_incidents.sql` |
| `20260802180000_build_signals.sql` | `20260801134602_build_signals` | not text-equivalent; catalog/semantic comparison required | one production migration | `20260801134602_build_signals.sql` |
| `20260802200000_allow_xai_provider.sql` | `20260801140736_ai_credentials_allow_xai`<br>`20260801140806_ai_preferences_allow_xai` | not text-equivalent; catalog/semantic comparison required | 2 production migrations | `20260801140736_ai_credentials_allow_xai.sql`<br>`20260801140806_ai_preferences_allow_xai.sql` |
| `20260802220000_subscription_plan_changes.sql` | `20260802150108_subscription_plan_changes` | canonical SQL exact | one production migration | `20260802150108_subscription_plan_changes.sql` |
| `20260803000000_publish_lifecycle_unpublish.sql` | `20260802185336_publish_lifecycle_unpublish` | canonical SQL exact | one production migration | `20260802185336_publish_lifecycle_unpublish.sql` |
| `20260803120000_custom_domain_verification.sql` | `20260802210939_custom_domain_verification` | not text-equivalent; catalog/semantic comparison required | one production migration | `20260802210939_custom_domain_verification.sql` |
| `20260803180000_analytics_logs_health_tables.sql` | `20260802220217_thrallo_analytics_foundation`<br>`20260802223316_health_monitoring`<br>`20260802234247_project_logs`<br>`20260803005550_analytics_logs_health_tables_reconcile` | not text-equivalent; catalog/semantic comparison required | 4 production migrations | `20260802220217_thrallo_analytics_foundation.sql`<br>`20260802223316_health_monitoring.sql`<br>`20260802234247_project_logs.sql`<br>`20260803005550_analytics_logs_health_tables_reconcile.sql` |
| `20260803210000_one_live_site_per_product.sql` | `20260803124509_one_live_site_per_product` | not text-equivalent; catalog/semantic comparison required | one production migration | `20260803124509_one_live_site_per_product.sql` |
| `20260803230000_deployments.sql` | `20260803150144_deployments` | not text-equivalent; catalog/semantic comparison required | one production migration | `20260803150144_deployments.sql` |
| `20260804120000_conversation_favourites_archive.sql` | `20260803205904_conversation_favourites_archive` | not text-equivalent; catalog/semantic comparison required | one production migration | `20260803205904_conversation_favourites_archive.sql` |
| `20260805090000_account_notifications_cancellation.sql` | `20260803233001_account_notifications_cancellation` | not text-equivalent; catalog/semantic comparison required | one production migration | `20260803233001_account_notifications_cancellation.sql` |
| `20260806090000_onboarding_state.sql` | `20260804090105_onboarding_state` | not text-equivalent; catalog/semantic comparison required | one production migration | `20260804090105_onboarding_state.sql` |
| `20260807090000_analytics_country.sql` | `20260804103902_analytics_country` | not text-equivalent; catalog/semantic comparison required | one production migration | `20260804103902_analytics_country.sql` |
| `20260808090000_diag_runs_implementation_contract.sql` | `20260804201913_diag_runs_implementation_contract` | canonical SQL exact | one production migration | `20260804201913_diag_runs_implementation_contract.sql` |
| `20260808100000_build_checkpoints_stage.sql` | `20260804203403_build_checkpoints_stage` | canonical SQL exact | one production migration | `20260804203403_build_checkpoints_stage.sql` |
| `20260808110000_ai_requests_provider_request_ids.sql` | `20260805072157_ai_requests_provider_request_ids` | canonical SQL exact | one production migration | `20260805072157_ai_requests_provider_request_ids.sql` |
| `20260809090000_builder_v2_foundation.sql` | `20260805190622_builder_v2_foundation` | not text-equivalent; catalog/semantic comparison required | one production migration | `20260805190622_builder_v2_foundation.sql` |
| `20260810213000_bv2_verification_cache_nullable_snapshot.sql` | `20260805212028_bv2_verification_cache_nullable_snapshot` | not text-equivalent; catalog/semantic comparison required | one production migration | `20260805212028_bv2_verification_cache_nullable_snapshot.sql` |
