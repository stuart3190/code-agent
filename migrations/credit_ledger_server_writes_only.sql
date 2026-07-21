-- Credit balances are money-like, server-authoritative data. Browser clients may read their own
-- append-only ledger through RLS, but every grant, debit, reservation, refund and adjustment must
-- come from the trusted backend service role.

drop policy if exists ledger_insert_own on public.credit_ledger;

revoke insert, update, delete, truncate, references, trigger
  on public.credit_ledger
  from anon, authenticated;

grant select on public.credit_ledger to authenticated;
