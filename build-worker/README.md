# Thrallo build worker

This service is the durable execution boundary for generated-app build work. It is separate from
`runtime-worker`, whose queue and trust model serve generated-app capability calls.

The worker leases one job at a time with `FOR UPDATE SKIP LOCKED`. A lease token fences heartbeat,
events, failure and completion. Completion writes `build_work_results` before the terminal state in
the same transaction. Expired leases are reclaimable; healthy heartbeats prevent a second worker
from leasing the same job.

Compile, install and browser jobs run in a disposable `thrallo-build-sandbox` container with a
read-only image, private per-job workspace, capped CPU/memory/PIDs/output, no Linux capabilities,
`no-new-privileges`, and no Supabase/provider credentials. Compile has no network. Browser jobs get
ordinary egress because they must reach the preview, while the existing request interception and
private-address checks remain active. The Node worker itself has a 3 GiB cgroup and concurrency one,
so Sharp and orchestration cannot consume shell resources.

Do not start this unit until the queue migration and sandbox image are present. See
`docs/BUILDER-WORKER-OPERATIONS.md`.
