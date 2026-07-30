# Thrallo disaster recovery

## What is backed up, where, and when

`ops/backup-thrallo.mjs` runs nightly on the VPS under `thrallo-backup.timer` (03:20 UTC,
persistent) and writes `~/thrallo-backups/thrallo-<stamp>/` containing:

- every `ca_*` control-plane table as gzipped JSON (the table list is drift-guarded by
  `test/code-agent/backup-coverage.test.mjs`, which fails when a migration adds a table the
  backup does not cover);
- `auth_users.json.gz` — Supabase auth users (identities and metadata; passwords cannot be
  exported, users reset them after a restore);
- the private `thrallo-artifacts` storage bucket, one gzipped file per object plus a
  `storage_objects.json.gz` index with original keys and content hashes;
- `manifest.json` with per-file row counts, sizes, and SHA-256 checksums.

Every run is validated immediately after writing (decode, count, checksum) and runs older
than `THRALLO_BACKUP_KEEP_DAYS` (14) are pruned. Buildr101's backups are separate and
untouched.

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
   foreign-key-safe order (automation↔run cross-links patched in a second pass), and
   re-uploads artifact objects.
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
4. The control plane lives in Supabase, so no data restore is needed — verify as in
   Scenario B step 6.

## Verification cadence

- The nightly unit validates every backup it writes; check `systemctl status
  thrallo-backup` after changes.
- `node ops/restore-thrallo.mjs <latest>` (dry run) is safe anywhere and re-validates a
  backup end to end.
- After any schema change, `npm run verify` runs the coverage drift-guard.
