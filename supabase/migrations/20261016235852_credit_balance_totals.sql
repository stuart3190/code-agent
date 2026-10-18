-- Aggregate on the server: PostgREST row limits must not truncate purchased credits or
-- infrastructure refunds. Read only, one statement snapshot, service-role callers only.
create function public.credit_balance_totals(p_owner uuid)
returns table(topup numeric, protected_credits numeric)
language sql stable security definer set search_path = '' as $$
  select
    greatest(0, coalesce(sum(delta) filter (where bucket = 'topup'), 0)),
    greatest(0, coalesce(sum(delta) filter (
      where bucket = 'bundle' and kind in ('refund', 'service_credit')), 0))
  from public.credit_ledger where owner = p_owner;
$$;
revoke all on function public.credit_balance_totals(uuid) from public, anon, authenticated;
grant execute on function public.credit_balance_totals(uuid) to service_role;
