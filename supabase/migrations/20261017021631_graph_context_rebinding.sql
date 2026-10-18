-- Context-only graph reuse; no historical rows or identities changed.
CREATE OR REPLACE FUNCTION public.bv2_persist_file_revision(p_owner uuid, p_project_id uuid, p_file jsonb, p_symbols jsonb, p_refs jsonb, p_edges jsonb, p_graph_hash text, p_indexer_version text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_revision public.bv2_file_revisions%rowtype;
  v_revision_id uuid;
  v_symbols jsonb;
  v_refs jsonb;
  v_edges jsonb;
  v_existing boolean := false;
  v_actual_symbols integer;
  v_actual_refs integer;
  v_actual_edges integer;
  v_symbol_count integer;
  v_ref_count integer;
  v_edge_count integer;
  v_path text := p_file->>'path';
  v_content_hash text := p_file->>'content_hash';
begin
  if not exists (
    select 1 from public.projects where id = p_project_id and owner = p_owner
  ) then
    raise exception 'project does not belong to owner' using errcode = '42501';
  end if;
  if jsonb_typeof(p_symbols) is distinct from 'array'
    or jsonb_typeof(p_refs) is distinct from 'array'
    or jsonb_typeof(p_edges) is distinct from 'array' then
    raise exception 'symbols, refs and edges must be arrays' using errcode = '22023';
  end if;
  if coalesce(v_path, '') = ''
    or coalesce(v_content_hash, '') !~ '^[0-9a-f]{64}$'
    or coalesce(p_graph_hash, '') !~ '^[0-9a-f]{64}$'
    or coalesce(p_indexer_version, '') = '' then
    raise exception 'invalid file revision identity' using errcode = '22023';
  end if;

  v_symbol_count := jsonb_array_length(p_symbols);
  v_ref_count := jsonb_array_length(p_refs);
  v_edge_count := jsonb_array_length(p_edges);

  -- One transaction-scoped lock per immutable identity makes two simultaneous RPC calls converge
  -- on one row without holding locks outside this short database-only transaction.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_owner::text || ':' || p_project_id::text || ':' || v_path || ':' || v_content_hash, 0)
  );

  select * into v_revision
  from public.bv2_file_revisions
  where owner = p_owner and project_id = p_project_id
    and path = v_path and content_hash = v_content_hash
  for update;

  if found then
    v_existing := true;
    v_revision_id := v_revision.id;
    select count(*) into v_actual_symbols from public.bv2_symbols where revision_id = v_revision_id;
    select count(*) into v_actual_refs from public.bv2_symbol_refs where revision_id = v_revision_id;
    select count(*) into v_actual_edges from public.bv2_dependency_edges where revision_id = v_revision_id;

    if v_revision.state = 'ready' then
      if v_revision.indexer_version is distinct from p_indexer_version
        or v_revision.size_bytes is distinct from (p_file->>'size_bytes')::integer
        or v_revision.tokens is distinct from (p_file->>'tokens')::integer
        or v_revision.opaque is distinct from (p_file->>'opaque')::boolean then
        raise exception 'conflicting graph for immutable file revision' using errcode = '23505';
      end if;
      -- Resolved targets depend on the whole tree, not this immutable file's bytes.
      -- Reuse only when every intrinsic fact and declared/actual child count agrees.
      -- Keep original rows and graph_hash unchanged so historical payload integrity
      -- remains verifiable. The reader rebinds targets after validating that payload.
      if v_revision.graph_hash is distinct from p_graph_hash then
        select coalesce(jsonb_agg(jsonb_build_object(
          'name', s.name, 'kind', s.kind, 'exported', s.exported,
          'is_default', s.is_default, 'start_offset', s.start_offset,
          'end_offset', s.end_offset, 'block_hash', s.block_hash, 'meta', s.meta
        ) order by s.ordinal), '[]'::jsonb) into v_symbols
        from public.bv2_symbols s where s.revision_id = v_revision_id;
        select coalesce(jsonb_agg(jsonb_build_object(
          'from_symbol_ordinal', s.ordinal, 'ref_name', r.ref_name, 'count', r.count
        ) order by r.ordinal), '[]'::jsonb) into v_refs
        from public.bv2_symbol_refs r
        join public.bv2_symbols s on s.id = r.from_symbol and s.revision_id = r.revision_id
        where r.revision_id = v_revision_id;
        select coalesce(jsonb_agg(jsonb_build_object('specifier', e.specifier)
          order by e.ordinal), '[]'::jsonb) into v_edges
        from public.bv2_dependency_edges e where e.revision_id = v_revision_id;
        if v_symbols is distinct from p_symbols
          or v_refs is distinct from (select coalesce(jsonb_agg(value - 'resolved_path' order by ordinality), '[]'::jsonb)
            from jsonb_array_elements(p_refs) with ordinality)
          or v_edges is distinct from (select coalesce(jsonb_agg(value - 'to_path' order by ordinality), '[]'::jsonb)
            from jsonb_array_elements(p_edges) with ordinality)
          or v_revision.symbol_count <> v_symbol_count or v_actual_symbols <> v_symbol_count
          or v_revision.ref_count <> v_ref_count or v_actual_refs <> v_ref_count
          or v_revision.edge_count <> v_edge_count or v_actual_edges <> v_edge_count then
          raise exception 'conflicting graph for immutable file revision' using errcode = '23505';
        end if;
      end if;
      if v_revision.symbol_count = v_symbol_count
        and v_revision.ref_count = v_ref_count
        and v_revision.edge_count = v_edge_count
        and v_actual_symbols = v_symbol_count
        and v_actual_refs = v_ref_count
        and v_actual_edges = v_edge_count then
        return jsonb_build_object('revision_id', v_revision_id, 'written', false, 'repaired', false);
      end if;
    end if;

    update public.bv2_file_revisions
    set state = 'building', graph_hash = null, completed_at = null,
        indexer_version = p_indexer_version,
        size_bytes = (p_file->>'size_bytes')::integer,
        tokens = (p_file->>'tokens')::integer,
        opaque = (p_file->>'opaque')::boolean,
        symbol_count = 0, ref_count = 0, edge_count = 0
    where id = v_revision_id;
    delete from public.bv2_symbols where revision_id = v_revision_id;
    delete from public.bv2_dependency_edges where revision_id = v_revision_id;
  else
    insert into public.bv2_file_revisions (
      owner, project_id, path, content_hash, size_bytes, tokens, opaque, state, indexer_version
    ) values (
      p_owner, p_project_id, v_path, v_content_hash,
      (p_file->>'size_bytes')::integer, (p_file->>'tokens')::integer,
      (p_file->>'opaque')::boolean, 'building', p_indexer_version
    ) returning id into v_revision_id;
  end if;

  insert into public.bv2_symbols (
    owner, project_id, revision_id, path, ordinal, name, kind, exported, is_default,
    start_offset, end_offset, block_hash, meta
  )
  select p_owner, p_project_id, v_revision_id, v_path, (item.ordinality - 1)::integer,
    item.value->>'name', item.value->>'kind',
    coalesce((item.value->>'exported')::boolean, false),
    coalesce((item.value->>'is_default')::boolean, false),
    (item.value->>'start_offset')::integer, (item.value->>'end_offset')::integer,
    item.value->>'block_hash', coalesce(item.value->'meta', '{}'::jsonb)
  from jsonb_array_elements(p_symbols) with ordinality as item(value, ordinality);

  if exists (
    select 1
    from jsonb_array_elements(p_refs) as ref(value)
    where not exists (
      select 1 from public.bv2_symbols as symbol
      where symbol.revision_id = v_revision_id
        and symbol.ordinal = (ref.value->>'from_symbol_ordinal')::integer
    )
  ) then
    raise exception 'reference points to a missing source symbol' using errcode = '23503';
  end if;

  insert into public.bv2_symbol_refs (
    owner, project_id, revision_id, ordinal, from_symbol, ref_name, resolved_path, count
  )
  select p_owner, p_project_id, v_revision_id, (item.ordinality - 1)::integer,
    symbol.id, item.value->>'ref_name', item.value->>'resolved_path',
    coalesce((item.value->>'count')::integer, 1)
  from jsonb_array_elements(p_refs) with ordinality as item(value, ordinality)
  join public.bv2_symbols as symbol
    on symbol.revision_id = v_revision_id
   and symbol.ordinal = (item.value->>'from_symbol_ordinal')::integer;

  insert into public.bv2_dependency_edges (
    owner, project_id, revision_id, ordinal, from_path, to_path, specifier
  )
  select p_owner, p_project_id, v_revision_id, (item.ordinality - 1)::integer,
    v_path, item.value->>'to_path', item.value->>'specifier'
  from jsonb_array_elements(p_edges) with ordinality as item(value, ordinality);

  update public.bv2_file_revisions
  set state = 'ready', graph_hash = p_graph_hash,
      symbol_count = v_symbol_count, ref_count = v_ref_count, edge_count = v_edge_count,
      completed_at = pg_catalog.clock_timestamp()
  where id = v_revision_id;

  return jsonb_build_object(
    'revision_id', v_revision_id,
    'written', true,
    'repaired', v_existing
  );
end;
$function$
;
