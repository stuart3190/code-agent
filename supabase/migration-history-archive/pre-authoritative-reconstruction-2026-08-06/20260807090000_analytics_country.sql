-- Country for analytics events.
--
-- Resolved at ingest from the visitor's address, in the same short window that address is already
-- being hashed in for the cookieless visitor id, and ONLY the two-letter code is kept. There is
-- deliberately no ip column here and there never has been: the address exists as an argument to a
-- hash for the length of one request and is written nowhere. Adding country does not change that,
-- and ops/prove-geoip.mjs asserts it.
--
-- Nullable because it is genuinely optional. A deployment with no MaxMind licence, a database that
-- has not downloaded yet, or an address with no entry all produce null — and the rollup skips
-- falsy dimension values, so those periods have no country rows rather than a bucket labelled
-- "Unknown" that would read like somewhere real.
--
-- Two characters exactly: ISO 3166-1 alpha-2, which is what GeoLite2-Country returns. The reader
-- refuses anything that is not two uppercase letters before it reaches here.

alter table public.analytics_events
  add column if not exists country text
  check (country is null or country ~ '^[A-Z]{2}$');

-- The reporting query groups by (project, day, dimension, key) via analytics_daily, which already
-- has its own index; this one serves the raw-event path used by the live view and the exporter.
create index if not exists analytics_events_country_idx
  on public.analytics_events (project_id, country)
  where country is not null;
