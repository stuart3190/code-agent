# Build worker operations

The build worker is an opt-in execution boundary for expensive generated-application work. The
customer-facing `build_jobs` row remains the Builder V1 lifecycle record; `work_job_id` points at
the current durable execution job. `THRALLO_BUILD_WORKER_ENABLED` defaults off, so deploying code
or the migration alone does not change Builder V1 behavior.

## Queue and lease semantics

- Enqueue stores a bounded payload and job in one transaction. The idempotency key includes owner,
  project, build, job type and payload identity.
- A worker uses `build_work_lease` to claim one eligible job with `FOR UPDATE SKIP LOCKED`. A claim
  has a random lease token; every start, heartbeat, event, failure and completion must present it.
- The default lease is 45 seconds and heartbeats run every 15 seconds. A healthy heartbeat extends
  the lease. A stale lease becomes `expired`, or terminal `failed` after its last attempt, and can
  be reclaimed without shell intervention.
- Every sandbox carries its durable job ID as a Docker label. Cancellation/timeout explicitly
  removes the daemon-owned container; every worker also reconciles labelled containers every 30
  seconds and removes only those whose durable lease is expired, terminal or absent.
- Completion writes `build_work_results` before moving the job to `succeeded` in the same database
  transaction. Repeating the same completion key is idempotent; a conflicting completion fails.
- Cancellation before lease is immediately terminal. Cancellation after lease changes the job to
  `cancel_requested`; heartbeat aborts the owned process tree and the worker records `cancelled`.
  A completion racing a cancellation is rejected and cannot create a result.
- Events are append-only and bounded. Stdout/stderr is redacted before persistence, and accepted
  events are flushed before completion acknowledgement.
- Leaf jobs may retry automatically within their recorded ceiling. `builder_pipeline` has one
  automatic attempt because replaying a model pipeline after an unknown crash point can duplicate
  provider spend. Its durable failure is surfaced to `build_jobs`; `worker:ops retry` is the
  explicit operator action that raises the ceiling by one after evidence review.

## Resource boundary

The host worker runs one job at a time under `thrallo-build-worker.service` (`MemoryMax=3G`, no
swap, `CPUQuota=250%`, `TasksMax=512`, control-group termination). Generated-app compile,
dependency, publish and browser work runs in a fresh Docker container with a read-only root,
dropped capabilities, no-new-privileges, PIDs/memory/CPU/output/time limits and only that job's
workspace mounted. Compile and publish containers have no network. Browser containers retain
only the network they require. Android's existing Docker builder has equivalent memory/CPU/PID
caps. The worker strips platform and provider credentials from generated-code child environments.

The worker control process needs access to the existing Docker daemon. Customer code never sees
the socket, but compromise of the trusted worker control process would inherit Docker-group power.
Use a rootless dedicated Docker daemon when the VPS supports it; until then this is an explicit
host-hardening limitation, not a claim of container-as-a-security-boundary against trusted worker
code. Sharp executes in the worker service cgroup with one-job concurrency; its hardened fetch,
decode, pixel and size limits remain active.

## Filesystem invariant

The service account home is `/var/lib/thrallo-build-worker-home` (private, mode `0700`). The
canonical durable artifact root is `/var/lib/thrallo-build-worker` (mode `0750`) and contains only
Thrallo-owned job result/artifact data. These paths must never overlap. Docker `/tmp` tmpfs state,
job workspaces removed on terminal completion, caches, and OS account skeleton files are
non-durable and must not enter the artifact root. The backup intentionally fails on every symlink
or non-regular entry beneath a canonical filesystem root; do not add filename exceptions.

Production was repaired to this layout on 2026-08-07. The inherited `/etc/skel` files were first
matched byte-for-byte, moved into the new private home without following `.face.icon`, and the
empty canonical root then passed a full backup and isolated restore. Any future account recreation
must preserve this split before the worker is started.

## Operator commands

Run these from the checked-out release with the worker environment loaded:

```bash
npm run worker:ops -- list
npm run worker:ops -- metrics
npm run worker:ops -- stale
npm run worker:ops -- cancel <job-id>
npm run worker:ops -- retry <job-id>
npm run worker:ops -- pause <worker-id>
npm run worker:ops -- drain <worker-id>
npm run worker:ops -- resume <worker-id>
```

`pause` stops new leases after the current database command. `drain` lets the current job finish
and takes no new work. SIGTERM requests cancellation of the current child tree, persists failure
or cancellation when the lease remains valid, then exits. Never delete a running job to stop it.

Queue health comes from `build_work_queue_metrics`, `build_worker_nodes` and
`build_work_events`. Alert on oldest queued age, any expired lease, a node heartbeat older than
two lease periods, retry growth, resource/timeout terminations and a non-zero failed-job rate.
Adding capacity means starting another identical worker with a unique worker ID; lease ownership
is database-atomic and no sticky routing is required.
