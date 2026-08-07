# Build worker incident recovery

## Worker is down or restarting

Leave the shell running. Queued work is durable and the API remains available. Check
`npm run worker:ops -- metrics`, `... list`, the node heartbeat, Docker health and
`journalctl -u thrallo-build-worker`. Restart the worker only after identifying a repeatable crash.
An interrupted lease is reclaimed after expiry; do not manually duplicate the job.
The next worker reconciliation removes labelled Docker containers only after their database lease
is no longer live. If a container remains, compare its `thrallo.durable-job-id` label with the job
row before using `docker rm -f`; never bulk-delete all Docker containers on the shared VPS.

## Stale running job

Use `npm run worker:ops -- stale`. Confirm the owning node heartbeat is also stale before acting.
Starting a healthy worker is normally sufficient: leasing records `lease_expired` and reclaims the
job when attempts remain. If the job reached its attempt ceiling, inspect its events and use the
explicit retry command only after correcting the cause.

## Cancellation does not finish

Confirm the job is `cancel_requested` and its heartbeat is advancing. The worker should terminate
the complete container/process tree and record `cancelled`. If the worker died, lease expiry
finalises the cancellation. Do not mark the row succeeded or delete its lease fields manually.

## Timeout, OOM or output limit

`error_classification` distinguishes `timeout`, `resource_limit` and `output_limit`; the exact
bounded stdout/stderr evidence is in events and the result/failure record. Treat repeated OOMs as
an input or policy defect, not a reason to remove limits. A malformed project must not trigger a
worker service restart; if it does, pause intake and preserve the queue/events for investigation.

## Database unavailable

The worker cannot acknowledge completion without the database transaction. Its lease eventually
expires and another attempt may run, so artifact creation must remain idempotent and immutable.
Restore database connectivity before resuming intake. Never infer success from a filesystem
artifact without a matching durable result row.

## Artifact mismatch or missing artifact

Pause the affected worker, retain the job/result/events, and verify that `artifact_ref` resolves
under `/var/lib/thrallo-build-worker/<job-id>`. Do not publish it. Retry only when the job type is
safe to reproduce; C8 atomic activation remains a separate remediation phase.

## Shell rollback

Set `THRALLO_BUILD_WORKER_ENABLED=0` and restart only `thrallo-shell`. Builder V1 immediately uses
its legacy path; queued worker jobs remain preserved. Drain the worker, then stop it after current
work finishes. Do not drop queue tables during incident rollback.
