# Package 14R — deterministic quality repair

Status: deterministic gate **PASS**; bounded live requalification pending.

Safety state during this work:

- zero provider calls and zero new provider credits;
- no Stripe transaction;
- Builder V1 remains the customer default;
- Builder V2 customer routing remains disabled;
- managed settlement remains paused;
- no production migration, Caddy change, cutover or V1 removal.

## Package 14 root causes

### Simple first-green failure

The retained Package 14 tree instantiated `makeContactForm({ type: "contactEnquiry" })`.
The capability contract accepts `entity`, so it used the default `contactMessage` entity while the
implementation contract and browser/backend proof required `contactEnquiry`. The old capability
binding was descriptive rather than structural: it proved that the factory name appeared, not that
the exact entity and required method were bound. Browser verification correctly found no required
backend mutation. A second platform defect then refused a bounded repair because reservation
planning treated the initial stage target as if it were the entire approved build ceiling.

Classification:

- prompt/contract enforcement defect: exact capability configuration was not machine-enforced;
- model-generation defect: the model emitted an unsupported option name;
- budget/repair defect: unused approved build headroom was not available to repair;
- verifier defect: none; the backend fingerprint rejection was correct.

The regression fixture now proves the retained wrong shape fails structural lint and the corrected
shape persists `contactEnquiry`, source metadata and a reference.

### Booking review, confirmation and refresh failures

The Package 14 booking tree used `makeBookingSystem` but omitted `makeWizardMachine`, then rebuilt
multi-step state in component-local React state. This made review/confirmation state informal and
lost it across reload. The previous wizard persistence contract was also unsuitable for the required
terminal behavior: `confirm()` and `cancel()` cleared persistence and `restore()` forced ACTIVE.

Classification:

- mandatory capability-binding defect: multi-step booking could omit the wizard;
- capability/runtime defect: confirmed/cancelled terminal state was not durable;
- model-generation defect: the model bypassed the requested wizard capability;
- verifier defect: none; review, confirmation/reference and reload failures were real.

The repaired headless wizard persists through the platform backend by default, restores review,
confirmed/reference and cancelled state, and never uses browser storage or imposes JSX/CSS.

## Implemented invariants

1. Contract capability bindings carry exact configuration and required methods.
2. Booking-only contracts require `makeBookingSystem`; true multi-step booking requires both
   `makeBookingSystem` and `makeWizardMachine`.
3. Generated core, repair and edit trees are structurally linted before browser verification.
4. A repair cannot delete or disable a contract-required binding.
5. Repair reservations fit the live durable budget:
   `actual + held + new reservation <= approved build ceiling`.
6. The per-call ceiling and 4-credit repair allowance remain independent hard limits. The live
   checkpoint preflight proved 2.5 could not safely cover its conservative zero-cache input bound;
   no provider call occurred during that failed preflight.
7. Core/repair/edit produce byte-verified immutable `working:*` snapshots after compilation and
   deterministic gates, before browser verification.
8. Working snapshots are not promoted to green/preview/published. Failed/blocked checkpoints are
   retained for targeted resume; cancelled checkpoints are removed owner/project/build-scoped.
9. `resume_repair` materialises the exact checkpoint and existing contract and invokes only the
   repair model step; it cannot replay contract/core generation.
10. Per-build `routingMode: "auto"` is durable, avoids owner-preference mutation and does not force
    a manual model identity.
11. The live runner is exactly-once per stage and hard-caps aggregate settled usage at 12 credits.
12. Exact repaired bytes reuse an existing byte-proven snapshot, while asset-only regeneration has
    a manifest-distinct immutable identity. Migration `20260808235700` replaces the incorrect
    `(project_id, tree_hash)` uniqueness rule without rewriting snapshot rows.

## Deterministic proof

- Focused Package 14R/runtime tests: 17/17 pass.
- Relevant V2/provider/verification regression suite: 219/219 pass.
- Representative V2 qualification suite: 160 pass, 17 intentional platform skips, 0 fail.
- Syntax and diff checks: pass.
- New provider credits: 0.

Covered explicitly:

- booking-only versus multi-step capability binding;
- exact factory configuration and required-method enforcement;
- model omission and repair removal rejection;
- visual-style independence;
- retained simple-build entity mismatch;
- reusable headroom, duplicate reservation prevention, cancellation release and hard ceiling;
- complete booking review/confirm/reference/reload/cancel state without `localStorage`;
- failed-verifier resume from the exact tree with zero contract/core replay;
- cancellation cleanup without deleting another resumable checkpoint;
- automatic executable-catalogue routing and persisted rationale;
- live runner aggregate budget and exactly-once booking controls.

## Live gate

The bounded live runner is `ops/run-package14r-live-requalification.mjs`. It performs one simple
build, one edit if green, one controlled checkpoint repair, and one booking build. Every provider
job pins AUTO routing, emits durable incremental evidence and recomputes total settled credits before
and after the stage. Booking cannot be run twice in the same evidence authority.

No live stage is authorised until this deterministic commit is deployed dark and the worker accepts
the matching immutable source.
