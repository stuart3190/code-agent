# Package 14S — execution-first live booking qualification

Date: 2026-08-09 UTC

Status: **ARCHITECTURAL RESULT: PASS — PRODUCT RESULT: FAIL.** Builder V2 quality is not
qualified. Package 15 remains blocked.

## What changed before this run

Commit `92de017` ("make execution the gate, not implementation shape") replaced Builder V2's
terminal pre-compile shape gates with a blocking/advisory severity model, moved the immutable
candidate checkpoint ahead of every shape gate, split core attempts from pre-compile corrections,
made capability references count as usage, consolidated the duplicate capability authority,
genericised cancellation and module planning, and added domain-neutral React bindings.

## Deployment

- Production base before deploy: source identical to `1cab2d7` (byte-for-byte modulo CRLF).
- `DEPLOYED_COMMIT` marker read `0b177e8` and is **stale**; the running source was `1cab2d7`.
  This is a provenance defect in the marker file, not in the deployed code.
- 34 files from `92de017` deployed; each verified against the commit's bytes.
- 26 pre-existing files backed up with a SHA-256 manifest at
  `/home/ubuntu/bv2-rollback-pre-92de017-20260809T232618Z`.
- No dependency, lockfile, migration, web-asset or worker-binary change, so no `npm ci`,
  no web rebuild and no migration ran.
- `thrallo-shell` and `thrallo-build-worker` restarted; health green, public API 200.

Dark state held throughout: Builder V1 default, `bv2.enabled`/`bv2.owners` absent, managed
settlement paused, customer worker dispatch and atomic publishing off.

## Zero-model production preflight — 20/20 GREEN

`ops/prove-execution-first-preflight.mjs`, run in the durable worker context. Zero provider calls.

Configuration: `PREVIEW_MODE=vps`, `PROVISIOND_URL` present, worker role, `CODE_AGENT_STORE=supabase`,
settlement paused. Provisioner reachable (capacity 55); a real isolated preview was created and
destroyed. Generated runtime: `VITE_AUTH_URL` materialised, visitor signup + recovery returned the
same identity, full authenticated CRUD, runtime key source `SUPABASE_ANON_KEY` with no privileged
credential. Candidate snapshots materialise but never become a green pointer. Severity tables
disjoint with advisory-by-default. `maxRepairs` enforced; two corrections consumed zero repair
slots. `cancel the subscription` resolves to `makeEntityStore`, never `makeBookingSystem`.
`useSyncExternalStore(store.subscribe, store.getState)` counts as usage. Execution-first ordering
observed as `checkpoint:candidate(promotable=false) → compile → browser`.

Repository suites on the production host: **376/376 pass** (Node 22), including real Chromium.

Two process notes recorded honestly:

1. The first preflight run reported four failures on the generated-runtime checks. The cause was
   the preflight itself passing a random UUID as the app id; app-auth correctly answered
   `valid appId required`. Re-run against a disposable project row, every check passed. The script
   now creates and deletes its own disposable project.
2. Enabling `builder_pipeline` before granting credential authority made the worker refuse to
   start with `worker_credential_store_required` — the Package 14 guard behaving correctly. The
   worker was restored to dark immediately and the documented order
   (`configure-package14-worker-authority` → `enable-package14s-worker-job-type`) was applied.

## The one live booking build

Window `2026-08-09T23:36:31Z` – `23:45:46Z`. Project `59e41407-f567-4c1b-8822-58a300927c62`,
build `0825dda2-d6d9-49fe-9432-d2dddbfc3e08`. AUTO routing, connected Codex allowance,
15-credit internal guard.

### Architectural result — PASS

The orchestrator sequence, from durable worker events:

```
routing(contract) → contract: 3 journeys · 1 entity · 4 operations
assets: 3 slot(s), 0 provider call(s)
routing(core) → working_checkpoint candidate:core:1   ← checkpoint BEFORE any shape gate
core: 6 advisory finding(s) recorded; the candidate remains runnable
[compile → preview → browser verification]
repair 1/1: 22 verified failure(s)                     ← browser-informed, evidence-driven
routing(repair) → working_checkpoint candidate:repair:1
repair: 4 advisory finding(s) recorded; the candidate remains runnable
[re-verify → contracted journey still red → blocked]
```

- Candidate checkpoint created: **yes**, on the first core attempt.
- Blocking findings: **zero**. Module corrections used: **zero**. Full-core regenerations: **zero**.
- Advisory findings: **10** (6 core + 4 repair), recorded and non-terminal.
- Compile: **PASS**. Preview container `p59e41407f5674c1b882258a300927c62` ran for the build.
- Browser verification: **reached, twice** — 12 contracted steps driven each time.
- Terminal classification: `contracted_journeys_red` — a behavioural verdict, not a shape rejection.

The four preceding live runs each spent four calls and never reached compilation. This run
reached compilation on its first core candidate.

### Product result — FAIL

First pass 5/12 steps; after one targeted repair 6/12.

| # | Step | First | Final |
|---|---|---|---|
| 1 | open the booking application | pass | pass |
| 2 | start the booking flow | pass | pass |
| 3 | select a date with availability | pass | pass |
| 4 | select an available slot | pass | pass |
| 5 | choose a party size within capacity | fail | **fail** |
| 6 | enter guest name, email, phone, note | pass | pass |
| 7 | continue to review (exact values) | fail | fail |
| 8 | confirm the booking | fail | fail |
| 9 | reload and recover confirmed state | fail | fail |
| 10 | look up booking by reference and email | pass | pass |
| 11 | cancel the booking | fail | fail |
| 12 | reload into explicit cancelled state | fail | fail |

**First genuine application defect — step 5:**
"the clicked option never gained a selected state (aria/data-state/class all unchanged)".
Hand-rolled party-size selection did not expose observable selected state, so the draft value
never propagated. Steps 7–9 and 11–12 are downstream of it: review cannot show exact values that
were never committed, and confirmation/cancellation cannot render state that was never created.

**Two blocking browser errors, both the same defect:**
`401 GET /rest/v1/entities?select=*&type=eq.booking&app_id=eq.59e41407…` — the generated app read
the booking entity without an established visitor session.

This is exactly the failure class the new scaffold bindings exist to remove
(`useSemanticSelection` guarantees `aria-checked`; `useCapabilityState` guarantees store wiring).
The model did not use them on this build.

### Accounting

| Step | Calls | Credits | Input | Output | Reasoning |
|---|---:|---:|---:|---:|---:|
| contract | 1 | 0.4709 | 1,114 | 3,595 | 221 |
| core | 1 | 2.6926 | 18,914 | 8,012 | 0 |
| repair | 1 | 3.9868 | 32,287 | 7,581 | 0 |
| **total** | **3** | **7.1503 / 15** | **52,315** | **19,188** | **221** |

Cached input tokens: 0. Lifecycle wall time: 555.7 s. Complexity: `medium`
("multi-step booking flow requires coordinated durable state"). Every call used the connected
Codex allowance under AUTO routing. The separate `repair` stage was **not** used — the single
browser-informed repair ran inside the booking lifecycle.

Generic module planning produced, from the contract alone:
`src/data/booking.js`, `src/data/wizard.js`,
`src/components/complete-recover-and-cancel-booking/CompleteRecoverAndCancelBooking{Flow,Review,Confirmation,Status}.jsx`.

## Cleanup and safety

Disposable project erased with `projectSurvivors: 0`, preview stopped, `parity: true`.
Production counts returned exactly to baseline: 13 projects, 39 build jobs, 6 historical V2 builds,
10 historical reservations, 0 snapshots. `bv2.enabled`/`bv2.owners` remain absent, zero active jobs,
worker restored to `proof_slow,publish_package` with qualification authority removed
(`BYOK_ENC_KEY`, `CODE_AGENT_STORE`, `PLATFORM_ENC_KEY`, `SUPABASE_ANON_KEY`,
`SUPABASE_PUBLISHABLE_KEY`). Shell, worker and provisiond active; health green. No Stripe
transaction, migration, Caddy operation, backup ceremony or V1 change occurred.

Private evidence: `/home/ubuntu/thrallo-deploy-evidence/package14s-execution-first-20260809T2340Z`.

## Verdict

The pre-compile rejection loop is **broken**: the architectural correction did what it was
designed to do, and this run bought behavioural evidence instead of another linter bug.

Builder V2 is **not** strictly qualified. The remaining gap is now genuinely application-side
generation quality — selection-state wiring and session-scoped reads — which is a different and
more tractable problem than the one that consumed the previous four runs. Package 15 remains
blocked.
