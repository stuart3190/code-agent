# C7 durable worker proof

Scope: local remediation branch and a firewall-guarded disposable Supabase/Docker environment.
No production migration, service start, worker flag, model call, Stripe action or shadow change was
performed. Builder V1 remains the default and `THRALLO_MANAGED_SETTLEMENT_PAUSED=1` is unchanged.

## Database and image results

- Fresh reset: all 63 active migrations applied in order, including
  `20260806230625_durable_build_work_queue.sql`; no duplicate version or manual intervention.
- `supabase db lint --schema public --level error --fail-on error`: no schema errors.
- `supabase db diff --local --schema public`: no schema changes found.
- Disposable RPC proof: enqueue idempotency, one-winner lease race, heartbeat exclusion, expired
  lease recovery, cancellation/completion race, result-first completion, duplicate completion,
  owner isolation, concurrent tenant jobs, durable queued state and exact diagnostic events pass.
- Sandbox image: `thrallo-build-sandbox:c7-proof`, proof digest
  `sha256:998debd821a2d8296053e1e3fad14c79120c344a1b49a8dab0d7651c3f2bd917`.
- A real React/Vite scaffold compiled at exit 0. A deliberately malformed scaffold returned its
  exact `C7_EXACT_COMPILER_STDERR` and exit 23; a subsequent job succeeded.
- Inspected live limits: 384 MiB, 0.5 CPU, 64 PIDs, read-only root, network `none`,
  no-new-privileges and job-only mounts. The OOM proof exited 137 at 256 MiB. A timed job with a
  grandchild classified `timeout` and left no container/process tree.
- Sandboxes carry a durable-job label. Cancellation always issues explicit daemon cleanup, and the
  worker periodically reconciles only containers whose database job is absent, terminal or has an
  expired lease; a live lease protects another worker's container.
- Playwright launched inside the worker image against a disposable web container and persisted a
  passing load check. Cancelling Playwright against a deliberately hanging origin classified
  `cancelled` and explicitly removed the daemon-owned browser container.
- End-to-end process proof SIGKILLed `proof-e2e-first` while attempt 1 was running. After the
  15-second lease expired, `proof-e2e-second` reclaimed the same job as attempt 2, persisted its
  result and `lease_expired`/`succeeded` events, and left zero labelled containers.

## Shell responsiveness measurements

While separate slow child work ran, the same Node event loop served health, lightweight JSON and
SSE requests. Five requests were sampled per phase; the deterministic test budget is 500 ms.

| Phase | Maximum observed latency | p95 | Result |
|---|---:|---:|---|
| simulated npm install | 64.90 ms | 64.90 ms | pass |
| simulated compile | 15.04 ms | 15.04 ms | pass |
| simulated browser verification | 8.38 ms | 8.38 ms | pass |

The workload is deliberately slow, not an actual provider/model build. The real sandbox compile
and Playwright proofs above establish that those executables run in the worker image; the latency
test establishes that asynchronous child execution does not block shell HTTP/SSE handling.

The production web build and all 1,225 code-agent tests pass. The first full UI run passed 117/118;
one unrelated WebKit mocked-send assertion timed out, and its exact isolated rerun passed 1/1 with
no code change. This is recorded as a flaky first run, not rewritten as a clean single-pass matrix.

## Required proof matrix

| # | Required proof | Deterministic evidence | Result |
|---:|---|---|---|
| 1 | shell responsive during npm install | HTTP/SSE latency test, max 64.90 ms | pass |
| 2 | shell responsive during compile | HTTP/SSE latency test, max 15.04 ms | pass |
| 3 | shell responsive during browser verification | HTTP/SSE latency test, max 8.38 ms; actual isolated Playwright load | pass |
| 4 | worker crashes mid-job | lease was abandoned without callback, then expired | pass |
| 5 | another worker recovers expired lease | second attempt reclaimed the same durable job | pass |
| 6 | two workers race for one job | concurrent RPCs produced exactly one claim | pass |
| 7 | cancellation before lease | queued job became terminal and was never leased | pass |
| 8 | cancellation during install | AbortSignal killed owned process tree | pass |
| 9 | cancellation during compile | AbortSignal killed owned process tree | pass |
| 10 | cancellation during browser verification | actual Playwright cancellation removed its container; durable browser job link survives restart | pass |
| 11 | timeout kills complete child tree | unit process-group proof plus actual Docker grandchild/container removal | pass |
| 12 | memory/resource termination | actual 256 MiB cgroup OOM exit 137 and classification test | pass |
| 13 | result persisted before acknowledgement | result FK and succeeded transition observed from one RPC transaction | pass |
| 14 | duplicate completion idempotent | same completion key returned one existing result; cancellation race produced no result | pass |
| 15 | shell restart loses no queued job | queued job and payload read back from Postgres without process memory | pass |
| 16 | worker restart loses no running job | stale lease event and attempt-2 recovery | pass |
| 17 | two users cannot access workspaces | owner/FK/RLS proof, concurrent tenant leases and live job-only mount inspection | pass |
| 18 | malformed project cannot crash supervisor | exact exit 23 followed by successful worker job | pass |
| 19 | exact stdout/stderr diagnostics | durable event text and result tails verified; output cap remains bounded/redacted | pass |
| 20 | Builder V1 unchanged while disabled | default-off flag and legacy queue/scheduler regression | pass |

## Isolation limits and phase boundary

The worker host process is trusted orchestration code and currently uses the existing Docker
daemon. Customer code and browser containers do not receive its socket. Rootless Docker is the
preferred additional host hardening; Docker-group access is explicitly not described as protection
against compromise of trusted worker control code. The host service cgroup is the final cap for
Sharp and orchestration, while generated-code leaf jobs have tighter per-container limits.

C8 is not part of this proof: publishing still has its existing activation/rollback semantics.
The worker migration and service have not been deployed, so the old shadow week remains invalid
and has not been restarted.
