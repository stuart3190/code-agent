-- Package 14R forward repair: immutable snapshot identity includes the asset manifest.
--
-- The original unique index used (project_id, tree_hash). Asset-only regeneration intentionally
-- keeps source bytes unchanged while pinning a new immutable asset manifest, so the old identity
-- rejected a valid second snapshot. The replacement preserves content-addressed source identity
-- while allowing only manifest-distinct snapshots.
--
-- Lock scope: two short ACCESS EXCLUSIVE metadata operations on bv2_snapshots plus the initial
-- index build. The table is small at current pre-launch scale. No row is rewritten.
-- Forward repair: if interrupted after the new index is created, rerun this migration; both DDL
-- statements are idempotent. Rollback is safe only while no project has two rows with the same
-- tree_hash and different asset_manifest values; otherwise retain the corrected index.

create unique index if not exists bv2_snapshots_project_tree_assets
  on public.bv2_snapshots (project_id, tree_hash, asset_manifest);

drop index if exists public.bv2_snapshots_project_tree;

comment on index public.bv2_snapshots_project_tree_assets is
  'Immutable snapshot identity: identical source bytes may pin distinct immutable asset manifests.';
