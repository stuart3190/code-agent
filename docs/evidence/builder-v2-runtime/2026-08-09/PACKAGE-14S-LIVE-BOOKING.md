# Package 14S single live booking proof — FAIL

Date: 2026-08-09 UTC

The approved one-shot qualification ran from application commit
`c2ad21824b80bfcc0648bed7d5c13b4a4a4cb45e` through the production-dark Builder V2 composition.
It used the connected Codex allowance, AUTO routing, one disposable project and a hard aggregate
guard of 9 Thrallo credits. No full-build retry was performed.

## Immutable deployment identity

- source archive SHA-256: `a0fb894f1e46154cf9bb6969fc439e8c7c2e771797fde62cd8800faba201c89f`
- web artifact SHA-256: `5612796859cbac55308cf6af9ef598569435f79be1f865d6f8a92644940f622f`
- shell artifact SHA-256: `cfe3e2995faf4139af0f626040b59e1e398a8b5d991a871d7a9d945a04323807`
- worker artifact SHA-256: `a7093b37fe32ec42970c0f6a613a2d610a23d0b74468e1c90f515cb7dd3317d0`
- deployment manifest SHA-256: `44971dbe4c117738a28d7afa3f9060752ca1e2e7cf1c36303fc2cd367828d7a6`
- production migration ledger: 71

## Result

- classification: `medium` — `multi-step booking flow requires coordinated durable state`
- module plan: `src/data/bookingSystem.js`, `src/data/bookingWizard.js`,
  `BookingFlow.jsx`, `BookingReview.jsx`, `BookingConfirmation.jsx`, `BookingStatus.jsx`
- required bindings: booking (`makeBookingSystem`), wizard (`makeWizardMachine`), contact
  (`makeContactForm`); all factories and planned modules were present in every final candidate
- router: `connected_allowance:codex:gpt-5.5:medium`; contract selected as strongest available
  quality candidate and core as strongest available balanced-or-better candidate because the
  catalogue had insufficient successful class evidence
- provider calls: 4 (one contract, three bounded core attempts)
- credits: 4.4655 / 9
- input / cached / output / reasoning tokens: 16,663 / 4,736 / 32,254 / 1,257
- provider-reported total tokens: 48,917
- aggregate provider latency: 590.792 seconds
- booking lifecycle wall time: 595.437 seconds
- compile: not reached
- browser journeys: not reached; all four contracted verdicts remained absent
- first-pass strict contracted quality: FAIL
- targeted repair: not run; no core candidate passed the structural gate, so no immutable working
  checkpoint existed. A repair would have required forbidden full regeneration.
- final strict contracted quality: FAIL

## Exact defect

All three candidates satisfied the enforced module plan. They instantiated the required factories,
but exported capability methods through ordinary JavaScript destructuring, for example
`export const { createBooking, cancelBooking, getBooking } = bookingCapability` and the equivalent
wizard binding. The structural linter recognizes only direct `instance.method(...)` calls. It
therefore reported the same eleven missing-method defects on every attempt even when the generated
modules exported and invoked the required destructured methods.

This is a platform capability-lint grammar defect and inadequate rejection contract, not another
booking modularity failure. The linter must either safely recognize destructured methods tied to
the factory instance or the generated contract must machine-require the direct-call syntax. No fix
was attempted under this proof-only approval.

## Cleanup and safety

The disposable project and all scoped builds, reservations, AI requests, diagnostics, worker rows,
snapshots, blobs and traces were erased. Canonical pre/post hashes matched for every guarded table.
Global production counts returned to 13 projects, 39 build jobs, 198 AI requests, 284 usage rows,
one published site and five deployments. Active V2 builds, reservations and worker jobs are zero.

The worker was restored to `proof_slow,publish_package` with qualification authority removed.
Builder V1 remains the default; `bv2.enabled` and `bv2.owners` remain absent; customer worker and
atomic-publish routing remain off; managed settlement remains paused. Shell/app/site health is 200.
Caddy was not touched and its configuration hash remained
`8d3b0a269e0310a559cd50cf960b9683efa306a02f5521ab6296c7158d2d2098`.

Private incremental evidence is retained mode-restricted at
`/home/ubuntu/thrallo-deploy-evidence/package14s-live-20260809`.
