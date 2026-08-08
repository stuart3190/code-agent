# Thrallo disaster recovery

## What is backed up, where, and when

`ops/backup-thrallo.mjs` runs nightly on the VPS under `thrallo-backup.timer` (03:20 UTC,
persistent) and writes `~/thrallo-backups/thrallo-<stamp>/` containing:

- every migrated Thrallo application table as gzipped JSON, including `bv2_model_reservations`
  and all `bv2_*` graph, snapshot, cache, asset, diagnostic, ownership, and feature-flag tables.
  Before it reads production rows, the backup compares its manifest with the live
  `thrallo_public_tables()` catalog and aborts on either an omitted or unknown canonical table;
- `auth_users.json.gz` — Supabase auth UUIDs, email addresses, and application/user metadata.
  Password hashes, OAuth identities, MFA factors, and sessions are not exported by this logical
  backup, so users re-establish credentials after a restore;
- the private `thrallo-artifacts` storage bucket, one gzipped file per object plus a
  `storage_objects.json.gz` index with original keys, content types, and content hashes;
- current publish, QA and durable build-worker filesystem artifacts, stored by logical root with
  file and directory paths, modes, sizes,
  and content hashes. VPS previews are deliberately not backed up: they are ephemeral containers
  re-materialised from canonical project/snapshot data;
- authoritative production migration-ledger evidence plus the active local/applied-state map;
- `manifest.json` with per-file row counts, sizes, and SHA-256 checksums. Validation covers every
  compressed dataset and every underlying storage/filesystem object, not only index files.

Every run is validated immediately after writing (decode, count, checksum) and runs older
than `THRALLO_BACKUP_KEEP_DAYS` (14) are pruned. Buildr101's backups are separate and
untouched.

The 60-row reconstructed authoritative history is immutable. Later production applications are
captured as dated, read-only ledger overlays containing the remote statement hash and the local
applied-file hash. A backup merges them, requires contiguous applied order, and refuses a local
file whose recorded applied identity changes. The current evidence is exactly 67 rows; backup
creation fails if that count or the active/pending state differs.

`bv2_builds.project_id_text` and `diag_runs.project_id_text` are stored generated columns. They
are not authoritative backup fields and are never included in restore writes. PostgreSQL
regenerates them from `project_id`; the isolated verifier checks every regenerated value and
canonicalises those two columns before comparing source and restored row hashes.

The worker account home (`/var/lib/thrallo-build-worker-home`) is not backup input. Only the
canonical artifact root (`/var/lib/thrallo-build-worker`) is included. Their separation is a
recovery invariant: OS skeleton entries and caches must not contaminate durable data, while any
unexpected symlink inside the canonical root must still abort the backup.

## The disaster-recovery kit — keep these OFF the VPS

1. **`shell/.env`** — above all `PLATFORM_ENC_KEY`. Every AI credential, repository source
   excerpt, symbol, and evaluation is AES-256-GCM encrypted with it. A backup without this
   key restores rows whose sensitive columns are permanently unreadable. Also contains the
   GitHub App private key, Daytona and OpenAI keys, and the Supabase secret.
2. A recent `thrallo-<stamp>/` backup directory, copied off-host periodically.

## Scenario A — bad data in the live project (rows deleted or corrupted)

1. `node ops/restore-thrallo.mjs ~/thrallo-backups/<run>` — dry-run prints validated counts.
2. Surgical repair is preferred: extract the affected table's `.json.gz`, re-insert the
   needed rows with the service role (`upsert` on the primary key). A full-table upsert of
   every table against the LIVE project is possible with
   `RESTORE_TARGET_URL`/`RESTORE_TARGET_SERVICE_KEY` + `--confirm`, but it overwrites newer
   rows — prefer the surgical path.

## Scenario B — the Supabase project is lost

1. Create a fresh Supabase project (same region), note its URL, service key, anon key.
2. Apply every migration in `supabase/migrations/` in filename order (this also recreates
   the `thrallo-artifacts` bucket and all RLS lockdowns).
3. `RESTORE_TARGET_URL=<new url> RESTORE_TARGET_SERVICE_KEY=<new service key> \
   node ops/restore-thrallo.mjs <backup-dir> --confirm`
   — recreates auth users (original UUIDs, no passwords), restores tables in
   foreign-key-safe order. The order is checked against the complete 83-pair public FK graph from
   the 67-migration production catalog. Nullable cyclic/forward links are withheld only for the
   initial insert and patched after every parent exists; no FK is disabled or weakened. The restore
   then re-uploads artifact objects, and restores filesystem artifacts only beneath the explicit
   `RESTORE_TARGET_FILESYSTEM_ROOT` isolated namespace.
   Durable work restores in payload -> job -> result/event/node order after projects and customer
   `build_jobs`. `build_jobs.work_job_id` is a trace link rather than a reverse foreign key, which
   avoids a restore cycle; `build_work_jobs.build_id` remains the authoritative FK. A restored
   in-flight lease is allowed to expire and be reclaimed rather than being reported as successful
   from filesystem state alone.
   Model reservations restore after projects and V2 builds; the verifier checks reservation
   owner/project/build identity, terminal state, provider/model/billing lane, usage evidence,
   public-build runtime links, diagnostics links, and green-snapshot links.
4. Update `shell/.env` on the VPS: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`; update
   `shell/web/.env` with the new URL and publishable key; **keep the original
   `PLATFORM_ENC_KEY`**. Rebuild the web app and restart `thrallo-shell`.
5. Supabase Auth → URL configuration: set Site URL and redirect to
   `https://app.thrallo.com`.
6. Verify: `/api/health`, `/api/v1/capabilities`, sign-in, one full agent run, and one
   GitHub webhook redelivery from the App's Advanced tab.
7. Tell users to reset passwords (restored accounts have none).

## Scenario C — the VPS is lost

1. Provision a host, install Node 22+, clone the repository at the last deployed main
   commit, `npm ci` and build `shell/web`.
2. Restore `shell/.env` and `shell/web/.env` from the offline kit.
3. Install `ops/thrallo-shell.service`, `ops/thrallo-backup.service`, and
   `ops/thrallo-backup.timer`; reuse `ops/Caddyfile.thrallo` in the front proxy; point DNS
   at the new host.
4. Restore the backed-up `publish` and `qa` roots into an isolated directory, validate their
   manifest hashes, then promote the recovered publish tree into the configured `PUBLISH_DIR`.
   Preview containers are recreated on demand. Verify as in Scenario B step 6.

## Verification cadence

- The nightly unit validates every backup it writes; check `systemctl status
  thrallo-backup` after changes.
- `node ops/restore-thrallo.mjs <latest>` (dry run) is safe anywhere and re-validates a
  backup end to end.
- After any schema change, `npm run verify` runs the coverage drift-guard.
