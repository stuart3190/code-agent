-- App identity (2026-07-17) — generated display name + icon glyph per project, used for the PWA
-- manifest + install icon and the Android app. Applied live via the Supabase MCP the day written.
-- Generated once (Codex) on first publish, reused thereafter; null on existing projects →
-- generated on their next publish. owner-RLS already covers these columns (projects is owner-scoped).
alter table public.projects add column if not exists app_name text;
alter table public.projects add column if not exists app_icon text;
