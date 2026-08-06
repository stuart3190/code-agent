with
schemas as (
  select jsonb_agg(jsonb_build_object(
    'schema', n.nspname,
    'owner', pg_get_userbyid(n.nspowner)
  ) order by n.nspname) value
  from pg_namespace n
  where n.nspname <> 'information_schema'
    and n.nspname !~ '^pg_'
),
tables as (
  select jsonb_agg(jsonb_build_object(
    'schema', n.nspname,
    'table', c.relname,
    'kind', c.relkind,
    'rls_enabled', c.relrowsecurity,
    'rls_forced', c.relforcerowsecurity,
    'owner', pg_get_userbyid(c.relowner)
  ) order by n.nspname, c.relname) value
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f')
),
sequences as (
  select jsonb_agg(jsonb_build_object(
    'schema', n.nspname,
    'sequence', c.relname,
    'owner', pg_get_userbyid(c.relowner),
    'data_type', format_type(s.seqtypid, null),
    'start', s.seqstart,
    'increment', s.seqincrement,
    'minimum', s.seqmin,
    'maximum', s.seqmax,
    'cache', s.seqcache,
    'cycle', s.seqcycle
  ) order by n.nspname, c.relname) value
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  join pg_sequence s on s.seqrelid = c.oid
  where n.nspname = 'public' and c.relkind = 'S'
),
columns as (
  select jsonb_agg(jsonb_build_object(
    'schema', n.nspname,
    'table', c.relname,
    'ordinal', a.attnum,
    'column', a.attname,
    'type', pg_catalog.format_type(a.atttypid, a.atttypmod),
    'nullable', not a.attnotnull,
    'default', pg_get_expr(d.adbin, d.adrelid),
    'identity', nullif(a.attidentity, ''),
    'generated', nullif(a.attgenerated, ''),
    'collation', case when a.attcollation <> t.typcollation then co.collname end
  ) order by n.nspname, c.relname, a.attnum) value
  from pg_attribute a
  join pg_class c on c.oid = a.attrelid
  join pg_namespace n on n.oid = c.relnamespace
  join pg_type t on t.oid = a.atttypid
  left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
  left join pg_collation co on co.oid = a.attcollation
  where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f')
    and a.attnum > 0 and not a.attisdropped
),
constraints as (
  select jsonb_agg(jsonb_build_object(
    'schema', n.nspname,
    'table', c.relname,
    'constraint', con.conname,
    'type', con.contype,
    'definition', pg_get_constraintdef(con.oid, true),
    'validated', con.convalidated,
    'deferrable', con.condeferrable,
    'deferred', con.condeferred
  ) order by n.nspname, c.relname, con.conname) value
  from pg_constraint con
  join pg_class c on c.oid = con.conrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
),
indexes as (
  select jsonb_agg(jsonb_build_object(
    'schema', schemaname,
    'table', tablename,
    'index', indexname,
    'definition', indexdef
  ) order by schemaname, tablename, indexname) value
  from pg_indexes where schemaname = 'public'
),
functions as (
  select jsonb_agg(jsonb_build_object(
    'schema', n.nspname,
    'function', p.proname,
    'identity_arguments', pg_get_function_identity_arguments(p.oid),
    'result', pg_get_function_result(p.oid),
    'language', l.lanname,
    'security_definer', p.prosecdef,
    'volatility', p.provolatile,
    'definition', pg_get_functiondef(p.oid)
  ) order by n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)) value
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  join pg_language l on l.oid = p.prolang
  where n.nspname = 'public'
),
triggers as (
  select jsonb_agg(jsonb_build_object(
    'schema', n.nspname,
    'table', c.relname,
    'trigger', t.tgname,
    'definition', pg_get_triggerdef(t.oid, true),
    'enabled', t.tgenabled
  ) order by n.nspname, c.relname, t.tgname) value
  from pg_trigger t
  join pg_class c on c.oid = t.tgrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and not t.tgisinternal
),
policies as (
  select jsonb_agg(jsonb_build_object(
    'schema', schemaname,
    'table', tablename,
    'policy', policyname,
    'permissive', permissive,
    'roles', to_jsonb(roles),
    'command', cmd,
    'using', qual,
    'with_check', with_check
  ) order by schemaname, tablename, policyname) value
  from pg_policies where schemaname = 'public'
),
table_grants as (
  select jsonb_agg(jsonb_build_object(
    'object_type', 'table',
    'schema', table_schema,
    'object', table_name,
    'grantee', grantee,
    'privilege', privilege_type,
    'grantable', is_grantable
  ) order by table_schema, table_name, grantee, privilege_type) value
  from information_schema.table_privileges
  where table_schema = 'public'
),
routine_grants as (
  select jsonb_agg(jsonb_build_object(
    'object_type', 'routine',
    'schema', routine_schema,
    'object', routine_name,
    'specific_name', specific_name,
    'grantee', grantee,
    'privilege', privilege_type,
    'grantable', is_grantable
  ) order by routine_schema, routine_name, specific_name, grantee, privilege_type) value
  from information_schema.routine_privileges
  where routine_schema = 'public'
),
sequence_grants as (
  select jsonb_agg(jsonb_build_object(
    'object_type', 'sequence',
    'schema', n.nspname,
    'object', c.relname,
    'grantee', case when acl.grantee = 0 then 'PUBLIC' else pg_get_userbyid(acl.grantee) end,
    'privilege', acl.privilege_type,
    'grantable', case when acl.is_grantable then 'YES' else 'NO' end
  ) order by n.nspname, c.relname, acl.grantee, acl.privilege_type) value
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  cross join lateral aclexplode(coalesce(c.relacl, acldefault('S', c.relowner))) acl
  where n.nspname = 'public' and c.relkind = 'S'
),
schema_grants as (
  select jsonb_agg(jsonb_build_object(
    'object_type', 'schema',
    'schema', n.nspname,
    'object', n.nspname,
    'grantee', case when acl.grantee = 0 then 'PUBLIC' else pg_get_userbyid(acl.grantee) end,
    'privilege', acl.privilege_type,
    'grantable', case when acl.is_grantable then 'YES' else 'NO' end
  ) order by n.nspname, acl.grantee, acl.privilege_type) value
  from pg_namespace n
  cross join lateral aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) acl
  where n.nspname = 'public'
),
default_privileges as (
  select jsonb_agg(jsonb_build_object(
    'role', pg_get_userbyid(d.defaclrole),
    'schema', coalesce(n.nspname, '*'),
    'object_type', case d.defaclobjtype
      when 'r' then 'table'
      when 'S' then 'sequence'
      when 'f' then 'function'
      when 'T' then 'type'
      when 'n' then 'schema'
      else d.defaclobjtype::text
    end,
    'grantee', case when acl.grantee = 0 then 'PUBLIC' else pg_get_userbyid(acl.grantee) end,
    'privilege', acl.privilege_type,
    'grantable', acl.is_grantable
  ) order by pg_get_userbyid(d.defaclrole), coalesce(n.nspname, '*'), d.defaclobjtype, acl.grantee, acl.privilege_type) value
  from pg_default_acl d
  left join pg_namespace n on n.oid = d.defaclnamespace
  cross join lateral aclexplode(d.defaclacl) acl
  where d.defaclnamespace = 0 or n.nspname = 'public'
),
extensions as (
  select jsonb_agg(jsonb_build_object(
    'extension', e.extname,
    'version', e.extversion,
    'schema', n.nspname
  ) order by e.extname) value
  from pg_extension e join pg_namespace n on n.oid = e.extnamespace
)
select jsonb_build_object(
  'schemas', coalesce((select value from schemas), '[]'::jsonb),
  'tables', coalesce((select value from tables), '[]'::jsonb),
  'sequences', coalesce((select value from sequences), '[]'::jsonb),
  'columns', coalesce((select value from columns), '[]'::jsonb),
  'constraints', coalesce((select value from constraints), '[]'::jsonb),
  'indexes', coalesce((select value from indexes), '[]'::jsonb),
  'functions', coalesce((select value from functions), '[]'::jsonb),
  'triggers', coalesce((select value from triggers), '[]'::jsonb),
  'policies', coalesce((select value from policies), '[]'::jsonb),
  'grants', coalesce((select value from table_grants), '[]'::jsonb)
    || coalesce((select value from routine_grants), '[]'::jsonb)
    || coalesce((select value from sequence_grants), '[]'::jsonb)
    || coalesce((select value from schema_grants), '[]'::jsonb),
  'default_privileges', coalesce((select value from default_privileges), '[]'::jsonb),
  'extensions', coalesce((select value from extensions), '[]'::jsonb)
) as catalog;
