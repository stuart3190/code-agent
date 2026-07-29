-- Serialize project creation per owner so concurrent inserts cannot both pass the count check.
create or replace function public.enforce_project_cap()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  n int;
  cap int;
begin
  perform pg_advisory_xact_lock(hashtextextended(new.owner::text, 0));
  select count(*) into n from projects where owner = new.owner;
  select case when exists (select 1 from customers where owner = new.owner and tier is not null)
              then 100 else 10 end
    into cap;
  if n >= cap then
    raise exception 'PROJECT_CAP: this account already has % projects (limit %). Delete an old project%',
      n, cap, case when cap = 10 then ' or upgrade to a paid plan for a higher limit.' else '.' end;
  end if;
  return new;
end
$$;

revoke execute on function public.enforce_project_cap() from public, anon, authenticated;
