CREATE OR REPLACE FUNCTION public.settle_bv2_model_call_v2(p_owner uuid, p_reservation_id uuid, p_actual_credits numeric, p_usage jsonb DEFAULT '{}'::jsonb, p_provider_request_ids jsonb DEFAULT '[]'::jsonb)
 RETURNS bv2_model_reservations
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_row public.bv2_model_reservations; v_fingerprint text;
  v_included numeric:=0; v_purchased numeric:=0; v_platform numeric:=0;
begin
  if p_actual_credits is null or p_actual_credits<0 then raise exception 'invalid actual Builder V2 model cost' using errcode='22023'; end if;
  if jsonb_typeof(coalesce(p_usage,'{}'::jsonb))<>'object'
     or jsonb_typeof(coalesce(p_provider_request_ids,'[]'::jsonb))<>'array' then
    raise exception 'invalid Builder V2 usage or provider request ids' using errcode='22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('bv2-model:'||p_owner::text,0));
  select * into v_row from public.bv2_model_reservations where id=p_reservation_id and owner=p_owner for update;
  if not found then raise exception 'Builder V2 reservation not found' using errcode='42501'; end if;
  if v_row.state='settled' then
    if v_row.actual_credits<>p_actual_credits or coalesce(v_row.usage,'{}'::jsonb)<>coalesce(p_usage,'{}'::jsonb)
       or coalesce(v_row.provider_request_ids,'[]'::jsonb)<>coalesce(p_provider_request_ids,'[]'::jsonb) then
      raise exception 'duplicate Builder V2 settlement disagrees with canonical telemetry' using errcode='23505';
    end if;
    return v_row;
  end if;
  if v_row.state<>'held' then raise exception 'released Builder V2 reservation cannot settle' using errcode='55000'; end if;
  if jsonb_array_length(coalesce(p_provider_request_ids,'[]'::jsonb))>0 then
    v_fingerprint:=encode(extensions.digest(convert_to(v_row.provider||':'||coalesce(p_provider_request_ids,'[]'::jsonb)::text,'utf8'),'sha256'),'hex');
  end if;
  if v_row.billing_lane='managed' then
    if v_row.usage_responsibility='customer_request' then
      v_included:=least(p_actual_credits,v_row.included_reserved_credits);
      v_purchased:=least(p_actual_credits-v_included,v_row.purchased_reserved_credits);
      v_platform:=greatest(0,p_actual_credits-v_included-v_purchased);
    else
      v_platform:=p_actual_credits;
    end if;
  end if;
  if v_fingerprint is not null then
    insert into public.ca_model_call_identities(
      provider_request_fingerprint,provider,reservation_kind,reservation_id,owner
    ) values(v_fingerprint,v_row.provider,'builder_v2',v_row.id,v_row.owner)
    on conflict (provider_request_fingerprint) do nothing;
    if not exists(select 1 from public.ca_model_call_identities i
      where i.provider_request_fingerprint=v_fingerprint and i.reservation_kind='builder_v2'
        and i.reservation_id=v_row.id and i.owner=v_row.owner) then
      raise exception 'provider request telemetry is already settled to another reservation' using errcode='23505';
    end if;
  end if;
  update public.bv2_model_reservations set state='settled',actual_credits=p_actual_credits,
    included_actual_credits=v_included,purchased_actual_credits=v_purchased,platform_actual_credits=v_platform,
    usage=coalesce(p_usage,'{}'::jsonb),provider_request_ids=coalesce(p_provider_request_ids,'[]'::jsonb),
    provider_request_fingerprint=v_fingerprint,settled_at=now(),
    reconciliation_state='provider_settled',reconciled_at=now()
    where id=v_row.id returning * into v_row;
  if v_row.billing_lane='managed' and v_included>0 then
    insert into public.ca_usage_records(
      id,owner,run_id,provider,model,input_tokens,cached_tokens,output_tokens,reasoning_tokens,
      compute_seconds,amount_gbp,billing_source,metadata
    ) values (
      v_row.id,v_row.owner,null,v_row.provider,v_row.model,
      coalesce((p_usage->>'input')::bigint,(p_usage->>'inputTokens')::bigint,0),
      coalesce((p_usage->>'cached')::bigint,(p_usage->>'cachedTokens')::bigint,0),
      coalesce((p_usage->>'output')::bigint,(p_usage->>'outputTokens')::bigint,0),
      coalesce((p_usage->>'reasoning')::bigint,(p_usage->>'reasoningTokens')::bigint,0),
      0,0,'managed',jsonb_build_object('kind','app_build_v2','reservation_id',v_row.id,
        'project_id',v_row.project_id,'build_id',v_row.build_id,'step',v_row.step,
        'charge_credits',v_included,'actual_credits',p_actual_credits,
        'usage_responsibility',v_row.usage_responsibility,'provider_request_ids',coalesce(p_provider_request_ids,'[]'::jsonb))
    ) on conflict (id) do nothing;
  end if;
  if v_purchased>0 then
    insert into public.credit_ledger(owner,delta,bucket,kind,model,tokens,ref)
      values(v_row.owner,-v_purchased,'topup','debit',v_row.model,
        coalesce((p_usage->>'total')::integer,(p_usage->>'totalTokens')::integer,0),
        'bv2-reservation:'||v_row.id::text)
      on conflict (owner,ref,kind,bucket) do nothing;
  end if;
  return v_row;
end $function$;
