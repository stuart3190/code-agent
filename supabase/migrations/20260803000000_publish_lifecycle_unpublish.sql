-- Unpublishing takes a site offline without discarding what happened.
--
-- The row is KEPT and stamped rather than deleted: publish history and deployment metadata
-- (slug, url, first published date) survive, so republishing reuses the same address instead of
-- minting a new one, and "this used to be live at X" stays answerable.
alter table public.published_sites
  add column if not exists unpublished_at timestamptz;

-- Republishing clears the stamp, so a partial index over live sites stays small and honest.
create index if not exists published_sites_live_idx
  on public.published_sites (owner)
  where unpublished_at is null;

comment on column public.published_sites.unpublished_at is
  'Set when the owner takes the site offline. Null means live. Republishing clears it; the row is never deleted on unpublish so history and the claimed slug survive.';
