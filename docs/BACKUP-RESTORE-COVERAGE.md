# Backup and restore coverage

C8 adds no backup format break. It extends the existing manifest with two database tables while the
already-covered `publish` filesystem root naturally includes all new release paths.

Restore order is:

1. auth owners, products and projects;
2. `published_sites` and `deployments`;
3. `publish_releases`;
4. `publish_activation_intents`;
5. `custom_domains`;
6. filesystem objects under `publish`, including `.thrallo/releases`, `.thrallo/sites`, `_domains`
   and retained legacy directories.

An isolated restore is valid only when every filesystem object's size/hash/mode matches, every
release manifest re-hashes to `artifact_hash`, every active site pointer resolves to its database
release, custom-domain links resolve through the same site pointer, and owner/project relationships
match. An unfinished restored intent is reconciled only after pointer observation. Verification may
invalidate a cache, but it may not rebuild a missing release artifact.

Project erasure calls provisiond release purge before database rows are deleted. The append-only
deletion evidence records identifiers/counts, never artifact content. A missing release directory is
acceptable only when no retained release row references it; otherwise deletion/restore is failed,
not downgraded to a warning.

The disposable target must also pass the network and logging prerequisites in
`docs/DISPOSABLE-SUPABASE-RESTORE.md`. A loopback URL alone is not proof of isolation because the
CLI publishes container ports independently. Production data must not enter the target until all
ports `55320-55327` fail from an independent external host, and that probe must continue throughout
the restore. Timestamped container/API/database logs are part of the restore evidence, not cleanup
scratch data.
