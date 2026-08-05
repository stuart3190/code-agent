-- Builder v2 (WP-9): core-scope journey verdicts are recorded BEFORE any snapshot exists —
-- only green trees get snapshots, and verification is what decides green. snapshot_id is
-- provenance, not identity (the key is owner/project/journey/owners_hash), so it may be null.
-- Rollback: alter table bv2_verification_cache alter column snapshot_id set not null;
--           (after deleting rows where snapshot_id is null)
alter table bv2_verification_cache alter column snapshot_id drop not null;
