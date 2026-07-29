-- F7 publish: where the project's static site is served (null = unpublished).
-- Applied live via the Supabase MCP on 2026-07-06 (project qgemqjcyhuejrsvjxkbh).

alter table public.projects add column if not exists published_url text;
