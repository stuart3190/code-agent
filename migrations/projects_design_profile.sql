-- Premium design pipeline (2026-07-20): persist one project-specific art direction so later
-- edits preserve it. Existing rows remain NULL and retain their current visual system until the
-- owner explicitly chooses Redesign. Existing projects RLS policies already cover this column.

alter table public.projects
  add column if not exists design_profile jsonb;

comment on column public.projects.design_profile is
  'Validated Buildr101 design profile (category/family/palette/type/imagery); client-owned under projects RLS.';
