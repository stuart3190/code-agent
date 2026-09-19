-- Idempotent reconciliation: the six tables already exist, so this only adds the drift-detection
-- helper. Applying the full migration file to production is a no-op by design.
create or replace function public.thrallo_public_tables()
returns table (table_name text)
language sql
security definer
set search_path = public, pg_catalog
as $$
  select c.relname::text
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r'
   order by c.relname;
$$;

revoke all on function public.thrallo_public_tables() from public, anon, authenticated;
grant execute on function public.thrallo_public_tables() to service_role;

comment on function public.thrallo_public_tables is
  'Table names only, service-role only. Backs the migration-drift check, which is the only thing that can catch a table applied to production without a migration.';