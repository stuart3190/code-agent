alter table public.ca_conversations
  add column if not exists favourite boolean not null default false,
  add column if not exists archived_at timestamptz;

comment on column public.ca_conversations.favourite is
  'Pinned by the owner. Favourites sort first within whatever ordering is chosen.';
comment on column public.ca_conversations.archived_at is
  'Out of the way but fully intact ??? unlike deleted_at, nothing is scheduled for removal and a published site keeps serving.';

create index if not exists ca_conversations_owner_active_idx
  on public.ca_conversations (owner, last_activity_at desc)
  where deleted_at is null and archived_at is null;

create index if not exists ca_conversations_owner_archived_idx
  on public.ca_conversations (owner, archived_at desc)
  where deleted_at is null and archived_at is not null;

create index if not exists ca_conversations_owner_favourite_idx
  on public.ca_conversations (owner, last_activity_at desc)
  where favourite and deleted_at is null and archived_at is not null is false and archived_at is null;