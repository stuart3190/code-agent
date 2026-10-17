-- Metadata only. Backup must prove column-level referential closure before promotion.
create or replace function public.thrallo_backup_relation_catalog()
returns jsonb language sql stable security definer set search_path = '' as $$
select jsonb_build_object(
  'version', 1,
  'migrationVersions', (select coalesce(jsonb_agg(version order by version), '[]'::jsonb) from supabase_migrations.schema_migrations),
  'primaryKeys', coalesce((
    select jsonb_agg(jsonb_build_object('table', t.relname, 'columns',
      (select jsonb_agg(a.attname order by k.ordinality)
       from unnest(c.conkey) with ordinality k(attnum, ordinality)
       join pg_catalog.pg_attribute a on a.attrelid=c.conrelid and a.attnum=k.attnum)) order by t.relname)
    from pg_catalog.pg_constraint c
    join pg_catalog.pg_class t on t.oid=c.conrelid
    join pg_catalog.pg_namespace n on n.oid=t.relnamespace
    where c.contype='p' and n.nspname='public'
  ), '[]'::jsonb),
  'foreignKeys', coalesce((
    select jsonb_agg(jsonb_build_object(
      'name', c.conname, 'table', t.relname,
      'columns', (select jsonb_agg(a.attname order by k.ordinality)
        from unnest(c.conkey) with ordinality k(attnum, ordinality)
        join pg_catalog.pg_attribute a on a.attrelid=c.conrelid and a.attnum=k.attnum),
      'parentSchema', pn.nspname, 'parentTable', pt.relname,
      'parentColumns', (select jsonb_agg(a.attname order by k.ordinality)
        from unnest(c.confkey) with ordinality k(attnum, ordinality)
        join pg_catalog.pg_attribute a on a.attrelid=c.confrelid and a.attnum=k.attnum),
      'match', c.confmatchtype
    ) order by t.relname, c.conname)
    from pg_catalog.pg_constraint c
    join pg_catalog.pg_class t on t.oid=c.conrelid
    join pg_catalog.pg_namespace n on n.oid=t.relnamespace
    join pg_catalog.pg_class pt on pt.oid=c.confrelid
    join pg_catalog.pg_namespace pn on pn.oid=pt.relnamespace
    where c.contype='f' and n.nspname='public'
  ), '[]'::jsonb)
);
$$;
revoke all on function public.thrallo_backup_relation_catalog() from public, anon, authenticated;
grant execute on function public.thrallo_backup_relation_catalog() to service_role;
