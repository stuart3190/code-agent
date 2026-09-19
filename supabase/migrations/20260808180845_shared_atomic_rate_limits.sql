-- Package 12B: shared, atomic, restart-safe HTTP rate-limit authority.

create table public.http_rate_limit_buckets (
  key_hash text not null check (length(key_hash) = 64),
  route_class text not null check (route_class ~ '^[a-z][a-z0-9_-]{0,63}$'),
  window_started_at timestamptz not null,
  request_count integer not null check (request_count > 0),
  updated_at timestamptz not null default now(),
  primary key (key_hash, route_class)
);
create index http_rate_limit_buckets_expiry
  on public.http_rate_limit_buckets (window_started_at);
alter table public.http_rate_limit_buckets enable row level security;
revoke all on public.http_rate_limit_buckets from public, anon, authenticated;
grant select, insert, update, delete on public.http_rate_limit_buckets to service_role;

create or replace function public.consume_http_rate_limit(
  p_key_hash text,
  p_route_class text,
  p_limit integer,
  p_window_seconds integer
)
returns table(allowed boolean, remaining integer, retry_after_seconds integer, current_count integer)
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_row public.http_rate_limit_buckets%rowtype;
begin
  if p_key_hash !~ '^[0-9a-f]{64}$' or p_route_class !~ '^[a-z][a-z0-9_-]{0,63}$'
     or p_limit < 1 or p_limit > 100000 or p_window_seconds < 1 or p_window_seconds > 86400 then
    raise exception using errcode = '22023', message = 'invalid rate limit request';
  end if;

  insert into public.http_rate_limit_buckets as bucket
    (key_hash, route_class, window_started_at, request_count, updated_at)
  values (p_key_hash, p_route_class, v_now, 1, v_now)
  on conflict (key_hash, route_class) do update set
    window_started_at = case
      when bucket.window_started_at + make_interval(secs => p_window_seconds) <= v_now then v_now
      else bucket.window_started_at end,
    request_count = case
      when bucket.window_started_at + make_interval(secs => p_window_seconds) <= v_now then 1
      else bucket.request_count + 1 end,
    updated_at = v_now
  returning bucket.* into v_row;

  current_count := v_row.request_count;
  allowed := current_count <= p_limit;
  remaining := greatest(0, p_limit - current_count);
  retry_after_seconds := greatest(1, ceil(extract(epoch from
    (v_row.window_started_at + make_interval(secs => p_window_seconds) - v_now)))::integer);
  return next;
end;
$$;

create or replace function public.prune_http_rate_limits(p_older_than timestamptz default now() - interval '2 days')
returns bigint language sql security invoker set search_path = pg_catalog, public as $$
  with removed as (
    delete from public.http_rate_limit_buckets where updated_at < p_older_than returning 1
  ) select count(*)::bigint from removed;
$$;

revoke all on function public.consume_http_rate_limit(text,text,integer,integer) from public, anon, authenticated;
revoke all on function public.prune_http_rate_limits(timestamptz) from public, anon, authenticated;
grant execute on function public.consume_http_rate_limit(text,text,integer,integer) to service_role;
grant execute on function public.prune_http_rate_limits(timestamptz) to service_role;

comment on function public.consume_http_rate_limit(text,text,integer,integer) is
  'Atomic fixed-window limiter for server-side route classes. Browser roles cannot call it.';

-- Rollback: deploy the prior shell first, then revoke EXECUTE and retain the table until all
-- windows expire. Dropping active buckets before the application rollback would reset limits.
