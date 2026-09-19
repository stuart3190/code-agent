-- The drift check also needs to know which live tables hold PROJECT data, so it can verify that
-- deleting a project would actually remove them. Names alone cannot answer that.
drop function if exists public.thrallo_public_tables();

create function public.thrallo_public_tables()
returns table (table_name text, project_scoped boolean)
language sql
security definer
set search_path = public, pg_catalog
as $$
  select c.relname::text,
         exists (
           select 1 from pg_attribute a
            where a.attrelid = c.oid
              and a.attnum > 0
              and not a.attisdropped
              and a.attname in ('project_id', 'app_id')
         )
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r'
   order by c.relname;
$$;

revoke all on function public.thrallo_public_tables() from public, anon, authenticated;
grant execute on function public.thrallo_public_tables() to service_role;

comment on function public.thrallo_public_tables is
  'Table names and whether each is project-scoped. Service-role only. Backs the migration-drift check, which is the only thing that can catch a table applied to production without a migration, without a backup, or without teardown coverage.';