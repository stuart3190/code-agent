# Package 14S direct-grammar live booking qualification

Date: 2026-08-09 UTC

Status: **FAIL — generated application did not reach compilation**

Exactly one fresh AUTO-routed booking lifecycle ran. No second full build ran. The permitted
checkpoint repair did not run because compilation never succeeded and no immutable `working:*`
checkpoint existed.

## Safety and deployed grammar

- source authority: `af2f83598f995c97ef631356540632707b59b95e`;
- capability grammar commit: `9c794c7d5bc39ce5684d4fbad25077ccd5650d17`;
- deployed `capabilityLint.mjs` SHA-256:
  `4f07b0b0fbb06cdaeb7e82ef93efe17805c7add225681f35520a4b58f870d949`;
- `bv2.enabled=false`, `bv2.owners=[]`, managed settlement paused;
- customer worker and atomic-publishing routing remained off;
- no Stripe transaction, migration, Caddy operation, backup or infrastructure recertification;
- qualification-only worker authority was removed after cleanup.

## First pass

- window: `2026-08-09T13:03:39.809Z`–`2026-08-09T13:13:32.492Z`;
- complexity: `medium` because the multi-step booking flow requires coordinated durable state;
- routing: AUTO selected `connected_allowance:codex:gpt-5.5:medium`;
- contract: passed and persisted;
- strict first-pass green: no;
- lifecycle state: `blocked`;
- compilation: not reached;
- working checkpoint: none;
- browser verification: not reached.

The enforced module plan was:

1. `src/data/bookingSystem.js` — `makeBookingSystem` persistence adapter;
2. `src/data/bookingWizard.js` — `makeWizardMachine` durable wizard adapter;
3. `src/components/booking/BookingFlow.jsx` — navigation/flow composition;
4. `src/components/booking/BookingReview.jsx` — review presentation;
5. `src/components/booking/BookingConfirmation.jsx` — durable confirmation/reference;
6. `src/components/booking/BookingStatus.jsx` — restored/cancelled status.

Generated candidates also included `ContactDetailsStep.jsx`, `DateStep.jsx`,
`ManageBookingPanel.jsx`, `SlotCapacityStep.jsx`, `HomePage.jsx` and `index.css` where applicable.

Required capabilities were `makeBookingSystem`, `makeWizardMachine` and `makeContactForm`, plus the
registry-approved CRUD/session capabilities. The final candidate passed required capability lint
and module-plan validation: its terminal rejection came later from the deterministic persistence
gate, so the direct factory-result grammar false positive did not recur.

Patch validation rejected one earlier candidate as a four-journey god component. Later candidates
landed their structured patches. The terminal candidate was correctly rejected at
`BookingFlow.jsx:33` and `BookingFlow.jsx:40` because it wrote booking state to `sessionStorage`.
Browser-local storage is not platform persistence and cannot satisfy durable booking recovery.

## Contracted journeys

None reached browser execution, so none has a passing verdict:

- `create-recover-and-cancel-booking`: NOT RUN — blocked pre-compile;
- `validate-contact-details`: NOT RUN — blocked pre-compile;
- `enforce-slot-capacity`: NOT RUN — blocked pre-compile;
- `recover-booking-by-reference`: NOT RUN — blocked pre-compile.

Consequently create/confirm, exact review, durable reference, reload recovery, capacity, contact
validation, cancellation and durable cancelled-state behavior remain unqualified.

## Provider and cost evidence

- calls: 4 — one contract and three bounded core calls;
- model identity for every call: `connected_allowance:codex:gpt-5.5:medium`;
- input tokens: 15,512;
- cached input tokens: 3,712;
- output tokens: 31,749;
- reasoning tokens: 516;
- provider latency: 582.237 seconds;
- Thrallo internal credits: 4.392 / 15.

The contract route chose the strongest executable quality candidate because class evidence remained
insufficient. Core chose the strongest executable balanced-or-better candidate for the same reason.
No manual model selection or lane substitution occurred.

## Repair decision

Repair was not eligible. The full lifecycle failed before compile, created no working snapshot and
therefore had no integrity-checked tree from which a bounded targeted repair could resume. Running a
repair would have been disguised full regeneration and was correctly refused.

## Cleanup and parity

Project erasure removed all disposable project/build/reservation/AI/worker/diagnostic state.
Canonical pre/post row counts and full-row hashes matched for all twelve guarded datasets.

Final production counts: 13 projects, 39 build jobs, 198 AI requests, 284 usage records, one
published site and five deployments. Active V2 builds, reservations and worker jobs are zero.
The worker is back to `proof_slow,publish_package`; shell and worker are healthy.

Private incremental evidence remains mode `0600` at:

`/home/ubuntu/thrallo-deploy-evidence/package14s-direct-grammar-live-20260809T130142Z`

- `state.json` SHA-256: `a0d00b5835f759851d4e568496a10b530e3cd8a96d8597f48d50836461525296`;
- `evidence.jsonl` SHA-256: `1cba85cc32e23aa9de42280dac81c7a05c52c6fe8bf0a1b59c689f253ae2aaa6`.

## Verdict

Package 14S remains FAIL. The capability grammar repair is proven, but Builder V2 booking quality is
not qualified. The exact remaining generation defect is model output that uses `sessionStorage`
for durable booking state despite the contract, capability bindings and prompt explicitly requiring
platform persistence. Package 15 remains blocked.
