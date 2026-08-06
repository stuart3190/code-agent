alter table public.analytics_events
  add column if not exists country text
  check (country is null or country ~ '^[A-Z]{2}$');

create index if not exists analytics_events_country_idx
  on public.analytics_events (project_id, country)
  where country is not null;