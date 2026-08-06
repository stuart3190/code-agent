# Backup and isolated restore proof — 2026-08-06

## Production backup

- Run: `/home/ubuntu/thrallo-backups/thrallo-2026-08-06T214220`
- Started: `2026-08-06T21:42:20.799Z`
- Finalised: `2026-08-06T21:42:47.966Z`
- Compressed payload bytes: `32,949,517`
- Checksummed files: `242`
- Application tables: `72`
- Application rows: `36,862`
- Auth ownership identities: `31`
- Supabase Storage objects: `2`
- Publish filesystem: `153` files / `5,734,627` source bytes
- QA filesystem: `10` files / `1,267,538` source bytes
- Authoritative production ledger: `60` applied migrations
- Local pending migration: `20260806210321` only

The `thrallo-backup.service` main process and its migration-drift post-check both exited zero.
Incomplete historical runs were quarantined under `.failed-*`; new runs are written under
`.incomplete-*` and become discoverable as `thrallo-*` only after full checksum validation.

## Isolated restore

The backup was restored into the disposable local Supabase stack on loopback port `55321`. VPS
ports `55320-55327` were blocked from external access before production data entered the target.
No production URL or production service key was used as a restore target.

Deterministic comparison passed for all `72` application tables and `36,862` rows. The proof also
passed for `31` auth ownership identities, both Storage objects, all `163` filesystem objects,
all `38` content-addressed blobs, both snapshots and their `74` file references, the project
pointer, all `12` verification-cache rows, and two independent authenticated owner principals.
Every blob matched its declared SHA-256 and byte length; both snapshots materialised and matched
their declared tree hashes.

`ca_run_events.id` is generated-always. This backup is exactly contiguous from `1` through `1887`,
so the restore sorts the rows and regenerates the same identities. The restore now fails closed if
a future backup contains gaps; a database-native `OVERRIDING SYSTEM VALUE` restore remains required
before a gapped backup can be restored exactly.

The logical auth export intentionally does not preserve password hashes, OAuth identities, MFA
factors, or sessions. User UUIDs, email ownership and application/user metadata are preserved;
credentials must be re-established after a total project-loss restore. The Supabase organization is
on the free plan and provides no independent managed-backup proof through the connected plugin.

The machine-readable manifest, restore log, verification result, and systemd status are retained
beside this document. The disposable restored data was destroyed after evidence capture; the source
backup remains intact on the VPS.
