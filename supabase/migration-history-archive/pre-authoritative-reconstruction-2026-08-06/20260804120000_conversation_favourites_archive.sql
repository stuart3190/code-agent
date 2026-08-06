-- Favourites and archive for projects.
--
-- Archive is NOT delete. A deleted project is scheduled for permanent removal after seven days and
-- takes its site, analytics and history with it; an archived one is simply out of the way and keeps
-- everything, including a live site. Two different intentions, so two different columns — reusing
-- deleted_at for both would make "archive" quietly destructive.
--
-- `state` is deliberately not used for this. It is the conversation lifecycle (idle, thinking,
-- waiting_user) and a thinking project can also be archived; listConversations carried a
-- `neq(state,'archived')` filter for a value nothing has ever written.

alter table public.ca_conversations
  add column if not exists favourite boolean not null default false,
  add column if not exists archived_at timestamptz;

comment on column public.ca_conversations.favourite is
  'Pinned by the owner. Favourites sort first within whatever ordering is chosen.';
comment on column public.ca_conversations.archived_at is
  'Out of the way but fully intact — unlike deleted_at, nothing is scheduled for removal and a published site keeps serving.';

-- The default list: not archived, not deleted, newest activity first. Partial so it stays small as
-- archived projects accumulate.
create index if not exists ca_conversations_owner_active_idx
  on public.ca_conversations (owner, last_activity_at desc)
  where deleted_at is null and archived_at is null;

-- The archive view, which is read rarely and should not cost the default list anything.
create index if not exists ca_conversations_owner_archived_idx
  on public.ca_conversations (owner, archived_at desc)
  where deleted_at is null and archived_at is not null;

create index if not exists ca_conversations_owner_favourite_idx
  on public.ca_conversations (owner, last_activity_at desc)
  where favourite and deleted_at is null and archived_at is null;
