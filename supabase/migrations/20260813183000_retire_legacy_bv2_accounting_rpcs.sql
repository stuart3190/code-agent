-- Contract only after every shell and worker is running the allocation-aware V2 runtime.
-- This prevents a rolling deploy from stranding an old process between the expand and contract steps.

alter table public.bv2_model_reservations
  add constraint bv2_model_reservations_settled_allocation_check check (
    state<>'settled' or
    (included_actual_credits is not null and purchased_actual_credits is not null and platform_actual_credits is not null)
  ) not valid;

alter table public.bv2_model_reservations
  validate constraint bv2_model_reservations_settled_allocation_check;

revoke execute on function public.reserve_bv2_model_call(
  uuid,uuid,uuid,text,text,text,text,text,numeric,numeric,numeric,jsonb
) from service_role;
revoke execute on function public.reserve_bv2_model_call_v2(
  uuid,uuid,uuid,text,text,text,text,text,numeric,numeric,numeric,jsonb
) from service_role;
revoke execute on function public.settle_bv2_model_call(uuid,uuid,numeric,jsonb,jsonb)
  from service_role;
