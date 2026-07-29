# DEPLOY — Buildr101 production (buildr101.com)

**Deployed 2026-07-06.** The shell runs ON the VPS (OVH, `ubuntu@51.195.136.189`) next to
provisiond; Caddy fronts everything. Local (the EPYC box) is now the DEV environment only.

## Topology

```
browser ──https──▶ Caddy (docker, binds 10.83.7.2; certs via Cloudflare DNS-01)
   buildr101.com           ──reverse_proxy──▶ shell server  10.83.7.1:8787  (systemd buildr-shell)
   www.buildr101.com       ──301──▶ apex          │  serves web dist + /api (SSE flush -1)
   *.preview.buildr101.com ──▶ preview containers │  PROVISIOND_URL=127.0.0.1:8790 (no tunnel)
   *.app.buildr101.com     ──▶ /publish/<label>   ▼
                                          provisiond 127.0.0.1:8790 (systemd buildr-provisiond)
```

- Shell binds ONLY `10.83.7.1` (docker proxy-net gateway): Caddy reaches it, the internet cannot
  (public :8787 verified unreachable). `SHELL_HOST` env controls this; unset locally = old behavior.
- systemd: `buildr-shell` + `buildr-provisiond`, `Restart=always`, enabled at boot. The
  setsid/pidfile era is over — manage with `sudo systemctl restart|status buildr-shell`.
- `buildr-runtime-worker` (systemd) runs the immutable `buildr-runtime-worker:latest` Docker image
  for generated-app capability jobs. Its private env is `/etc/buildr/runtime-worker.env`.
- Engine (Codex lane) runs on the VPS: `~/.codex/auth.json` + `config.toml` copied from the EPYC
  box 2026-07-06. If Codex auth expires, re-login locally and re-copy those two files.
- Stripe: PRODUCTION webhook `we_1TqIZvC6PoSrpLpG4HMGQBvD` → https://buildr101.com/api/stripe/webhook
  (invoice.paid, checkout.session.completed, customer.subscription.deleted); its whsec_ lives in the
  VPS `~/app-builder/shell/.env`. The local `stripe listen` forwarder is only needed for LOCAL dev.
- DNS (Cloudflare, all DNS-only/grey): apex A + www CNAME → VPS (parked GoDaddy records deleted
  2026-07-06); wildcards *.preview / *.app unchanged.

## Updating production (after committing locally)

```sh
# from the EPYC repo root — ship the tree (excludes caches/secrets), then restart services
cd /c/Users/Administrator/app-builder
cd shell/web && npm run build && cd ../..          # fresh web dist rides the tarball
# ⚠ the tar below MUST run from the repo root — a tarball made from shell/web deploys garbage
tar czf /tmp/deploy.tgz --exclude=node_modules --exclude=.git --exclude="harness/.deps" \
  --exclude="harness/.work" --exclude="shell/.env" --exclude="shell/web/.env" \
  --exclude=".stripe-listen*" --exclude=".shell-server*" --exclude=".web-dev*" --exclude=supabase .
scp -i ~/.ssh/id_ed25519 /tmp/deploy.tgz ubuntu@51.195.136.189:/tmp/
ssh -i ~/.ssh/id_ed25519 ubuntu@51.195.136.189 \
  'tar xzf /tmp/deploy.tgz -C ~/app-builder && rm /tmp/deploy.tgz && \
   cd ~/app-builder && npm install --no-audit --no-fund && \
   docker build -t buildr-runtime-worker:latest -f runtime-worker/Dockerfile . && \
   sudo systemctl restart buildr-shell buildr-runtime-worker'
```

- `~/app-builder/shell/.env` on the VPS is authoritative for prod secrets (tar never touches it).
  It differs from local: `PROVISIOND_URL=http://127.0.0.1:8790`, `SHELL_HOST=10.83.7.1`, prod
  `STRIPE_WEBHOOK_SECRET`. Any .env edit → `sudo systemctl restart buildr-shell`.
- The runtime worker is built from the deployed tree, not bind-mounted. Rebuild its image whenever
  `runtime-worker/`, `src/`, or worker-imported `shell/server/` code changes; a service restart by
  itself keeps the old code. Normal app-builder deploys restart `buildr-shell` and
  `buildr-runtime-worker`, NOT `buildr-provisiond`.
- Meta publishing uses `META_APP_ID` and `META_APP_SECRET` in BOTH `~/app-builder/shell/.env`
  (OAuth) and `/etc/buildr/runtime-worker.env` (Graph calls/app-secret proof). Keep both files mode
  600. After rotating the Meta secret, update both and restart shell + runtime worker. OAuth redirect
  URIs are `https://buildr101.com/api/connectors/oauth/meta/callback` and
  `https://buildr101.com/api/runtime/connectors/meta/callback`.
- If scaffold `package.json` changed: also delete `~/app-builder/harness/.deps` on the VPS (it
  reinstalls on next build) and rebuild the preview base image (`~/provisiond/base`, docker build).
- provisiond code changes: the tarball updates `~/app-builder/provisiond/` but the SERVICE runs
  from `~/provisiond/` — copy changed files there too, then restart buildr-provisiond.

## Backups (installed 2026-07-07)

`buildr-backup.timer` (systemd, daily 04:17 UTC, `Persistent=true`) runs
`node scripts/backup-supabase.mjs` from `~/app-builder`: gzipped-JSON export of every platform
table + auth users via the service role (creds from shell/.env) into `~/backups/supabase-<stamp>/`,
pruning runs older than 14 days (`BACKUP_DIR`/`BACKUP_KEEP_DAYS` override). Check:
`systemctl list-timers buildr-backup.timer` · `journalctl -u buildr-backup.service -n 20`.
Restore = re-insert rows with the service role (see the script header); this is loss protection,
not point-in-time recovery — that would be Supabase Pro.

## Android builder image (installed 2026-07-17)

The "Download Android app" feature (`POST /api/android`) runs the whole TWA build inside the
`buildr-android:latest` Docker image (JDK17 + Android SDK 34 + Bubblewrap, gradle primed). Build
it ONCE on the VPS, and rebuild only when `android/Dockerfile` or `android/build.sh` change:

```sh
# from the repo root on the VPS (or scp android/ up first)
docker build -t buildr-android:latest ~/app-builder/android
```

~2.2GB, ~5-8 min (the prime step compiles a throwaway TWA against
`https://buildr101.com/android-prime.webmanifest` to warm the gradle cache — that file must be
live). The shell runs `docker run --rm -v <tmp>:/work buildr-android:latest` per export; the
`ubuntu` shell user is already in the docker group (same as the alpine-chrome renderer). Health:
`docker images buildr-android` · a green `node shell/harness/prove-android.mjs` (opt-in, live).
NOTE: the deploy tar EXCLUDES `android/` (the image is built/owned on the VPS, not shipped in the
tarball) — re-scp `android/` when its files change.

## Codex OAuth keep-alive (installed 2026-07-16)

`buildr-codex-keepalive.timer` (systemd, daily 03:47 UTC, `Persistent=true`) runs
`node scripts/codex-keepalive.mjs` from `~/app-builder`: one forced token refresh, with the
ROTATED refresh token persisted back to `~/.codex/auth.json` (src/providers/auth.mjs does this on
every refresh now — the old in-memory-only refresh discarded rotations, so the original login's
refresh token aged out after an idle week → HTTP 401 → manual `codex login`, 2026-07-15).
Check: `journalctl -u buildr-codex-keepalive.service -n 5`.
**The VPS owns the token chain.** If the local box needs fresh creds, PULL them
(`scp ubuntu@51.195.136.189:.codex/auth.json ~/.codex/auth.json`) — don't run a stale local copy
hard, and only push local→VPS after a fresh `codex login` (which starts a new chain anyway).
If the keep-alive ever fails repeatedly: `codex login` locally, copy auth.json to the VPS, done.

## Local dev (unchanged, now optional)

`shell && node server/index.mjs` (:8787) + `shell/web && npm run dev` (:5173) + `stripe listen`
when testing billing. The SSH tunnel is only needed if local dev should use VPS previews.
Local and prod share the same Supabase project + Stripe test account.

## Manual steps still pending

- Supabase **Site URL** → `https://buildr101.com` (+ add to Redirect URLs) — Auth → URL
  Configuration. Until then, password-reset links point at localhost.
- Stripe business name "Zataus" → Buildr101 (dashboard).
