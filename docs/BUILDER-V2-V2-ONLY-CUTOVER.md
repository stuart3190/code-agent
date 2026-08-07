# Builder V2-only launch programme

Status: approved product direction; zero-credit production composition is implemented locally and
awaits database/tooling proof. This document supersedes elapsed-time V1/V2 rollout gates. It does
not authorise model spend, production mutation, managed settlement, Builder V1 deletion, or final
cutover.

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

## Ordered packages from current state to V2-only

| Package | State | Migration | Credits | Production mutation |
|---|---|---:|---:|---:|
| 1. Strategy reset and entry-path inventory | complete | no | no | no |
| 2. Atomic model reservations and canonical billing lane | local complete | `20260807213500` | no | later apply |
| 3. Per-step router and provider pinning | local complete | no | no | later deploy |
| 4. Real V2 composition/lifecycle/worker boundary | local complete | `20260807221000` | no | later apply/deploy |
| 5. Snapshot preview/export/QA, legacy adoption, strict diagnostics and knowledge | local complete | included in package 4 | no | later deploy |
| 6. Safe worker crash retry boundary | local complete; provider ambiguity intentionally requires reconciliation | included in package 4 | no | later deploy |
| 7. Headless wizard/state-machine capability | local complete | no | no | later deploy |
| 8. Deterministic representative qualification | local complete, final suite rerun required | no | no | no |
| 9. Disposable Supabase reset/lint/diff and RPC fault/concurrency proof | pending on a Docker-capable isolated environment | no new migration expected | no | disposable only |
| 10. Minimum live generation/booking quality matrix | pending explicit approval | no | yes | test projects/provider calls |
| 11. Internal V2 production canary | pending explicit approval | apply 2, deploy code | no model unless separately approved | yes |
| 12. Final backup/restore, `builder-v1-final`, and V2 cutover | pending explicit approval | none expected | no | yes |
| 13. Destructive V1 retirement | pending post-cutover approval | additive cleanup only if justified | no | yes |
| 14. Final repository/production audit and launch gate | pending | only confirmed forward repairs | no by default | read/proof, fixes if approved |

Packages 1-8 are zero-credit engineering. Package 9 is also zero-credit but requires the proven
isolated Supabase/Docker environment. No local migration is production-approved merely because its
unit tests pass.

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

1. Prove both pending migrations from zero and against the production ledger; apply them separately.
2. Deploy the exact immutable application/worker artifacts with V2 customer routing and managed
   settlement still disabled.
3. Run the zero-model production composition, crash-boundary, snapshot, graph, QA and C8 canaries.
4. Run only the separately approved minimum live build/edit/repair/provider-failure/booking matrix.
5. Take a complete backup and isolated restore; verify queue, reservations, snapshots, graph,
   diagnostics, releases and filesystem artifacts.
6. Tag the deployed V1 source and artifacts `builder-v1-final`.
7. Set the production composition to V2 and make C7/C8 mandatory. Keep one audited,
   engineering-only emergency V1 switch; do not expose it to users.
8. Run health, internal build, edit, repair, cancel, preview, publish, rollback, unpublish/republish,
   restore and legacy-adoption smoke proofs.
9. If any proof fails, disable V2 intake, drain/reconcile durable work and reactivate the retained
   V1 artifact. Never mutate migration history or rebuild a rollback release.
10. If green, declare V2 the production builder. V1 deletion is a separate approval.

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

Estimated 10-15 focused engineering sessions: 1-2 for disposable database proof/repairs, 1-2 for
provider-adapter/manual-selection closure, 2-3 for deterministic and minimum live qualification,
1-2 for production canary and backup/restore, 1 for cutover, 2-3 for V1 deletion, and 1-2 for the
final audit and confirmed fixes. Live provider sessions and every production-mutating session need
separate approval.
