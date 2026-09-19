# Package 14 — minimum live V2 quality qualification

Date: 2026-08-08  
Verdict: **FAIL**  
Provider-credit ceiling: 15  
Actual credits: **6.6273**

## Scope and safety

The production Builder V2 composition was invoked only through the operator runner for two
internal projects. Customer routing, customer worker dispatch and customer atomic publishing
remained off. `bv2.enabled=false`, `bv2.owners=[]` and
`THRALLO_MANAGED_SETTLEMENT_PAUSED=1` remained unchanged. No Stripe call, Caddy operation,
provisiond operation, migration, backup ceremony or V1 removal occurred.

The worker was temporarily allowed to lease `builder_pipeline` jobs for these fixed internal
projects. It was returned to `proof_slow,publish_package` dark mode after the qualification. Shell,
worker and `app.thrallo.com` were healthy at the stop point, with zero active worker jobs.

## Result matrix

| Test | Result | Evidence |
|---|---|---|
| Simple new build | **FAIL** | Contract and core patches ran, patch validation recovered from a god-component rejection, browser verification failed, and the repair reservation could not fit under the then-current qualification ceiling. No green snapshot or preview was promoted. |
| Edit | **FAIL / blocked** | The required green Test 1 snapshot does not exist. Running an unrelated edit fixture would not prove the requested path. |
| Targeted repair | **FAIL** | A real retrieval-scoped booking repair changed only two relevant modules and improved three selection steps to passing, but review, confirmation and refresh recovery remained red. It did not produce a verified repair. |
| Provider failure | **PASS** | Real Codex `401 token_expired`: reservation existed before dispatch, lane stayed `connected_allowance:codex:gpt-5.5`, usage/cost were zero, the reservation released, and no managed substitution or duplicate debit occurred. |
| Booking benchmark | **FAIL** | One attempt only. The app used `makeBookingSystem` but bypassed `makeWizardMachine`. One targeted repair improved selection state; review/confirmation/recovery still failed. A second repair was not dispatched because the 9-credit ceiling correctly refused it. |

## Accounting and router evidence

- Live qualification window: 2026-08-08T21:54:34.033Z through 2026-08-08T22:35:15.175Z
  (40 minutes 41.142 seconds, including bounded fixes and dark-worker restoration).
- Complete Package 14 wall clock through tests, documentation and provenance verification:
  2026-08-08T21:54:34.033Z through 2026-08-08T22:44:31.650Z (49 minutes 57.617 seconds).
- Logical reserved calls: 10.
- Usage-bearing model turns: 8.
- Released, zero-usage provider rejections: 2.
- Input tokens: 30,439.
- Cached input tokens: 3,712.
- Output tokens: 39,175.
- Reasoning tokens: 2,787.
- Summed provider latency: 720,306 ms.
- Simple-test cost: 2.5940 credits total, comprising a 0.3269-credit contract-only ceiling
  discovery and 2.2671 credits in the final contract/core lifecycle.
- Booking cost: 4.0333 credits.
- Provider-failure cost: 0.
- Every call used the exact connected Codex allowance identity: provider `codex`, model `gpt-5.5`,
  lane `connected_allowance`, reasoning profile `medium` in the canonical router identity.
- Manual model selection applied to every call, so this run does **not** prove that the automatic
  router reduces cost across multiple executable models. Cached-token pricing did work: the second
  booking core call recorded 3,712 cached tokens and cost 0.77082 versus 1.2118 for the uncached
  first core call.
- Every usage-bearing turn settled once with one typed provider response ID. The two rejected calls
  released rather than settling. No duplicate usage or debit was observed.

## Live defects found and bounded fixes

1. The build worker defaulted to the process-local credential store and therefore resolved a
   Codex owner as managed. The worker now refuses `builder_pipeline` startup unless
   `CODE_AGENT_STORE=supabase` and the owner credential encryption key are present.
2. Stored opaque Codex access tokens had no readable JWT expiry. An explicit `401 token_expired`
   now forces one refresh and one retry; no ambiguous failure is replayed.
3. The ChatGPT Codex backend rejects `max_output_tokens`. The Codex transport no longer sends the
   unsupported field. Durable pre-dispatch reservation and post-turn build ceilings remain.
4. A handwritten manual-selection value included `#medium` and was correctly rejected by the
   catalogue. The runner now derives the selectable value from the canonical identity contract.
5. Contract request IDs were lost between the usage bucket and diagnostics. The bucket now retains
   typed provider IDs, and diagnostics use the router provider identity instead of inferring
   `openai` from a `gpt-*` model name.
6. Qualification and per-step reservation ceilings were too small to admit conservative repair
   holds even when actual usage remained modest. Repair/edit/increment call ceilings now have
   bounded headroom. This prevents the known immediate refusal but does not make either failed
   application green.

Commits: `2cecf50`, `abd6ad4`, `a4e0656`, `0ee4f08`, `0a349bb`, `39aa291`,
`dac338a`, `7fb3ec2`, `d81641b`, `b0a828c`, `9a3eb4b`, `ae02c36`.

Focused provider/runtime tests passed. Full repository result after the final change:
1,354 tests; 1,337 passed, 17 intentionally skipped, 0 failed.

The final runtime provenance manifest identifies deployed commit
`ae02c36f67ae22ee2a9f1f65f77ea95864befbd0`, migration ledger 70 and manifest identity
`1568f3f19d04bca85b4649ea8ea234cee558274e82567ebc5527e1a378b5877b`. Immutable evidence is in
`/home/ubuntu/thrallo-deploy-evidence/package14-live-20260808/artifacts`; source/shell/worker/web
artifact SHA-256 values are respectively `1c032539967164c7a4962d4d4dadf59c213ace6b7a390c091d33c96968e1d519`,
`ba169b613f0dffe34e08054d153f00a3473f1398530d066b1e549cc6e10f63f8`,
`d180f0ece1ad03f1c0920f497782a55429040211fac4200492223d48b553b236` and
`dab0e0ccc61df194ed2192bb9db1e9c1fc9853634443e012c7b3d86c86542ab9`.

## Booking failure evidence

The first browser pass failed selection, review and confirmation. The single repair made date, slot
and party selection visible and verifiable. The second browser pass still failed:

- review did not create a new visible summary state;
- confirmation did not show the required screen/reference state;
- refresh recovery showed none of the selected date/slot values.

Patch inspection proved `makeBookingSystem` was imported, `makeWizardMachine` was not, and
`localStorage` was not used. This is the exact failure condition the package said must stop the
booking benchmark, so no rerun occurred.

## Disposition and next gate

The two internal failed projects and their diagnostics/reservations remain in production as
qualification evidence; they have no active jobs, green pointers, previews or customer routing.
They must be archived/erased under the proven internal-data process after the evidence retention
decision, not silently deleted in this package.

Builder V2 generation quality is **not qualified**. Package 15 must not start. The next package is
**Package 14R — deterministic quality repair and one bounded requalification**, focused on:

1. making booking/wizard binding mandatory when both capabilities are contracted;
2. making repair reservation estimates fit an explicit build ceiling without hiding actual spend;
3. retaining a resumable verified intermediate tree so a pre-dispatch repair-budget refusal does
   not force contract/core regeneration;
4. proving verifier actions target the intended date/slot/party controls and the review,
   confirmation and restored states;
5. rerunning the minimum live matrix only after deterministic fixtures pass.

Package 14R requires separate approval and a separately stated provider-credit ceiling.
