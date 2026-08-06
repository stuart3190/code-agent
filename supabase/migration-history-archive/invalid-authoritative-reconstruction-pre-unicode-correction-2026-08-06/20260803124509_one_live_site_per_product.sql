alter table public.published_sites
  add column if not exists product_id uuid;

comment on column public.published_sites.product_id is
  'The product this site belongs to, copied from projects at publish time so the one-live-row-per-product invariant can be enforced by index. Null means the project has no product link and stands alone.';

update public.published_sites s
   set product_id = p.product_id
  from public.projects p
 where p.id::text = s.project_id
   and s.product_id is distinct from p.product_id;

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

create unique index if not exists published_sites_one_live_per_product
  on public.published_sites (owner, product_id)
  where unpublished_at is null and product_id is not null;

create index if not exists published_sites_product_idx
  on public.published_sites (owner, product_id);