# Builder V2 graph shadow runbook

Builder V1 remains the production build path throughout shadowing. Shadow indexing runs after a
completed V1 build, is feature-flagged by `bv2.shadow`, and catches every failure so it cannot
change the V1 result. A clean shadow result is evidence about the persisted Builder V2 graph; it
is not permission to route customer builds to Builder V2.

## Why the 2026-08-06 shadow period is invalid

The original writer inserted a revision, then issued separate PostgREST writes for every symbol,
reference set and dependency-edge set. It skipped a retry as soon as the parent revision existed.
The daily drift job compared only some path hashes, ignored missing/extra rows and treated a moved
tree as non-drift. Therefore that period could report clean while the persisted graph was partial.
It remains diagnostic history and must never count toward rollout criteria.

## What one clean run proves

`bv2_persist_file_revision` writes one revision and all children in a single transaction. A shadow
run pins the exact ready revision for every path, then reloads it through `bv2_load_graph`. CLEAN
requires equality of the complete path manifest, revision/content hashes, opaque flags, symbol
identity and metadata, exact spans/block hashes, references/resolved paths, dependency edges,
`callersOf`, `importsOf`, `importersOf`, and module/entity ownership answers. Pending revisions,
missing or extra paths/rows, integrity-count/hash failures and stale runs are blocking drift.

Every check is append-only in `bv2_shadow_checks`; `bv2_shadow_runs.status` is the latest result.
Evidence includes owner, project, build, run, exact mismatch kind/path and expected/actual values.
The operations command exits non-zero when any project in shadow state is missing, stale or
different:

```text
node ops/bv2-shadow-drift.mjs
```

`BV2_SHADOW_MAX_AGE_HOURS` defaults to 36. A daily timer must run more frequently than that.

## Operator response to drift

1. Do not change Builder V1 routing, V2 allowlists, settlement pause or the shadow start timestamp.
2. Capture the complete JSON line from `bv2-shadow-drift`; identify owner/project/build/run/path.
3. Inspect `bv2_shadow_runs`, `bv2_shadow_run_files` and the newest `bv2_shadow_checks` using a
   service-only operator path. Browser roles have neither table nor RPC access.
4. Classify the mismatch as source-tree movement, parser change, persistence integrity failure,
   stale/missing build, or an operational outage. No class is downgraded to a warning.
5. Repair and deploy through a new reviewed migration/code change. Re-run the disposable reset,
   atomic fault proof and stored-production-fixture parity proof.
6. Restart the seven-day clock from zero after the repair is deployed and a new production run is
   CLEAN. Preserve failed checks as evidence.

## Exact restart criteria

The seven-day shadow week may restart only after all of the following are recorded:

- `20260806210321` and `20260806221153` have explicit approval, a production upgrade dry-run and
  rollback/forward-repair review, then are applied in order without ledger repair.
- The matching application commit is deployed while Builder V1 remains the default and V2
  customer flags remain off.
- `THRALLO_MANAGED_SETTLEMENT_PAUSED=1` and the V2 kill/rollout controls are re-read as safe.
- A post-migration backup includes all three shadow tables and the new graph columns; isolated
  restore verifies revision counts, ownership and shadow links.
- One real completed V1 build produces a new `bv2_shadow_runs` row and an immediate CLEAN check.
- The daily timer invokes the complete drift command, non-zero exits alert, and the default stale
  threshold is compatible with the timer cadence.
- The official restart timestamp is written only after those proofs. The old timestamp is not
  reused.

Rollback does not rebuild or mutate Builder V1. Stop the shadow timer/call site, deploy the prior
application artifact, and prefer forward-repairing quarantined graph revisions. Drop new RPCs and
tables only if no newer code or retained evidence references them; do not edit migration history.

