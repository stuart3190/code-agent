-- Full rollout is intentional: there are no customer workloads to phase in yet.
update public.feature_flags
set enabled=true, rollout_percent=100, updated_at=now()
where key in ('capability_runtime','managed_ai_runtime','media_runtime','knowledge_runtime','app_usage_packs');
