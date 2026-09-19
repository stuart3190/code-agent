-- The durable worker payload moved out of build_work_jobs when the queue was introduced. The
-- retry guard must update the payload authority referenced by payload_ref, keep its integrity
-- metadata in sync, and return the refreshed payload to the already-leased worker process.
create or replace function public.prepare_bv2_pipeline_retry(
  p_owner uuid,
  p_public_build_id uuid,
  p_work_job_id uuid
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_public public.build_jobs;
  v_work public.build_work_jobs;
  v_payload public.build_work_payloads;
  v_retry_payload jsonb;
  v_payload_text text;
  v_payload_sha256 text;
  v_unresolved bigint := 0;
  v_total bigint := 0;
begin
  select * into v_public
  from public.build_jobs b
  where b.id = p_public_build_id
    and b.owner = p_owner
    and b.pipeline_version = 'v2'
    and b.work_job_id = p_work_job_id
  for update;

  if not found then
    raise exception 'Builder V2 public/work job identity mismatch' using errcode = '42501';
  end if;

  if v_public.status = 'complete' and v_public.result is not null then
    return jsonb_build_object(
      'action', 'recovered',
      'result', v_public.result,
      'stopReason', v_public.stop_reason
    );
  end if;

  if v_public.status in ('failed', 'interrupted') then
    return jsonb_build_object('action', 'terminal_public_job', 'status', v_public.status);
  end if;

  select * into v_work
  from public.build_work_jobs j
  where j.id = p_work_job_id
    and j.owner = p_owner
    and j.project_id::text = v_public.project_id
    and j.build_id = v_public.id
    and j.job_type = 'builder_pipeline'
  for update;

  if not found then
    return jsonb_build_object(
      'action', 'retry_state_missing',
      'code', 'durable_retry_state_missing',
      'reason', 'work_job_missing'
    );
  end if;

  select * into v_payload
  from public.build_work_payloads p
  where p.id = v_work.payload_ref
    and p.owner = v_work.owner
    and p.project_id = v_work.project_id
    and p.build_id = v_work.build_id
    and p.job_type = v_work.job_type
  for update;

  if not found then
    return jsonb_build_object(
      'action', 'retry_state_missing',
      'code', 'durable_retry_state_missing',
      'reason', 'payload_missing'
    );
  end if;

  v_payload_text := v_payload.payload::text;
  v_payload_sha256 := encode(
    extensions.digest(convert_to(v_payload_text, 'UTF8'), 'sha256'),
    'hex'
  );
  if v_payload_sha256 <> v_payload.payload_sha256
     or octet_length(v_payload_text) <> v_payload.byte_size
     or coalesce(v_payload.payload->>'pipelineVersion', '') <> 'v2' then
    return jsonb_build_object(
      'action', 'retry_state_invalid',
      'code', 'durable_retry_payload_invalid',
      'reason', 'payload_integrity_or_version'
    );
  end if;

  if v_public.bv2_build_id is null then
    return jsonb_build_object(
      'action', 'restart_before_provider',
      'abandonedBuildId', null,
      'platformFunded', false,
      'payloadRef', v_payload.id,
      'payloadSha256', v_payload.payload_sha256,
      'payload', v_payload.payload
    );
  end if;

  -- Reservation creation, settlement, ambiguity marking and terminal settlement use the same
  -- owner-scoped lock. Holding it here closes the count-to-restart race with provider dispatch.
  perform pg_advisory_xact_lock(hashtextextended('bv2-model:' || p_owner::text, 0));

  select count(*), count(*) filter (
    where state = 'held' and reconciliation_state in ('none', 'pending')
  )
  into v_total, v_unresolved
  from public.bv2_model_reservations
  where owner = p_owner and build_id = v_public.bv2_build_id;

  if v_unresolved > 0 then
    return jsonb_build_object(
      'action', 'provider_replay_unsafe',
      'abandonedBuildId', v_public.bv2_build_id,
      'reservationCount', v_total,
      'unresolvedReservationCount', v_unresolved
    );
  end if;

  v_retry_payload := v_payload.payload || jsonb_build_object(
    'usageResponsibility', 'platform_failure',
    'recoveryOfBuildId', v_public.bv2_build_id
  );
  v_payload_text := v_retry_payload::text;
  if octet_length(v_payload_text) > 16777216 then
    return jsonb_build_object(
      'action', 'retry_state_invalid',
      'code', 'durable_retry_payload_oversize',
      'reason', 'payload_size'
    );
  end if;
  v_payload_sha256 := encode(
    extensions.digest(convert_to(v_payload_text, 'UTF8'), 'sha256'),
    'hex'
  );

  update public.bv2_builds set
    state = 'failed',
    error = 'worker_crash_reconciled_platform_retry',
    finished_at = coalesce(finished_at, now())
  where id = v_public.bv2_build_id
    and owner = p_owner
    and state not in ('green', 'failed', 'cancelled', 'blocked');

  update public.build_work_payloads set
    payload = v_retry_payload,
    payload_sha256 = v_payload_sha256,
    byte_size = octet_length(v_payload_text)
  where id = v_payload.id
    and owner = p_owner;

  update public.build_jobs set
    bv2_build_id = null,
    status = 'running',
    phase = 'running',
    error = null,
    stop_reason = null,
    updated_at = now()
  where id = v_public.id and owner = p_owner;

  return jsonb_build_object(
    'action', 'restart_before_provider',
    'abandonedBuildId', v_public.bv2_build_id,
    'platformFunded', true,
    'payloadRef', v_payload.id,
    'payloadSha256', v_payload_sha256,
    'payload', v_retry_payload
  );
end;
$$;

revoke execute on function public.prepare_bv2_pipeline_retry(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.prepare_bv2_pipeline_retry(uuid, uuid, uuid)
  to service_role;
