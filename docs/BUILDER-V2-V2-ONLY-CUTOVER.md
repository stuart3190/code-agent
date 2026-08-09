# Builder V2-only launch programme

Status: authoritative active finish plan, reviewed 2026-08-08. Builder V2 composition and its
database runtime are deployed dark and Package 10E production proof is green. This document supersedes every earlier
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

- Production and the active directory have 70 migrations through
  `20260808180845_shared_atomic_rate_limits`; pending migrations are zero.
- C4 graph persistence, C7 durable workers and C8 immutable releases are deployed and proven dark.
- Builder V1 is the active customer builder. `bv2.enabled` is false/absent, `bv2.owners` is empty,
  customer worker dispatch and atomic publishing are off, and managed settlement is paused.
- The production V2 composition is deployed dark. Its zero-model fixed-ID production canary,
  Data API conflict stress proof, deterministic qualification and cleanup/customer parity are green.
- Post-Package-12 backup `thrallo-2026-08-08T194910` passed the network-isolated restore gate:
  85 canonical application tables / 36,705 rows, 19 Auth users, two Storage objects and 170
  filesystem objects. A new backup and restore remain mandatory immediately before cutover.

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
| conversation new build | V2 COMPLETE and deployed dark behind the engineering eligibility gate | live qualification and cutover |
| edit | V2 COMPLETE and deployed dark from the promoted green snapshot | live qualification |
| user and verification repair | V2 COMPLETE locally through evidence-driven `runEdit`/repair rounds | live repair matrix |
| retry/crash recovery | V2 COMPLETE with a safe boundary: retry before provider dispatch, recover a durable completion, fail closed on provider ambiguity | disposable Postgres proof and production kill canary |
| cancellation | V2 COMPLETE through the durable C7 job | final internal matrix |
| provider policy/BYOK/Codex | V2 COMPLETE for currently executable canonical lanes; lane selection is pinned at enqueue | Package 13 catalogue/provider proofs |
| managed cross-provider manual choice | V2 PARTIAL: a model configured in UI but unavailable through the resolved executable engine is rejected honestly | add/qualify adapters or constrain the advertised managed list |
| reservation/settlement | V2 COMPLETE and production schema/proofs are installed; managed calls reserve before dispatch and settle once from actual/cached usage | Package 13 synthetic proof; settlement remains paused |
| cost-aware router | V2 COMPLETE locally per step with deterministic-first policy, history, complexity, retrieval, repairs and manual override | representative outcome data |
| assets | V2 COMPLETE through Asset Service and isolated optimiser | live representative qualification |
| project knowledge/index/retrieval/capabilities | V2 COMPLETE, persistent and dark production-proven | live representative qualification |
| contracts/patches/traces/diagnostics | V2 COMPLETE with strict durable evidence and dark production proof | live representative qualification |
| snapshots/preview | V2 COMPLETE and dark production-proven; promoted, byte-verified green snapshot is authoritative | final internal matrix |
| publish/unpublish/rollback | V2 COMPLETE dark in C8; V2 fails closed while atomic flag is off | enable only at cutover proof |
| export/QA | V2 COMPLETE and dark production-proven from green snapshots; browser work uses C7 | final internal matrix |
| repository and desktop/editor work | Separate control plane, not Builder V1 | generated-app actions must call the V2 product APIs |
| direct `/api/generate` and old direct publish routes | LEGACY/DEAD (not mounted by the shell) | delete after route-consumer audit |

## Platform blocker closure

Package 12 closed the confirmed platform-wide blockers outside the composition root:

1. Project and account erasure is owner-scoped, manifest-CAS protected, idempotent and covers the
   database, Auth, Storage, worker/QA files, snapshots/blobs, graph/cache, assets, diagnostics,
   releases and compatibility projections. The content-free audit ledger is append-only.
2. Security-sensitive and expensive HTTP paths use a shared atomic Postgres limiter keyed by the
   best authenticated account/token identity plus a trusted-proxy-derived network identity.
3. Browser logs use authenticated `fetch` plus `ReadableStream`; bearer credentials never enter a
   URL and a real Chromium stream/reconnect/close proof is green.
4. The public analytics collector is routed before global CORS with exact registered-origin,
   app-identity, method, content-type, size and shared-rate-limit enforcement.
5. Fast PR and non-production release workflows now include migration identity, static/unit,
   dependency and secret scans, browser/E2E, fresh reset/lint/diff, worker image build, backup
   compatibility, artifact hashing, deploy smoke and provenance verification.
6. Production has a read-only immutable deployment manifest and admin-only endpoint that bind the
   running source, web, shell, worker and migration ledger to exact hashes.
7. Backup health, isolated restore drills, queue/build/verification/PostgREST/reconciliation/storage
   and identity SLO checks are automated. The encrypted off-host and scheduled restore interfaces
   are installed but deliberately disabled until an external storage target and independent probe
   command are supplied; manual isolated restore remains proven.

The genuine Code OSS Windows desktop remains Package 16 product work. It is not a hidden Builder V2
or Package 12 completion claim.

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
| 10. Production V2 orphan reconciliation | complete 2026-08-08; bounded archive/cleanup and FK preflight green | no runtime-integrity bypass | no | yes |
| 11. Dark V2 composition deploy and zero-model production canary | complete 2026-08-08; Package 10E/10E-F green | installed through migration 68 | no | yes, test-owner only |
| 12. Platform launch blockers | complete 2026-08-08; all 12A-12G production proofs and post-migration isolated restore green | `20260808180841`, `20260808180845` | no | yes, test-owner only |
| 13. Provider/billing closure and executable model catalogue | complete 2026-08-08; executable catalogue, lane isolation, reservation/failure matrix and zero-model production canary green | no migration | no | synthetic/test-owner |
| 14. Minimum live generation/edit/repair/booking matrix | **failed 2026-08-08**; 6.6273 credits, simple and booking never green | no | 6.6273 spent | internal projects/provider calls |
| 14R. Deterministic quality repair and bounded requalification | **failed 2026-08-09**; deterministic repairs green, but contracted contact persistence and the one booking build remained red; 8.2934 credits | `20260808235700` snapshot identity forward repair | 8.2934 spent | internal projects/provider calls |
| 14S. Contracted completion and modular booking planning repair | **live qualification failed 2026-08-09**: grammar and module-plan gates passed, but the sole fresh build used `sessionStorage` for durable booking state and never reached compile/checkpoint | none | 4.392 credits in latest proof | fixture cleaned; Package 15 blocked |
| 15. Final internal V2 production matrix | pending explicit approval | none expected | no model unless separately approved | yes |
| 16. Genuine Code OSS Windows desktop packaging | pending | none expected | no | release infrastructure |
| 17. Final backup/restore, `builder-v1-final`, and V2 cutover | pending explicit approval | none expected | internal canary only | yes |
| 18. Destructive V1 retirement | pending post-cutover approval | additive cleanup only if justified | no | yes |
| 19. Final repository/production audit and launch gate | pending | only confirmed forward repairs | no by default | read/proof, fixes if approved |

Packages 1-13 are zero-credit engineering. Package 14 is the first required provider-spend gate.
No local migration is production-approved merely because its unit tests pass.

Package 14 did not qualify generation quality. The real Codex lane exposed and bounded worker
credential authority, opaque-token refresh, Codex wire-parameter, request-identity and reservation
headroom defects, but the simple build remained red and the booking model bypassed
`makeWizardMachine`. Package 15 is therefore blocked by Package 14R. Evidence:
`docs/evidence/builder-v2-runtime/2026-08-08/PACKAGE-14-LIVE-QUALITY.md`.

Package 14R structurally binds contract-required headless capabilities, makes repair reservations
consume live build headroom, retains immutable unpromoted working checkpoints for targeted resume,
and repairs durable wizard terminal-state recovery. Its deterministic gate is recorded in
`docs/evidence/builder-v2-runtime/2026-08-08/PACKAGE-14R-DETERMINISTIC-QUALITY-REPAIR.md`.

The one bounded 14R run did not qualify quality. It used 8.2934/12 credits. The targeted checkpoint
repair passed after a forward repair to snapshot asset identity, but the simple/edit sequence still
carried a failed contracted contact-persistence journey, and the one booking build was blocked after
three attempts repeatedly violated modularity limits. AUTO routing executed, but only one connected
Codex catalogue model was available, so it proved lane/rationale persistence rather than a real
cost-tier comparison.

Package 14S now prevents `green` completion while any contracted journey is red or missing, refines
multi-step booking to medium complexity, and injects plus machine-checks a visually headless booking
module plan before compile/browser work. Required `makeBookingSystem` and `makeWizardMachine`
bindings remain structural. The deterministic gate passed 238/238 relevant V2 tests with zero model
calls. The separately approved booking proof then failed before compile: all three candidates had
the planned modules and factories, but the capability linter accepts only direct instance-method
calls and rejected valid destructured exports of booking, wizard and contact methods eleven times.
No full retry or targeted repair was possible because no working checkpoint existed. Package 15
remains blocked. Evidence: `docs/evidence/builder-v2-runtime/2026-08-09/PACKAGE-14S-LIVE-BOOKING.md`.

The follow-up AST repair at `6261a03` now proves direct, destructured, aliased and cross-module
capability method provenance while rejecting unrelated or unused names. It passed 33/33 focused and
255/255 relevant zero-model tests. The one new live build passed capability/module lint on its
second bounded core candidate, compiled and reached browser verification. Its essential booking
journey remained red at contact entry, review, durable confirmation and reload. The sole checkpoint
repair then failed before dispatch because its six-credit call ceiling could not fit inside 5.901
credits of remaining build headroom. Package 15 remains blocked; no retry was run. Evidence:
`docs/evidence/builder-v2-runtime/2026-08-09/PACKAGE-14S-CAPABILITY-LINT-REPAIR.md`.

The narrow reservation repair at `1cb6427` now sizes a targeted repair to
`min(configured call ceiling, remaining approved build headroom)` and a scope-proportionate output
allowance. The exact 5.901/6.0 case and the full zero-model reservation matrix pass. Its single
authorized live booking proof did not reach that repair path: generated code combined the required
booking capability with the valid CRUD factory, exposing an AST aggregate bug where
`makeEntityStore` exists in `module.instances` but not the required-capability facts map. The
exception occurred before compile/checkpoint, so no repair or regeneration was permitted. Package
15 remains blocked. Evidence:
`docs/evidence/builder-v2-runtime/2026-08-09/PACKAGE-14S-REPAIR-RESERVATION-SIZING.md`.

The registry-total aggregation repair at `6677361` separates recognised, required and actually used
capability factories. Every one of the six registry factories now receives complete instance,
binding, invocation and module facts; the former `makeBookingSystem` + `makeEntityStore` crash is
covered directly. Focused tests passed 42/42 and the relevant zero-model V2/provider/verification
suite passed 302/302. The single approved live build proved the exception gone, medium complexity
and the six-module plan, but all three bounded core candidates remained pre-compile failures. The
last candidate used valid direct factory-result destructuring
(`export const { submitContact } = makeContactForm(...)`), a grammar form the new matrix had not
covered, so contact provenance was falsely reported missing. It also genuinely bound but did not
invoke wizard `getState` and `subscribe`. With no working checkpoint, repair was forbidden. Cleanup
and customer parity passed; Package 15 remains blocked. Evidence:
`docs/evidence/builder-v2-runtime/2026-08-09/PACKAGE-14S-CAPABILITY-AGGREGATION-TOTALITY.md`.

The direct factory-result grammar repair at `9c794c7` resolves both named capability identifiers and
recognised factory `CallExpression` values through one AST provenance abstraction. All six factories
derived from the registry pass ten source/binding/import forms each. A retained live-shape fixture
now accepts `export const { submitContact } = makeContactForm(...)` without accepting unrelated
names; it still rejects the genuinely bound-but-uninvoked wizard `getState` and `subscribe` methods.
The retained tree and its corrected variant both pass patch validation and real Vite compilation,
while only the corrected variant passes the capability contract. Focused grammar/replay tests passed
25/25 and the relevant zero-model V2/provider/verification suite passed 307/307. No provider call or
production action occurred. Package 15 remains blocked pending a separately approved booking proof.
Evidence: `docs/evidence/builder-v2-runtime/2026-08-09/PACKAGE-14S-DIRECT-FACTORY-GRAMMAR.md`.

The one separately approved post-grammar booking lifecycle used AUTO
`connected_allowance:codex:gpt-5.5:medium` and 4.392/15 internal credits. The direct factory-result
false rejection did not recur: the terminal candidate passed capability and module-plan validation.
It was correctly stopped before compilation because `BookingFlow.jsx` used `sessionStorage` at two
sites for booking recovery. No `working:*` checkpoint existed, so the one allowed targeted repair
was ineligible and no additional call ran. Cleanup and canonical customer parity passed. Builder V2
quality remains unqualified and Package 15 remains blocked. Evidence:
`docs/evidence/builder-v2-runtime/2026-08-09/PACKAGE-14S-DIRECT-GRAMMAR-LIVE-QUALIFICATION.md`.

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

1. Prove the executable provider catalogue, reservation/settlement path and manual-model behavior
   under Package 13 while managed settlement remains paused.
2. Run only the separately approved minimum live build/edit/repair/provider-failure/booking matrix.
3. Run the final internal V2 production matrix and a fresh complete backup/isolated restore.
4. Complete and qualify the genuine Code OSS Windows desktop distribution if it remains part of
   the Thrallo launch definition.
5. Take the immediate pre-cutover complete backup and isolated restore; verify queue, reservations, snapshots, graph,
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

Estimated 18-26 focused engineering sessions for the V2-only web production path: 1-2 for
disposable database proof/repairs, 4-7 for the platform launch blockers, 1-2 for provider/manual
selection closure, 2-3 for minimum live qualification, 2-3 for production canary and
backup/restore, 1 for cutover, 2-3 for V1 deletion, and 2 for the final audit and confirmed fixes.

The approved genuine Code OSS Windows desktop distribution is a further estimated 12-20 focused
sessions because the repository currently contains an extension rather than a forked, packaged,
signed desktop product. Complete Thrallo product launch is therefore approximately 30-46 sessions.
Live provider work and every production-mutating, managed-settlement, V1-deletion or cutover session
requires separate approval.
