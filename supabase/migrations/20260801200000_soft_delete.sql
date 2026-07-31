-- Soft-delete + 7-day recovery for projects (conversations): deleted_at marks the hidden
-- "Recently Deleted" state; the existing cascade runs at purge time.
alter table public.ca_conversations add column if not exists deleted_at timestamptz;
create index if not exists ca_conversations_deleted_idx on public.ca_conversations (deleted_at) where deleted_at is not null;
