# Publishing operations

The C8 path is not deployed or enabled by this branch. All commands below require an approved
commit, a current validated backup, the reviewed migration, and explicit production approval.

## Inspect and control

```bash
npm run publish:ops -- list --project <project-id>
npm run publish:ops -- state
npm run publish:ops -- stuck
npm run publish:ops -- integrity --owner <owner-id> --release <release-id>
npm run publish:ops -- pause
npm run publish:ops -- drain
npm run publish:ops -- resume
npm run publish:ops -- retention
```

`pause` creates the configured `THRALLO_PUBLISHER_PAUSE_FILE` (default
`~/thrallo-state/publisher.paused`). Both legacy and atomic publish intake refuse while it exists;
unpublish and reconciliation remain available. `drain` leases/reconciles until no due intent
remains. Never delete an intent to clear it.

## Dark deployment and existing-site cutover

1. Validate a new complete backup and isolated restore. Record DB/filesystem counts and hashes.
2. Apply pending additive migrations in reviewed order, ending with
   `20260807072455_atomic_immutable_releases.sql`. Verify the remote ledger and catalog.
3. Deploy the approved code. Keep shell `THRALLO_ATOMIC_PUBLISH_ENABLED=0` and
   `THRALLO_BUILD_WORKER_ENABLED=0`. Do not reload Caddy yet.
4. Pause publish intake and prove a normal publish returns `publisher_paused`. Reconciliation and
   unpublish remain available.
5. Set `THRALLO_ATOMIC_PUBLISH_ENABLED=1` only for provisiond and restart provisiond. Its new
   endpoints are now dark; customer publishing still uses Builder V1's old path. Domain binding
   chooses the legacy target until each site's verified pointer exists.
6. For every live `published_sites` row run, with a one-command override only:

   ```bash
   THRALLO_ATOMIC_PUBLISH_ENABLED=1 npm run publish:ops -- adopt-legacy \
     --owner <owner-id> --project <project-id>
   ```

7. Prove every live site has an active release, a current pointer, matching bytes, and no unfinished
   intent. Prove every Thrallo/custom hostname returns the same content hash as before adoption.
8. Validate and reload the reviewed `ops/Caddyfile.unified`. Existing content is byte-identical.
9. Obtain separate approval to enable the already-deployed C7 worker, start
   `thrallo-build-worker`, set shell `THRALLO_BUILD_WORKER_ENABLED=1`, and prove one isolated
   zero-model packaging job. Atomic publishing fails closed before build work while this flag is
   off.
10. Set shell `THRALLO_ATOMIC_PUBLISH_ENABLED=1`, restart only `thrallo-shell`, run one approved
   zero-model synthetic publish/rollback/unpublish proof, then resume intake.

Do not combine steps 4-10 or leave intake open between Caddy cutover and the shell flag. Keep Builder
V2 and managed settlement paused throughout. The C7 worker remains off during this implementation
phase and may be enabled only by the separate approval in step 8.

## Scaling

Multiple shell reconcilers are safe: Postgres uses `FOR UPDATE SKIP LOCKED` leases. A single
provisiond currently owns one publish filesystem and uses per-site atomic lock directories with
stale-lock recovery. Additional provisiond instances require shared storage with equivalent atomic
rename and locking semantics; do not place the release root on storage that lacks them.
