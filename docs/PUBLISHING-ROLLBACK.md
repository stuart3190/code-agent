# Published-site rollback

Rollback selects an eligible retained `publish_releases.id`, verifies every stored byte against its
manifest, creates an activation intent with the site's current CAS version, and switches the stable
pointer. A new deployment row records the rollback event; the target release itself is not copied or
rebuilt. The deterministic filesystem proof completed the switch/verification in 11 ms on the VPS;
the production target remains seconds including database/network health checks.

```bash
npm run publish:ops -- integrity --owner <owner-id> --release <release-id>
npm run publish:ops -- rollback --owner <owner-id> --project <current-project-id> \
  --release <release-id> --deployment <rollback-deployment-id>
```

If health or integrity fails, do not force the pointer. Preserve the failed release and diagnostics.
If the pointer switched but DB completion failed, run reconciliation; do not start another publish.

## Platform rollback

Before any Caddy cutover or atomic activation, disabling the shell flag returns to Builder V1 with
no customer effect. After the first atomic activation, destructive migration rollback is forbidden:
the current pointers and outbox are canonical. Roll forward by deploying the last known-good C8
commit and reconciling. Returning Caddy to legacy directories would silently serve stale baseline
bytes and is not an acceptable rollback.

The migration may be dropped only when the flag is off and all sites have null
`active_publish_release_id` and no intent/release rows. Otherwise use the migration's forward-repair
procedure. This is the explicit reversibility boundary, not a best-effort promise.
