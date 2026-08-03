-- One live published record per product, enforced by the database.
--
-- A product can own several project rows — every rebuild can create one — and each could leave a
-- published_sites row behind. Two LIVE rows for one product is a data fault: the platform then has
-- to pick a winner on read, and two surfaces picking differently is exactly the disagreement this
-- migration exists to make impossible.
--
-- published_sites has no product_id, so the constraint needs one. It is denormalised deliberately:
-- the invariant is about the product, and a partial unique index is the only thing that can hold it
-- for every writer, including a future one that has not been written yet.

alter table public.published_sites
  add column if not exists product_id uuid;

comment on column public.published_sites.product_id is
  'The product this site belongs to, copied from projects at publish time so the one-live-row-per-product invariant can be enforced by index. Null means the project has no product link and stands alone.';

-- Backfill from the owning project.
update public.published_sites s
   set product_id = p.product_id
  from public.projects p
 -- published_sites.project_id is TEXT while projects.id is uuid, so the join is cast explicitly.
 where p.id::text = s.project_id
   and s.product_id is distinct from p.product_id;

-- Repair before constraining, so the migration cannot fail on data it is meant to fix.
--
-- Keeps the most recently published live row per product and retires the rest. Retiring means
-- stamping unpublished_at — never deleting: the slug, the URL and the publish history live on that
-- row, and a republish has to return to the same address.
with ranked as (
  select id,
         row_number() over (
           partition by owner, product_id
           order by updated_at desc, project_id desc
         ) as rank
    from public.published_sites
   where unpublished_at is null
     and product_id is not null
)
update public.published_sites s
   set unpublished_at = now()
  from ranked r
 where r.id = s.id
   and r.rank > 1;

-- The invariant. Null product_id is exempt: Postgres treats nulls as distinct, which is the
-- behaviour wanted here — a project with no product link stands alone and constrains nothing.
create unique index if not exists published_sites_one_live_per_product
  on public.published_sites (owner, product_id)
  where unpublished_at is null and product_id is not null;

create index if not exists published_sites_product_idx
  on public.published_sites (owner, product_id);
