# Thrallo disaster recovery

## What is backed up, where, and when

`ops/backup-thrallo.mjs` runs nightly on the VPS under `thrallo-backup.timer` (03:20 UTC,
persistent) and writes `~/thrallo-backups/thrallo-<stamp>/` containing:

- every migrated Thrallo application table as gzipped JSON, including
  `bv2_model_reservations`, the erasure audit, and all `bv2_*` graph, snapshot, cache,
  asset, diagnostic, ownership, feature-flag and runtime tables. Before reading production,
  the backup compares its manifest with the live `thrallo_public_tables()` catalog and
  aborts on an omitted or unknown canonical table. The ephemeral fixed-window rate-limit
  bucket is deliberately excluded because it is not recovery state;
- `auth_users.json.gz` — Supabase Auth UUIDs, email addresses and application/user metadata.
  Password hashes, OAuth identities, MFA factors and sessions are not exported by this logical
  backup, so users re-establish credentials after a restore;
- the private `thrallo-artifacts` Storage bucket, one gzipped file per object plus an index
  with original keys, content types and content hashes;
- current publish, QA and durable build-worker filesystem artifacts, stored by logical root
  with file/directory paths, modes, sizes and content hashes. VPS previews are ephemeral and
  re-materialised from canonical project/snapshot data;
- authoritative production migration-ledger evidence plus the local/applied-state map; and
- `manifest.json` with per-file row counts, sizes and SHA-256 checksums.

Every run is validated immediately after writing. Runs older than
`THRALLO_BACKUP_KEEP_DAYS` (14) are pruned. Buildr101 backups are separate and untouched.

The reconstructed authoritative history is immutable. Later production migrations are captured
as dated, read-only ledger overlays containing the remote statement hash and local applied-file
hash. Backup creation requires contiguous order and refuses a changed applied identity.

`bv2_builds.project_id_text` and `diag_runs.project_id_text` are generated columns. They are
never included in restore writes; PostgreSQL regenerates them and the isolated verifier compares
every regenerated value with its source UUID.

The worker account home (`/var/lib/thrallo-build-worker-home`) is not backup input. Only the
canonical artifact root (`/var/lib/thrallo-build-worker`) is included. Any unexpected symlink
inside that root aborts the backup.

## Recovery objectives and retention

- RPO: 24 hours for canonical database, Auth, Storage and filesystem state.
- RTO: 4 hours to provision an isolated target, restore, verify and perform an approved cutover.
- Local complete backups: 14 daily copies.
- Off-host encrypted backups: 30 daily and 12 monthly copies.
- Restore drill: monthly in the externally blocked disposable Supabase stack.

The current scale does not justify a multi-region hot standby. These objectives are intentionally
modest and measurable. A missed backup or restore drill is an incident, not a warning.

## The disaster-recovery kit — keep these off the VPS

1. **`shell/.env`** — above all `PLATFORM_ENC_KEY`. Every encrypted credential and diagnostic
   payload is unusable without it. It also contains provider and Supabase secrets and must never
   be copied into a backup archive.
2. A recent completed `thrallo-<stamp>/` backup directory.
3. The approved immutable release/deployment manifest and artifact hashes.

## Encrypted off-host copy

No storage vendor is purchased or configured by this repository. Install `age` and `rclone`,
create a remote with write-only credentials where supported, and store
`THRALLO_OFFSITE_AGE_RECIPIENT` and `THRALLO_OFFSITE_RCLONE_REMOTE` in the operator secret store.
The age private identity stays offline and is tested during the monthly drill.

Run `node ops/offsite-backup.mjs` to validate configuration. Run it with `--upload` only after a
complete local backup. It encrypts before transfer and uses immutable remote writes; it never
uploads plaintext or replaces an existing object.

Put only `THRALLO_OFFSITE_AGE_RECIPIENT` and `THRALLO_OFFSITE_RCLONE_REMOTE` in
`/etc/thrallo/offsite-backup.env` (root-owned, mode 0600). The off-site unit deliberately does not
load the shell environment, so provider, database and billing secrets are unavailable to it.

The monthly drill additionally requires `/etc/thrallo/restore-drill.env` with
`THRALLO_RESTORE_PUBLIC_HOST` and `THRALLO_EXTERNAL_PROBE_COMMAND`. The probe command must be an
absolute executable which delegates every 55320–55327 check to an independent host and implements
the documented `--host`, `--ports`, `--until-file` and `--output` contract. A local curl loop does
not qualify. Missing probe configuration makes the drill fail before production bytes are restored.

## Scenario A — bad data in a live project

1. `node ops/restore-thrallo.mjs ~/thrallo-backups/<run>` validates without writing.
2. Prefer a manifest-bounded, owner-scoped surgical repair. A full-table restore against live
   production can overwrite newer rows and requires separate approval.

## Scenario B — the Supabase project is lost

1. Create a fresh Supabase project in the approved region and capture its URL and new keys.
2. Apply every migration in filename order.
3. Start the disposable restore target with ports 55320–55327 externally blocked and continuous
   independent probing.
4. Run `RESTORE_TARGET_URL=<url> RESTORE_TARGET_SERVICE_KEY=<key> node ops/restore-thrallo.mjs
   <backup-dir> --confirm`. The restore order is validated against the complete public FK graph;
   no constraint is disabled or weakened.
5. Verify row hashes, Auth ownership, Storage bytes, snapshots/blobs, worker data, graph,
   publishing, reservations, erasure evidence, generated columns and owner isolation.
6. Update service secret stores while preserving the original `PLATFORM_ENC_KEY`; rebuild and
   restart only required services.
7. Verify health, authentication, one deterministic agent fixture and webhook delivery. Users
   must reset passwords because logical Auth backups do not contain password credentials.

## Scenario C — the VPS is lost

1. Provision a host, install Node 22+, and check out the exact immutable deployment commit.
2. Restore environment secrets from the offline kit.
3. Install shell, worker, backup and monitoring units. Restore ingress only from its separately
   approved production configuration.
4. Restore publish, QA and worker roots into an isolated directory, validate every hash and mode,
   then promote them. Reconcile expired worker leases and publishing intents before traffic.
5. Prove the running deployment identity matches the approved manifest.

## Operational SLOs and alerts

- Shell availability: 99.5% monthly, excluding approved maintenance.
- 95% of queued builds leased within 2 minutes; alert when oldest queue age exceeds 10 minutes.
- Active worker heartbeat no older than 3 minutes.
- Publishing reconciliation backlog: zero intents older than 5 minutes.
- PostgREST read probe succeeds on every five-minute check.
- Nightly backup completed within 26 hours; isolated restore evidence no older than 31 days.
- Running deployment manifest matches the approved immutable manifest.
- Alert when backup/storage size grows by more than 25% between successive snapshots.

`thrallo-dr-health.timer` evaluates these signals and optionally sends a secret-free JSON alert to
`THRALLO_OPS_ALERT_WEBHOOK`. Failed backup/restore units remain failed so systemd monitoring sees
them. See `BUILD-WORKER-INCIDENT-RECOVERY.md`, `PUBLISHING-OPERATIONS.md`,
`PUBLISHING-ROLLBACK.md` and `DEPLOYMENT-RECONCILIATION.md` for subsystem recovery.

Install `/etc/thrallo/dr-health.env` from `ops/systemd/dr-health.env.example` with the latest
checksummed restore-evidence path and approved deployment manifest hash. These anchors are not
secrets. Keep an optional alert webhook in the operator secret store. Enable the five-minute
health timer immediately; keep the off-site and monthly-restore timers disabled until their
independent credentials/probe configuration has been supplied and tested.

## Verification cadence

- Every nightly backup validates its own manifest and data.
- `node ops/restore-thrallo.mjs <latest>` revalidates a backup without writing.
- `ops/run-latest-isolated-restore-drill.sh` runs the monthly isolated restore gate.
- After every schema change, the release pipeline runs fresh reset, lint, schema diff, catalog
  coverage and backup compatibility proofs.
- Quarterly, rehearse the four-hour RTO from a clean host or namespace and record actual timing.
