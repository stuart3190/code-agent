# Deployment reconciliation

Inspect first:

```bash
npm run publish:ops -- state
npm run publish:ops -- integrity --owner <owner-id> --release <release-id>
```

| Observed state | Response |
| --- | --- |
| `prepared`, pointer still previous | Reconciler validates desired artifact, switches pointer, records observation, completes DB. |
| `prepared`, pointer already desired | Record the existing observation and complete; do not switch again. |
| `pointer_switched`, pointer desired | Retry only `complete_publish_activation`. |
| DB CAS stale after desired switch | Re-activate the DB's retained previous release, then mark the intent `rolled_back`. |
| Desired artifact missing/corrupt before switch | Leave current pointer alone, retain evidence, retry only after restoring the exact bytes. |
| Desired artifact fails the post-switch proof | Atomically restore the verified prior release (or remove a first-release pointer), mark the intent rolled back, and retain the bad artifact/evidence. |
| `retrying` | Wait until `next_attempt_at` or run approved reconciliation. Exponential delay is capped at five minutes. |
| `stuck` | Pause intake, inspect pointer/DB/release hashes, choose complete or retained-release rollback, and record the incident. Never delete the row. |

Run one batch or drain all due work:

```bash
npm run publish:ops -- reconcile --limit 10
npm run publish:ops -- drain
```

Alerts should fire for an intent older than five minutes, a lease older than its expiry, any
`stuck` row, an active release whose pointer differs, or an integrity mismatch. The reconciler's
automatic retry limit is eight. Reconciliation never rebuilds an artifact.
