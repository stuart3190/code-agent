# Builder V2 graph shadow runbook

Builder V1 remains the production build path until the separately approved V2 cutover. Shadow indexing runs after a
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

The authoritative boundary is `bv2_feature_flags['bv2.shadow.window'].value.startedAt`. The daily
checker ignores runs and migration-state rows older than that boundary. It also queries completed
V1 `build_jobs` since the boundary: after the ten-minute completion grace, a build with no new
shadow state is `missing_shadow_for_completed_build` and blocks the day. This prevents a failed
shadow callback from disappearing before it creates its first graph row.

Every invocation appends one `daily_shadow_summary` JSON record containing projects expected and
checked, CLEAN/drift/missing/stale/parity counts, deferred builds, indexer and validator versions,
duration and errors. Per-project checks remain append-only in `bv2_shadow_checks`; a completely
missing callback is retained in the systemd append log because no project shadow row exists to own
a database check yet. `BV2_SHADOW_MAX_AGE_HOURS` defaults to 36,
`BV2_SHADOW_COMPLETION_GRACE_MINUTES` to 10 and `BV2_SHADOW_CLOCK_SKEW_SECONDS` to 60. The daily
timer must run more frequently than the stale threshold.

## Diagnostic status (not a release clock)

The 2026-08-07 window and every prior window are retained as operational evidence. Under the
V2-only launch strategy, seven elapsed days, V1 traffic volume and a completed window are not launch
requirements. Deterministic qualification and the controlled V2 production canary in
`BUILDER-V2-V2-ONLY-CUTOVER.md` supersede those calendar gates. Continue running this timer because
missing, stale or drifting graph state is still an operational defect.

## Preserved historical observation window

- Authoritative start: `2026-08-07T20:51:22.594832Z` (the JSON boundary is millisecond-normalised
  to `2026-08-07T20:51:22.594Z`).
- Historical seven-day target: `2026-08-14T20:51:22.594832Z`; this is not a launch gate.
- Timer: `bv2-drift.timer`, daily at `09:00:00 UTC`, persistent across downtime.
- First scheduled check: `2026-08-08T09:00:00Z`.
- The 2026-08-06 boundary is retained in `previousWindows` with status
  `invalid_pre_remediation`; no old run can satisfy this window.
- No natural V1 build had completed after the new boundary at restart time. Operators must not
  manufacture a model-powered build for historical evidence. Controlled V2 fixtures now provide
  release qualification; natural V1 shadow data remains useful only for diagnostics.

## Operator response to drift

1. Do not change Builder V1 routing, V2 allowlists, settlement pause or the shadow start timestamp.
2. Capture the complete JSON line from `bv2-shadow-drift`; identify owner/project/build/run/path.
3. Inspect `bv2_shadow_runs`, `bv2_shadow_run_files` and the newest `bv2_shadow_checks` using a
   service-only operator path. Browser roles have neither table nor RPC access.
4. Classify the mismatch as source-tree movement, parser change, persistence integrity failure,
   stale/missing build, or an operational outage. No class is downgraded to a warning.
5. Repair and deploy through a new reviewed migration/code change. Re-run the disposable reset,
   atomic fault proof and stored-production-fixture parity proof.
6. Preserve failed checks as evidence and open an operational defect when graph trust fails. There
   is no release clock to reset. Customer-app defects are separate unless they expose an indexing,
   persistence or validation defect.

## Timer recovery criteria

If the diagnostic timer is stopped or its boundary is deliberately replaced, restore it only after:

- `20260806210321` and `20260806221153` have explicit approval, a production upgrade dry-run and
  rollback/forward-repair review, then are applied in order without ledger repair.
- The matching application commit is deployed while Builder V1 remains the default and V2
  customer flags remain off.
- `THRALLO_MANAGED_SETTLEMENT_PAUSED=1` and the V2 kill/rollout controls are re-read as safe.
- A post-migration backup includes all three shadow tables and the new graph columns; isolated
  restore verifies revision counts, ownership and shadow links.
- A controlled, owner-isolated graph fixture produces a CLEAN run and an injected mismatch exits
  non-zero. Natural V1 traffic is neither required nor a release gate.
- The daily timer invokes the complete drift command, non-zero exits alert, and the default stale
  threshold is compatible with the timer cadence.
- A replacement timestamp, when operationally needed, is written only after those proofs. Old
  timestamps remain forensic evidence and are never reused.

Rollback does not rebuild or mutate Builder V1. Stop the shadow timer/call site, deploy the prior
application artifact, and prefer forward-repairing quarantined graph revisions. Drop new RPCs and
tables only if no newer code or retained evidence references them; do not edit migration history.
