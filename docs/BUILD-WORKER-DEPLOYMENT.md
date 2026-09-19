# Build worker deployment procedure

The active release's validated `shell/DEPLOYMENT.json` is the only production worker-version
authority. Shell admission and the worker process both derive the exact revision from that file;
`THRALLO_BUILD_WORKER_VERSION` is retained only as drift telemetry and cannot override the
manifest. This prevents a source activation, shell restart and worker restart from silently
advertising three different releases.

## Install without enabling traffic

```bash
cd /home/ubuntu/code-agent
git fetch --all --prune
git checkout <approved-immutable-commit>
npm ci
npm run worker:sandbox:build

sudo groupadd --system thrallo 2>/dev/null || true
sudo useradd --system --gid thrallo --home-dir /var/lib/thrallo-build-worker-home \
  --shell /usr/sbin/nologin thrallo-build-worker 2>/dev/null || true
sudo usermod -aG docker thrallo-build-worker
sudo install -d -o thrallo-build-worker -g thrallo -m 0700 /var/lib/thrallo-build-worker-home
sudo install -d -o thrallo-build-worker -g thrallo -m 0750 /var/lib/thrallo-build-worker
sudo install -d -o root -g thrallo -m 0750 /etc/thrallo
sudo install -o root -g root -m 0644 build-worker/thrallo-build-worker.service \
  /etc/systemd/system/thrallo-build-worker.service
sudo systemctl daemon-reload
```

The account home and durable artifact root are deliberately different. The private home is
`/var/lib/thrallo-build-worker-home`; `/var/lib/thrallo-build-worker` contains only canonical
Thrallo job artifacts selected by the backup. Never use the artifact root as a login/service
home, and never put package-manager caches, OS skeleton files, or temporary workspaces beneath it.

Create `/etc/thrallo/build-worker.env` mode `0640`, root:thrallo, from the production secret store.
It needs the existing Supabase server configuration plus:

```dotenv
THRALLO_PROCESS_ROLE=build-worker
THRALLO_BUILD_SANDBOX=docker
THRALLO_BUILD_SANDBOX_IMAGE=thrallo-build-sandbox:latest
THRALLO_BUILD_ARTIFACT_ROOT=/var/lib/thrallo-build-worker
THRALLO_BUILD_LEASE_SECONDS=45
THRALLO_BUILD_POLL_MS=1000
THRALLO_MANAGED_SETTLEMENT_PAUSED=1
```

Do not hand-edit a worker revision into this file. Pinning must read the deployed manifest and
reject any conflicting `--commit`:

```bash
sudo node ops/pin-build-sandbox-image.mjs \
  --manifest shell/DEPLOYMENT.json --image-commit <image-source-sha> \
  --tag <immutable-built-tag> --pin
```

Any worker allowed to execute `builder_pipeline` also requires `SUPABASE_URL` and exactly one
public browser credential (`SUPABASE_PUBLISHABLE_KEY`, preferred, or the legacy
`SUPABASE_ANON_KEY`). These values come from the same private configuration authority as the shell.
The worker performs a disposable generated-runtime read/write smoke before the first model dispatch
for each `builder_pipeline` job. Missing or invalid public configuration fails with a machine-readable
`runtime_public_config_*`/`runtime_backend_preflight_*` error before spend. Never place a
`SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_SERVICE_ROLE`, or `sb_secret_...` value in either public-key
field; the materialized preview `.env` contains only browser-safe values and `VITE_APP_ID`.

Do not put provider or production credentials in the image. Apply only
`20260806230625_durable_build_work_queue.sql` through the approved Supabase migration workflow;
verify the remote ledger and catalog afterward. Keep `THRALLO_BUILD_WORKER_ENABLED=0` in the shell.

## Start dark and prove

```bash
sudo systemctl start thrallo-build-worker
sudo systemctl status thrallo-build-worker --no-pager
npm run worker:ops -- metrics
npm run worker:ops -- list
journalctl -u thrallo-build-worker -n 100 --no-pager
npm run worker:release:verify
```

Startup first publishes the worker as pipeline-unready, runs the disposable isolation proof, and
only then advertises `builder_pipeline`. The worker refreshes that proof every four minutes with
bounded jitter, retries failed refreshes after 30 seconds, and atomically republishes readiness in
its worker heartbeat. `worker:release:verify` is the required zero-model post-restart gate.

With no shell dispatch flag, the worker should heartbeat with zero customer jobs. Run only the
approved synthetic, zero-model proof job. Confirm queue/result/events, resource limits, artifact
permissions and API health. Do not run a model-powered build.

## Enable the worker path

After dark proof approval, set `THRALLO_BUILD_WORKER_ENABLED=1` in the shell environment and
restart only `thrallo-shell`. Verify health, normal API latency, SSE, enqueue/status/cancel and one
approved zero-model compile fixture. The worker must already be healthy before the shell flag is
enabled. Builder V1 remains the selected composition; only its execution boundary changes.

## Rollback

Set `THRALLO_BUILD_WORKER_ENABLED=0`, restart `thrallo-shell`, drain the worker and then stop the
unit. Preserve queue/results/events and artifacts for reconciliation. The additive migration can
remain installed. Its documented destructive SQL rollback is for a separately approved forward
repair window only and must not run while any job or `build_jobs.work_job_id` reference exists.
