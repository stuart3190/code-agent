-- Buildr Capability Runtime.
-- Supabase is the control plane; provider and media execution happens in the trusted worker.

create extension if not exists vector with schema extensions;

create table if not exists public.project_actions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  owner uuid not null references auth.users(id) on delete cascade,
  environment text not null default 'live' check (environment in ('test','live')),
  key text not null check (key ~ '^[a-z][a-z0-9_.-]{1,79}$'),
  name text not null check (char_length(name) between 1 and 120),
  description text not null default '' check (char_length(description) <= 1000),
  provider text not null,
  operation text not null,
  execution_mode text not null default 'byok' check (execution_mode in ('byok','managed','internal')),
  input_schema jsonb not null default '{"type":"object","additionalProperties":false}'::jsonb,
  output_schema jsonb not null default '{"type":"object"}'::jsonb,
  config jsonb not null default '{}'::jsonb,
  end_user_unit_cost integer not null default 0 check (end_user_unit_cost >= 0),
  free_allowance integer not null default 0 check (free_allowance >= 0),
  rate_limit_per_hour integer not null default 20 check (rate_limit_per_hour between 1 and 1000),
  timeout_seconds integer not null default 300 check (timeout_seconds between 5 and 3600),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(project_id, environment, key)
);

create table if not exists public.app_jobs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  owner uuid not null references auth.users(id) on delete cascade,
  app_user_id uuid references auth.users(id) on delete cascade,
  action_id uuid not null references public.project_actions(id) on delete restrict,
  action_key text not null,
  status text not null default 'queued' check (status in ('queued','running','waiting_provider','succeeded','failed','cancelled')),
  progress integer not null default 0 check (progress between 0 and 100),
  input jsonb not null default '{}'::jsonb,
  output jsonb,
  error_code text,
  error text,
  provider_job_id text,
  idempotency_key text not null,
  runtime_credits_reserved numeric(14,4) not null default 0 check (runtime_credits_reserved >= 0),
  runtime_credits_charged numeric(14,4) not null default 0 check (runtime_credits_charged >= 0),
  app_units_reserved integer not null default 0 check (app_units_reserved >= 0),
  cancel_requested_at timestamptz,
  available_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(project_id, app_user_id, idempotency_key)
);

create table if not exists public.runtime_usage (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null unique references public.app_jobs(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  owner uuid not null references auth.users(id) on delete cascade,
  provider text not null,
  execution_mode text not null check (execution_mode in ('byok','managed','internal')),
  status text not null default 'reserved' check (status in ('reserved','settled','refunded')),
  provider_cost_gbp numeric(14,6) not null default 0 check (provider_cost_gbp >= 0),
  reserved_credits numeric(14,4) not null default 0 check (reserved_credits >= 0),
  charged_credits numeric(14,4) not null default 0 check (charged_credits >= 0),
  reserved_bundle numeric(14,4) not null default 0 check (reserved_bundle >= 0),
  reserved_topup numeric(14,4) not null default 0 check (reserved_topup >= 0),
  pricing jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.app_usage_ledger (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  app_user_id uuid not null references auth.users(id) on delete cascade,
  delta integer not null check (delta <> 0),
  kind text not null check (kind in ('grant','reserve','refund','expire','adjust')),
  ref text not null,
  product_id uuid references public.payment_products(id) on delete set null,
  job_id uuid references public.app_jobs(id) on delete set null,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  unique(project_id, app_user_id, ref, kind)
);

alter table public.payment_products add column if not exists usage_units integer not null default 0 check (usage_units >= 0);
alter table public.payment_products add column if not exists action_scope text[] not null default '{}'::text[];

create table if not exists public.action_schedules (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  owner uuid not null references auth.users(id) on delete cascade,
  action_id uuid not null references public.project_actions(id) on delete cascade,
  name text not null,
  schedule text not null,
  timezone text not null default 'UTC',
  input jsonb not null default '{}'::jsonb,
  enabled boolean not null default true,
  next_run_at timestamptz,
  last_run_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.provider_webhook_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  external_id text not null,
  job_id uuid references public.app_jobs(id) on delete cascade,
  payload_hash text not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  unique(provider, external_id)
);

create table if not exists public.knowledge_bases (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  owner uuid not null references auth.users(id) on delete cascade,
  key text not null check (key ~ '^[a-z][a-z0-9_.-]{1,79}$'),
  name text not null,
  config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(project_id, key)
);

create table if not exists public.knowledge_documents (
  id uuid primary key default gen_random_uuid(),
  knowledge_base_id uuid not null references public.knowledge_bases(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  owner uuid not null references auth.users(id) on delete cascade,
  name text not null,
  storage_path text,
  status text not null default 'queued' check (status in ('queued','processing','ready','failed')),
  metadata jsonb not null default '{}'::jsonb,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.knowledge_chunks (
  id bigint generated always as identity primary key,
  knowledge_base_id uuid not null references public.knowledge_bases(id) on delete cascade,
  document_id uuid not null references public.knowledge_documents(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  content text not null,
  metadata jsonb not null default '{}'::jsonb,
  embedding extensions.vector(1536),
  created_at timestamptz not null default now()
);

create index if not exists project_actions_owner_project_idx on public.project_actions(owner, project_id, environment);
create index if not exists app_jobs_claim_idx on public.app_jobs(status, available_at, created_at) where status = 'queued';
create index if not exists app_jobs_user_idx on public.app_jobs(app_user_id, project_id, created_at desc);
create index if not exists app_jobs_owner_idx on public.app_jobs(owner, project_id, created_at desc);
create index if not exists app_jobs_action_idx on public.app_jobs(action_id);
create index if not exists runtime_usage_owner_idx on public.runtime_usage(owner, project_id, created_at desc);
create index if not exists app_usage_user_idx on public.app_usage_ledger(app_user_id, project_id, created_at desc);
create index if not exists app_usage_product_idx on public.app_usage_ledger(product_id) where product_id is not null;
create index if not exists app_usage_job_idx on public.app_usage_ledger(job_id) where job_id is not null;
create index if not exists action_schedules_due_idx on public.action_schedules(next_run_at) where enabled = true;
create index if not exists action_schedules_owner_idx on public.action_schedules(owner, project_id, created_at desc);
create index if not exists action_schedules_action_idx on public.action_schedules(action_id);
create index if not exists provider_webhook_job_idx on public.provider_webhook_events(job_id) where job_id is not null;
create index if not exists knowledge_bases_owner_idx on public.knowledge_bases(owner, project_id, created_at desc);
create index if not exists knowledge_documents_project_idx on public.knowledge_documents(owner, project_id, created_at desc);
create index if not exists knowledge_documents_base_idx on public.knowledge_documents(knowledge_base_id);
create index if not exists knowledge_chunks_lookup_idx on public.knowledge_chunks(knowledge_base_id, document_id);
create index if not exists knowledge_chunks_document_idx on public.knowledge_chunks(document_id);

alter table public.project_actions enable row level security;
alter table public.app_jobs enable row level security;
alter table public.runtime_usage enable row level security;
alter table public.app_usage_ledger enable row level security;
alter table public.action_schedules enable row level security;
alter table public.provider_webhook_events enable row level security;
alter table public.knowledge_bases enable row level security;
alter table public.knowledge_documents enable row level security;
alter table public.knowledge_chunks enable row level security;

create policy project_actions_owner_read on public.project_actions for select to authenticated
  using ((select auth.uid()) = owner);
create policy app_jobs_participant_read on public.app_jobs for select to authenticated
  using ((select auth.uid()) = app_user_id or (select auth.uid()) = owner);
create policy runtime_usage_owner_read on public.runtime_usage for select to authenticated
  using ((select auth.uid()) = owner);
create policy app_usage_user_read on public.app_usage_ledger for select to authenticated
  using ((select auth.uid()) = app_user_id);
create policy action_schedules_owner_read on public.action_schedules for select to authenticated
  using ((select auth.uid()) = owner);
create policy knowledge_bases_owner_read on public.knowledge_bases for select to authenticated
  using ((select auth.uid()) = owner);
create policy knowledge_documents_owner_read on public.knowledge_documents for select to authenticated
  using ((select auth.uid()) = owner);

revoke all on public.project_actions, public.app_jobs, public.runtime_usage, public.app_usage_ledger,
  public.action_schedules, public.provider_webhook_events, public.knowledge_bases,
  public.knowledge_documents, public.knowledge_chunks from anon, authenticated;
grant select on public.project_actions, public.app_jobs, public.runtime_usage, public.app_usage_ledger,
  public.action_schedules, public.knowledge_bases, public.knowledge_documents to authenticated;

-- Atomic reservation keeps concurrent runtime jobs from overspending an owner's balance.
create or replace function public.reserve_runtime_credits(p_owner uuid, p_job uuid, p_amount numeric, p_provider text, p_mode text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_bundle numeric(14,4); v_topup numeric(14,4); v_from_bundle numeric(14,4); v_from_topup numeric(14,4);
  v_ref text := 'runtime:' || p_job::text;
begin
  if p_amount < 0 or p_mode not in ('byok','managed','internal') then raise exception 'invalid runtime reservation'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_owner::text, 0));
  if exists(select 1 from public.runtime_usage where job_id = p_job) then
    return (select jsonb_build_object('ok', true, 'idempotent', true, 'reserved', reserved_credits) from public.runtime_usage where job_id = p_job);
  end if;
  select coalesce(sum(delta) filter(where bucket='bundle'),0), coalesce(sum(delta) filter(where bucket='topup'),0)
    into v_bundle, v_topup from public.credit_ledger where owner = p_owner;
  if p_mode <> 'byok' and v_bundle + v_topup < p_amount then
    return jsonb_build_object('ok', false, 'reason', 'insufficient_balance', 'balance', v_bundle + v_topup, 'need', p_amount);
  end if;
  v_from_bundle := case when p_mode='byok' then 0 else least(p_amount, greatest(v_bundle,0)) end;
  v_from_topup := case when p_mode='byok' then 0 else p_amount - v_from_bundle end;
  if v_from_bundle > 0 then insert into public.credit_ledger(owner,delta,bucket,kind,model,tokens,weight,ref)
    values(p_owner,-v_from_bundle,'bundle','debit','runtime:'||p_provider,0,1,v_ref); end if;
  if v_from_topup > 0 then insert into public.credit_ledger(owner,delta,bucket,kind,model,tokens,weight,ref)
    values(p_owner,-v_from_topup,'topup','debit','runtime:'||p_provider,0,1,v_ref); end if;
  insert into public.runtime_usage(job_id,project_id,owner,provider,execution_mode,reserved_credits,reserved_bundle,reserved_topup)
    select p_job,project_id,p_owner,p_provider,p_mode,p_amount,v_from_bundle,v_from_topup from public.app_jobs where id=p_job;
  update public.app_jobs set runtime_credits_reserved=p_amount,updated_at=now() where id=p_job;
  return jsonb_build_object('ok', true, 'idempotent', false, 'reserved', p_amount);
end $$;

create or replace function public.settle_runtime_credits(p_job uuid, p_charge numeric, p_provider_cost_gbp numeric default 0)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v public.runtime_usage%rowtype; v_ref text := 'runtime-refund:' || p_job::text;
  v_refund numeric(14,4); v_bundle numeric(14,4); v_topup numeric(14,4);
begin
  select * into v from public.runtime_usage where job_id=p_job for update;
  if not found then raise exception 'runtime usage not found'; end if;
  if v.status <> 'reserved' then return jsonb_build_object('ok',true,'idempotent',true,'charged',v.charged_credits); end if;
  p_charge := least(greatest(coalesce(p_charge,0),0),v.reserved_credits);
  v_refund := v.reserved_credits-p_charge;
  v_topup := least(v_refund,v.reserved_topup);
  v_bundle := v_refund-v_topup;
  if v_bundle > 0 then insert into public.credit_ledger(owner,delta,bucket,kind,model,tokens,weight,ref)
    values(v.owner,v_bundle,'bundle','refund','runtime:'||v.provider,0,1,v_ref); end if;
  if v_topup > 0 then insert into public.credit_ledger(owner,delta,bucket,kind,model,tokens,weight,ref)
    values(v.owner,v_topup,'topup','refund','runtime:'||v.provider,0,1,v_ref); end if;
  update public.runtime_usage set status=case when p_charge=0 then 'refunded' else 'settled' end,
    provider_cost_gbp=greatest(coalesce(p_provider_cost_gbp,0),0),charged_credits=p_charge,updated_at=now() where id=v.id;
  update public.app_jobs set runtime_credits_charged=p_charge,updated_at=now() where id=p_job;
  return jsonb_build_object('ok',true,'charged',p_charge,'refunded',v_refund);
end $$;

create or replace function public.reserve_app_units(p_project uuid, p_user uuid, p_job uuid, p_units integer)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_balance bigint; v_ref text := 'job:'||p_job::text;
begin
  if p_units < 0 then raise exception 'invalid app unit reservation'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_project::text||':'||p_user::text,0));
  if exists(select 1 from public.app_usage_ledger where project_id=p_project and app_user_id=p_user and ref=v_ref and kind='reserve') then
    return jsonb_build_object('ok',true,'idempotent',true,'reserved',p_units);
  end if;
  select coalesce(sum(delta),0) into v_balance from public.app_usage_ledger
    where project_id=p_project and app_user_id=p_user and (expires_at is null or expires_at>now());
  if p_units > v_balance then return jsonb_build_object('ok',false,'reason','insufficient_app_units','balance',v_balance,'need',p_units); end if;
  if p_units > 0 then
    insert into public.app_usage_ledger(project_id,app_user_id,delta,kind,ref,job_id)
      values(p_project,p_user,-p_units,'reserve',v_ref,p_job);
    update public.app_jobs set app_units_reserved=p_units,updated_at=now() where id=p_job;
  end if;
  return jsonb_build_object('ok',true,'idempotent',false,'reserved',p_units);
end $$;

create or replace function public.refund_app_units(p_job uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v public.app_jobs%rowtype; v_ref text := 'job-refund:'||p_job::text;
begin
  select * into v from public.app_jobs where id=p_job for update;
  if not found then raise exception 'job not found'; end if;
  if v.app_units_reserved <= 0 then return jsonb_build_object('ok',true,'refunded',0); end if;
  insert into public.app_usage_ledger(project_id,app_user_id,delta,kind,ref,job_id)
    values(v.project_id,v.app_user_id,v.app_units_reserved,'refund',v_ref,p_job)
    on conflict(project_id,app_user_id,ref,kind) do nothing;
  return jsonb_build_object('ok',true,'refunded',v.app_units_reserved);
end $$;

create or replace function public.match_knowledge_chunks(p_project uuid, p_base uuid, p_embedding extensions.vector(1536), p_limit integer default 8)
returns table(id bigint, document_id uuid, content text, metadata jsonb, similarity double precision)
language sql stable security definer set search_path = public, extensions, pg_temp as $$
  select c.id,c.document_id,c.content,c.metadata,1-(c.embedding <=> p_embedding) as similarity
  from public.knowledge_chunks c
  where c.project_id=p_project and c.knowledge_base_id=p_base and c.embedding is not null
  order by c.embedding <=> p_embedding limit least(greatest(p_limit,1),20)
$$;

-- Workers atomically claim different queue rows when runtime concurrency is scaled out.
create or replace function public.claim_runtime_tasks(p_limit integer default 4)
returns setof public.background_tasks language sql security definer set search_path = public, pg_temp as $$
  update public.background_tasks
  set status='running', started_at=now(), attempts=attempts+1, updated_at=now()
  where id in (
    select id from public.background_tasks
    where status='queued' and type='runtime_job' and available_at<=now()
    order by created_at
    limit least(greatest(p_limit,1),20)
    for update skip locked
  )
  returning *
$$;

revoke all on function public.reserve_runtime_credits(uuid,uuid,numeric,text,text) from public, anon, authenticated;
revoke all on function public.settle_runtime_credits(uuid,numeric,numeric) from public, anon, authenticated;
grant execute on function public.reserve_runtime_credits(uuid,uuid,numeric,text,text) to service_role;
grant execute on function public.settle_runtime_credits(uuid,numeric,numeric) to service_role;
revoke all on function public.reserve_app_units(uuid,uuid,uuid,integer) from public, anon, authenticated;
revoke all on function public.refund_app_units(uuid) from public, anon, authenticated;
grant execute on function public.reserve_app_units(uuid,uuid,uuid,integer) to service_role;
grant execute on function public.refund_app_units(uuid) to service_role;
revoke all on function public.match_knowledge_chunks(uuid,uuid,extensions.vector,integer) from public, anon, authenticated;
grant execute on function public.match_knowledge_chunks(uuid,uuid,extensions.vector,integer) to service_role;
revoke all on function public.claim_runtime_tasks(integer) from public, anon, authenticated;
grant execute on function public.claim_runtime_tasks(integer) to service_role;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('runtime-assets','runtime-assets',false,524288000,array['image/jpeg','image/png','image/webp','video/mp4','audio/mpeg','audio/wav','application/pdf','text/csv','application/zip'])
on conflict(id) do nothing;

create policy runtime_assets_select_own on storage.objects for select to authenticated
  using (bucket_id='runtime-assets' and (storage.foldername(name))[2]=(select auth.uid())::text);
create policy runtime_assets_insert_own on storage.objects for insert to authenticated
  with check (bucket_id='runtime-assets' and (storage.foldername(name))[2]=(select auth.uid())::text);
create policy runtime_assets_update_own on storage.objects for update to authenticated
  using (bucket_id='runtime-assets' and (storage.foldername(name))[2]=(select auth.uid())::text)
  with check (bucket_id='runtime-assets' and (storage.foldername(name))[2]=(select auth.uid())::text);
create policy runtime_assets_delete_own on storage.objects for delete to authenticated
  using (bucket_id='runtime-assets' and (storage.foldername(name))[2]=(select auth.uid())::text);

do $$ begin
  alter publication supabase_realtime add table public.app_jobs;
exception when duplicate_object then null; end $$;

insert into public.feature_flags(key,enabled,rollout_percent,config) values
  ('capability_runtime',false,0,'{"managed_margin_percent":10,"media_concurrency":1,"api_concurrency":4}'::jsonb),
  ('managed_ai_runtime',false,0,'{}'::jsonb),
  ('media_runtime',false,0,'{}'::jsonb),
  ('knowledge_runtime',false,0,'{}'::jsonb),
  ('app_usage_packs',false,0,'{}'::jsonb)
on conflict(key) do nothing;
