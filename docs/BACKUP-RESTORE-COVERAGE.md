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

## Worker artifact boundary and 2026-08-07 proof

`/var/lib/thrallo-build-worker-home` is service-account state and is never selected for backup.
`/var/lib/thrallo-build-worker` is the canonical durable data root. It must contain only Thrallo
job artifacts; temporary Docker/workspace state is outside it. Inventory refuses symlinks and
non-regular entries, opens regular files without following links, and records every file and
directory mode. Restore recreates only those indexed records beneath an isolated namespace.

Backup `thrallo-2026-08-07T201226` proved the empty worker root as zero files / one root-directory
record while preserving all database queue/result/event rows. Its isolated restore matched all
82 application tables (36,862 rows), 31 auth identities, 2 Storage objects, 163 filesystem files,
46 directories, 38 blobs, 2 snapshots and 12 cache rows; two-owner isolation passed. The restore
ran from `2026-08-07T20:21:37.850Z` to `2026-08-07T20:22:01.148Z`; all 56 independent external
probes failed. Containers, project volumes and restored files were destroyed afterward.
