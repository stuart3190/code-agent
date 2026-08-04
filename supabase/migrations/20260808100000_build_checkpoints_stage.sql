-- PR5: which generation stage a checkpoint belongs to, and what that stage changed.
--
-- Checkpoints existed before this and were recorded but never restored from — a log, not a safety
-- net. Staged generation makes them the thing a lost stage falls back to, which only works if a
-- checkpoint can say which stage it is.
alter table public.build_checkpoints add column if not exists stage text;
alter table public.build_checkpoints add column if not exists changed_files jsonb;

comment on column public.build_checkpoints.stage is
  'The generation stage that produced this green tree (foundation, data, primary_journey, supporting, polish). Null for per-round checkpoints.';
comment on column public.build_checkpoints.changed_files is
  'Paths this stage created or modified, for the stage report in Diagnostics.';
