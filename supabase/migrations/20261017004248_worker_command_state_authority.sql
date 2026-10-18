-- Worker state is operator authority after registration. A delayed heartbeat must not
-- overwrite a newer drain/pause/resume command. metadata.observedState acknowledges what
-- the process actually adopted; state alone is not a drain acknowledgement.
create or replace function public.build_worker_heartbeat(
  p_worker_id text, p_version text, p_state text, p_job_types text[], p_current_job_id uuid,
  p_metadata jsonb default '{}'::jsonb
) returns public.build_worker_nodes
language plpgsql security invoker set search_path = '' as $$
declare v_node public.build_worker_nodes;
begin
  if p_state not in ('active', 'paused', 'draining', 'stopped') then
    raise exception 'invalid worker state' using errcode = '22023';
  end if;
  insert into public.build_worker_nodes (worker_id, version, state, job_types, current_job_id, metadata)
    values (p_worker_id, p_version, p_state, coalesce(p_job_types, '{}'), p_current_job_id,
      coalesce(p_metadata, '{}'::jsonb) || jsonb_build_object('observedState', p_state))
  on conflict (worker_id) do update set version = excluded.version,
    state = case when excluded.state = 'stopped' then 'stopped' else public.build_worker_nodes.state end,
    job_types = excluded.job_types, current_job_id = excluded.current_job_id,
    heartbeat_at = now(), metadata = excluded.metadata
  returning * into v_node;
  return v_node;
end; $$;
revoke execute on function public.build_worker_heartbeat(text, text, text, text[], uuid, jsonb) from public, anon, authenticated;
grant execute on function public.build_worker_heartbeat(text, text, text, text[], uuid, jsonb) to service_role;
