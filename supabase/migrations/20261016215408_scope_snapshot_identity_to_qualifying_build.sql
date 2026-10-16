-- Qualification metadata is build-scoped; blobs stay owner-deduplicated.
-- Create the wider index before dropping the old one. No rows are rewritten.
-- Rollback must retain this wider index if separate builds have since qualified identical bytes.
create unique index if not exists bv2_snapshots_project_tree_assets_build
on public.bv2_snapshots (project_id, tree_hash, asset_manifest, coalesce(build_id, '00000000-0000-0000-0000-000000000000'::uuid));
drop index if exists public.bv2_snapshots_project_tree_assets;
comment on index public.bv2_snapshots_project_tree_assets_build is 'Immutable snapshot identity includes the qualifying build; blob bytes remain owner-deduplicated.';
