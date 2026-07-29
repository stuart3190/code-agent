create table if not exists public.payment_products (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  owner uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  description text not null default '' check (char_length(description) <= 500),
  currency text not null default 'gbp' check (currency ~ '^[a-z]{3}$'),
  unit_amount integer not null check (unit_amount > 0 and unit_amount <= 100000000),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.payment_orders (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  owner uuid not null references auth.users(id) on delete cascade,
  app_user_id uuid references auth.users(id) on delete set null,
  product_id uuid references public.payment_products(id) on delete set null,
  stripe_account_id text not null,
  stripe_session_id text not null unique,
  stripe_payment_intent_id text,
  amount_total integer not null default 0 check (amount_total >= 0),
  currency text not null default 'gbp' check (currency ~ '^[a-z]{3}$'),
  customer_email text,
  status text not null default 'pending' check (status in ('pending', 'paid', 'failed', 'refunded')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists payment_products_owner_project_idx
  on public.payment_products(owner, project_id, created_at desc);
create index if not exists payment_orders_owner_project_idx
  on public.payment_orders(owner, project_id, created_at desc);
create index if not exists payment_orders_app_user_idx
  on public.payment_orders(app_user_id, project_id, created_at desc);
create index if not exists payment_orders_product_idx on public.payment_orders(product_id);

alter table public.payment_products enable row level security;
alter table public.payment_orders enable row level security;

drop policy if exists payment_products_owner_read on public.payment_products;
create policy payment_products_owner_read on public.payment_products for select to authenticated
  using ((select auth.uid()) = owner);
drop policy if exists payment_orders_owner_read on public.payment_orders;
create policy payment_orders_owner_read on public.payment_orders for select to authenticated
  using ((select auth.uid()) = owner);

revoke all on table public.payment_products from anon, authenticated;
revoke all on table public.payment_orders from anon, authenticated;
grant select on table public.payment_products to authenticated;
grant select on table public.payment_orders to authenticated;
