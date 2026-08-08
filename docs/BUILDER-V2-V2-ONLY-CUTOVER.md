# Builder V2-only launch programme

Status: authoritative active finish plan, reviewed 2026-08-08. Zero-credit production composition
is implemented locally and awaits database/tooling proof. This document supersedes every earlier
elapsed-time V1/V2 rollout or v1.0 launch-readiness gate. Approval to execute one package never
authorises a later package, model spend, production mutation, managed settlement, Builder V1
deletion, or final cutover.

## Plan authority and supersession

This is the single execution authority from the current production state to a V2-only Thrallo
launch. Use `docs/PRODUCTION-AUDIT-REMEDIATION.md` as the evidence ledger, not as a competing
schedule. `docs/BUILDER-V2-MASTER-PLAN.md`, `docs/BUILDER-V2-FINISH-PLAN.md` and
`docs/RELEASE-v1.0.md` are retained as historical design/release evidence only. Their shadow-week,
allowlist, broad-rollout, V1 observation-period and earlier launch-ready statements are obsolete.

The running seven-day C4 shadow window remains useful operational telemetry. Its age, volume and
completion state do not permit or prevent launch. Deterministic qualification and controlled
production canaries replace calendar gates.

## Verified starting state

- Production has 65 migrations through
  `20260807174720_c8_atomic_unpublish_deployment_retirement`.
- The active directory has 67 migrations. `20260807213500_bv2_runtime_model_reservations` and
  `20260807221000_bv2_runtime_composition` are local and unapplied.
- C4 graph persistence, C7 durable workers and C8 immutable releases are deployed and proven dark.
- Builder V1 is the active customer builder. `bv2.enabled` is false/absent, `bv2.owners` is empty,
  customer worker dispatch and atomic publishing are off, and managed settlement is paused.
- The production V2 composition is not deployed. Local composition and deterministic qualification
  are green, but they are not substitutes for disposable Postgres and production canary proof.
- Backup `thrallo-2026-08-07T201226` passed the network-isolated restore gate. A new backup and
  restore remain mandatory before cutover.

## Product target

Thrallo launches with Builder V2 as its only active generated-app builder. Builder V1 is retained
only as a temporary engineering rollback path until the V2 cutover is proven. C4 shadowing remains
an operational graph-drift diagnostic; its age and V1 traffic volume are not release criteria.

## Exact remaining V1 dependencies

| Dependency | Evidence | Retirement condition |
|---|---|---|
| Active build/edit/repair fallback | `shell/server/lib/capabilities/coreCapabilities.mjs` calls `startAppBuild`, `repairApp` and V2 eligibility branches | V2 composition and internal production matrix green |
| In-process V1 scheduler/orchestrator | `shell/server/lib/buildJobs.mjs` retains `waiting`, `schedule`, `runJob` and the V1 branch of `executeBuildPipelineWork` | all generated-app work dispatched to C7 |
| V1 staged generation and repair heuristics | `shell/server/lib/appBuild/appBuildService.mjs`, `stagedBuild.mjs`, `checkpointRecovery.mjs`, `repairContext.mjs`, legacy image/design helpers | V2 new/edit/repair benchmark green |
| Mutable project-tree compatibility projection | `projects.tree` and V1 readers in preview/export/publish | every V2 project has an owner-bound green snapshot; legacy adoption proven |
| Legacy publishing branches | `appPublishService.mjs` and dormant `routes/publish.mjs` can package/rebuild mutable trees | C8 is the only enabled publish/rollback/unpublish path |
| Legacy preview/export/QA branches | `showPreview`, `exportProject`, `routes/preview.mjs`, `routes/export.mjs`, and the QA in-process fallback | snapshot materialisation and worker QA are exclusive |
| V1 shadow callback | post-V1 callback in `buildJobs.mjs` | retain only as an optional diagnostic fixture or remove with V1 |
| Dormant direct surfaces | `routes/generate.mjs`, `routes/preview.mjs`, `routes/publish.mjs`, `routes/android.mjs` and old harness scripts | prove unmounted/no supported client, then delete |
| V1-only tests/docs | tests that assert staged orchestration or mutable publishing | replace with V2 product-contract tests before deletion |

Shared provider policy, billing, diagnostics, security, verifier, capability runtime, C7, C8,
migrations and forensic evidence are not V1 code and must remain.

## Production path classification after local composition work

| Path | Current classification | Remaining gate |
|---|---|---|
| conversation new build | V2 COMPLETE locally, still behind the engineering eligibility gate | migrations, deployment, internal canary, cutover |
| edit | V2 COMPLETE locally from the promoted green snapshot | deterministic/live qualification |
| user and verification repair | V2 COMPLETE locally through evidence-driven `runEdit`/repair rounds | live repair matrix |
| retry/crash recovery | V2 COMPLETE with a safe boundary: retry before provider dispatch, recover a durable completion, fail closed on provider ambiguity | disposable Postgres proof and production kill canary |
| cancellation | V2 COMPLETE through the durable C7 job | production canary |
| provider policy/BYOK/Codex | V2 COMPLETE for executable canonical lanes; lane selection is pinned at enqueue | live provider proofs |
| managed cross-provider manual choice | V2 PARTIAL: a model configured in UI but unavailable through the resolved executable engine is rejected honestly | add/qualify adapters or constrain the advertised managed list |
| reservation/settlement | V2 COMPLETE locally; managed calls reserve before dispatch and settle once from actual/cached usage | migration proof; settlement remains paused |
| cost-aware router | V2 COMPLETE locally per step with deterministic-first policy, history, complexity, retrieval, repairs and manual override | representative outcome data |
| assets | V2 COMPLETE locally through Asset Service and isolated optimiser | internal production canary |
| project knowledge/index/retrieval/capabilities | V2 COMPLETE locally and persistent; strict reads/writes in production composition | migration/deployment proof |
| contracts/patches/traces/diagnostics | V2 COMPLETE locally with strict durable evidence | production trace proof |
| snapshots/preview | V2 COMPLETE locally; promoted, byte-verified green snapshot is authoritative | canary |
| publish/unpublish/rollback | V2 COMPLETE dark in C8; V2 fails closed while atomic flag is off | enable only at cutover proof |
| export/QA | V2 COMPLETE locally from green snapshot; browser work uses C7 | canary |
| repository and desktop/editor work | Separate control plane, not Builder V1 | generated-app actions must call the V2 product APIs |
| direct `/api/generate` and old direct publish routes | LEGACY/DEAD (not mounted by the shell) | delete after route-consumer audit |

## Confirmed launch blockers outside the composition root

These are launch blockers unless the affected product surface is deliberately removed before
launch. Completing the V2 orchestrator does not close them.

1. Cross-store project/account erasure is not complete across PostgreSQL, Supabase Storage, VPS
   artifacts, worker artifacts, snapshots, caches, assets and immutable releases.
2. HTTP rate limiting is process-local and cannot enforce atomic limits across restarts or multiple
   shell instances.
3. Authenticated live logs use browser `EventSource` without an authentication-capable stream
   transport; the current browser test stubs the stream.
4. The public analytics collector is reached only after restrictive global CORS, so arbitrary
   custom-domain beacons can be rejected before the collector's wildcard response is written.
5. CI lacks the complete release pipeline: dependency/secret scanning, worker/container artifact
   builds, deploy smoke and immutable release-artifact verification.
6. Backup/restore is proven, but encrypted off-host guarantees, recurring restore drills, RTO/RPO,
   alerts and practical service/blast-radius isolation remain incomplete.
7. Production artifacts do not expose a durable manifest that proves their exact source commit and
   component hashes.
8. `editor/vscode` is an extension surface, not the approved genuine Code OSS Windows desktop
   distribution. Desktop completion is a product-launch package, not proof of Builder V2 itself.
9. Production contains historical V2 rows whose project parents were removed before relational
   cascade constraints existed: 13 builds, 12 verification-cache rows, two snapshots and one green
   pointer. They all belong to one still-existing owner but span deleted projects. Their provenance
   must be classified and they must be restored or explicitly erased before the runtime-composition
   foreign keys can be applied. The constraints must not be weakened or marked `NOT VALID` to hide
   this drift.

## Ordered packages from current state to V2-only

| Package | State | Migration | Credits | Production mutation |
|---|---|---:|---:|---:|
| 1. One authoritative plan and entry-path inventory | complete 2026-08-08 | no | no | no |
| 2. Atomic model reservations and canonical billing lane | local complete | `20260807213500` | no | later apply |
| 3. Per-step router and provider pinning | local complete | no | no | later deploy |
| 4. Real V2 composition/lifecycle/worker boundary | local complete | `20260807221000` | no | later apply/deploy |
| 5. Snapshot preview/export/QA, legacy adoption, strict diagnostics and knowledge | local complete | included in package 4 | no | later deploy |
| 6. Safe worker crash retry boundary | local complete; provider ambiguity intentionally requires reconciliation | included in package 4 | no | later deploy |
| 7. Headless wizard/state-machine capability | local complete | no | no | later deploy |
| 8. Deterministic representative qualification | local complete: 145 qualification, 1,288 repository and 118 browser tests pass | no | no | no |
| 9. Disposable Supabase reset/lint/diff and RPC fault/concurrency proof | complete 2026-08-08; 67 migrations, lint/diff and runtime proof green | no new migration | no | disposable only |
| 10. Production V2 orphan reconciliation | blocked pending explicit data-repair approval; restore legitimate parents or erase proven historical fixtures, then validate every FK preflight | forward repair only if evidence requires it | no | yes |
| 11. Dark V2 composition deploy and zero-model production canary | pending after package 10 | apply packages 2 and 4 separately | no | yes, test-owner only |
| 12. Platform launch blockers | pending: erasure, shared limits, logs, analytics, release provenance, CI/release and DR/SLO | additive repairs only where proven | no | later canaries |
| 13. Provider/billing closure and executable model catalogue | pending | none expected beyond package 2 | no initially | synthetic/test-owner |
| 14. Minimum live generation/edit/repair/booking matrix | pending explicit approval | no | yes | internal projects/provider calls |
| 15. Final internal V2 production matrix | pending explicit approval | none expected | no model unless separately approved | yes |
| 16. Genuine Code OSS Windows desktop packaging | pending | none expected | no | release infrastructure |
| 17. Final backup/restore, `builder-v1-final`, and V2 cutover | pending explicit approval | none expected | internal canary only | yes |
| 18. Destructive V1 retirement | pending post-cutover approval | additive cleanup only if justified | no | yes |
| 19. Final repository/production audit and launch gate | pending | only confirmed forward repairs | no by default | read/proof, fixes if approved |

Packages 1-13 are zero-credit engineering. Package 14 is the first required provider-spend gate.
No local migration is production-approved merely because its unit tests pass.

## Deterministic qualification gate

The fixture matrix covers landing, contact, CRUD/data, booking, multiple routes, auth/session,
asset-heavy, TypeScript/TSX, legacy adoption, edit, repair, rollback, publish/unpublish/republish,
cancellation and provider failure. It must prove graph parity, owner isolation, honest persistence,
verified-preview gating, single settlement, worker containment, immutable publishing, rollback
without rebuild, restorable snapshots, essential journeys and honest terminal errors.

A worker crash may automatically retry only before any model reservation exists. If a crash occurs
after provider dispatch may have begun and no durable final result exists, V2 records
`provider_replay_unsafe` and requires telemetry reconciliation. This is intentionally safer than an
unprovable automatic replay.

Calendar duration, V1 customer traffic and cohort size are explicitly not gates.

## Exact cutover procedure

1. Classify the historical orphan V2 rows against backup/build evidence. Restore only legitimate
   parent projects or erase only proven disposable rows through an approved, audited transaction.
2. Prove zero orphan/constraint conflicts, take a new backup/restore, repeat the linked dry-run and
   apply the two pending migrations separately.
3. Deploy the exact immutable application/worker artifacts with V2 customer routing and managed
   settlement still disabled.
4. Run the zero-model production composition, crash-boundary, snapshot, graph, QA and C8 canaries.
5. Close and prove the cross-store erasure, shared-rate-limit, authenticated-log, public-analytics,
   release-provenance, CI/release and DR/SLO blockers.
6. Prove the executable provider catalogue, reservation/settlement path and manual-model behavior.
7. Run only the separately approved minimum live build/edit/repair/provider-failure/booking matrix.
8. Complete and qualify the genuine Code OSS Windows desktop distribution if it remains part of
   the Thrallo launch definition.
9. Take a complete backup and isolated restore; verify queue, reservations, snapshots, graph,
   diagnostics, releases and filesystem artifacts.
10. Tag the deployed V1 source and artifacts `builder-v1-final`.
11. Set the production composition to V2 and make C7/C8 mandatory. Keep one audited,
   engineering-only emergency V1 switch; do not expose it to users.
12. Run health, internal build, edit, repair, cancel, preview, publish, rollback, unpublish/republish,
   restore and legacy-adoption smoke proofs.
13. If any proof fails, disable V2 intake, drain/reconcile durable work and reactivate the retained
   V1 artifact. Never mutate migration history or rebuild a rollback release.
14. If green, declare V2 the production builder. V1 deletion is a separate approval.

## Exact V1 deletion list after cutover proof

- V1 branches and eligibility fallback in `coreCapabilities.mjs`.
- In-process generated-app queue and V1 `runJob` branch in `buildJobs.mjs`.
- Superseded staged generation, repair/checkpoint/context heuristics and V1 image-search code under
  `shell/server/lib/appBuild/`.
- Dormant direct generate/preview/publish/android routes and their unsupported harnesses.
- Mutable-tree preview/export/publish and rebuild-based rollback branches.
- V1 shadow dispatch callback if it has no independent operational consumer.
- V1-only feature flags, route contracts, tests and documentation.

Do not delete `projects.tree` until every remaining runtime/client consumer is migrated; it may stay
temporarily as a read-only compatibility projection. Do not delete shared infrastructure or any
historical migration/evidence.

## Remaining estimate

Estimated 18-26 focused engineering sessions for the V2-only web production path: 1-2 for
disposable database proof/repairs, 4-7 for the platform launch blockers, 1-2 for provider/manual
selection closure, 2-3 for minimum live qualification, 2-3 for production canary and
backup/restore, 1 for cutover, 2-3 for V1 deletion, and 2 for the final audit and confirmed fixes.

The approved genuine Code OSS Windows desktop distribution is a further estimated 12-20 focused
sessions because the repository currently contains an extension rather than a forked, packaged,
signed desktop product. Complete Thrallo product launch is therefore approximately 30-46 sessions.
Live provider work and every production-mutating, managed-settlement, V1-deletion or cutover session
requires separate approval.
