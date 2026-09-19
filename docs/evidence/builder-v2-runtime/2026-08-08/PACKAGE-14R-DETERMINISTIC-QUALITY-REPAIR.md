# Package 14R — deterministic quality repair

Status: deterministic repair gate **PASS**; bounded live requalification **FAIL**. Builder V2
generation quality is not yet qualified.

Safety state during this work:

- zero provider calls before the deterministic gate; the later approved requalification used
  8.2934 of its 12-credit ceiling;
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

- Final focused Package 14R tests: 16/16 pass, including qualification-preview teardown and
  least-privilege worker restoration.
- Relevant V2/provider/verification regression suite before live spend: 222/222 pass.
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

The gate was deployed dark and the single approved live run completed. No second booking build is
authorised by this package.

## Bounded live requalification

Window: `2026-08-08T23:38:11Z` through `2026-08-09T00:18:49Z`, including final cleanup.

| Stage | Result | Credits | Calls | Evidence |
|---|---:|---:|---:|---|
| Simple | **FAIL quality gate** | 1.8441 | 3 | V2 produced a green primary journey, but the contracted contact persistence journey still failed browser/backend proof |
| Edit | **FAIL qualification** | 0.8992 | 1 | target edit reached a green V2 state, but inherited contact persistence was still red |
| Controlled repair | **PASS** | 1.0226 | 2 | targeted one file from the retained checkpoint; first completion exposed the snapshot identity defect, then the forward repair allowed exact byte-proven reuse |
| Booking | **FAIL** | 4.5275 | 4 | the only booking build exhausted three core attempts without an acceptable modular tree |

The runner's transport result called simple/edit `complete` because the primary journey remained
green. That is not sufficient for this quality report: the final diagnostics recorded no backend
entity change for the required contact submission. Package 14R therefore classifies both as failed
qualification, not successful product behavior.

The single booking build structurally required booking and wizard behavior, but the model repeatedly
generated an oversized/god `HomePage.jsx`. Attempt one was rejected at 4,261 tokens and for owning
three journeys. A later modular patch set was accepted, but the next bounded attempt regressed to a
4,364-token three-journey page and was rejected. The final state was `blocked: no green tree within
3 attempts`. Verification was not weakened and the full booking build was not rerun.

### Provider and router accounting

- 10 provider calls, all AUTO-routed to the only executable connected Codex catalogue entry:
  `connected_allowance:codex:gpt-5.5:medium`.
- Router reasons were durable. Contract/edit/repair selected the strongest available quality+
  candidate; core selected the strongest available fast+ candidate because no model had sufficient
  class evidence.
- 47,748 input tokens, 6,784 cached input tokens, 41,292 output tokens, 1,895 reasoning tokens,
  and 89,040 provider-reported total tokens.
- Provider-call latency total: 755,856 ms. The successful cached checkpoint retry cost 0.2060
  credits versus 0.8166 for the identical uncached repair request.
- Zero-call pre-dispatch failures were archived separately and cost zero.
- Overall first-pass green: 2/4 operations (50%). Overall final green: 3/4 (75%) if the runtime's
  primary-journey state is used; strict contracted-quality success is 1/4 (25%) because simple/edit
  retained a red contact journey. Fresh-build first/final green was 1/2 by runtime state and 0/2 by
  complete contracted behavior.

### Production forward repair discovered during qualification

The repaired working tree exactly matched an existing green tree but carried a different asset
manifest. The old unique index on `(project_id, tree_hash)` rejected the valid immutable snapshot.
Commit `bb87a1f` made reuse byte-and-asset exact and migration
`20260808235700_bv2_snapshot_asset_identity.sql` replaced the narrow index with
`(project_id, tree_hash, asset_manifest)`. Migration SHA-256 is
`6106088752da9226c00538a5fe2014b18edfdeb8a0078a189bf63b20863335c75`; production ledger is 71.

### Evidence, cleanup and safety

- Production state evidence:
  `/home/ubuntu/thrallo-deploy-evidence/package14r-live-20260808/state.json`.
- Incremental event evidence:
  `/home/ubuntu/thrallo-deploy-evidence/package14r-live-20260808/evidence.jsonl`.
- Final local evidence hashes: state
  `506121520bb7875961f662db8c8a97485c46bd54a0662606e6a40df8aebddcc4`; events
  `1459a64014fe1b47413733c25a273a9eb0c24c2513af0cb3ad7867c5df3624a2`.
- Two owner-scoped erasure manifests succeeded. Qualification survivors are zero across projects,
  public/V2 builds, reservations, worker jobs, snapshots/pointers, releases/sites/deployments,
  diagnostics and AI requests.
- Global counts returned to the pre-run baseline: projects 13, build jobs 39, published sites 1,
  deployments 5, AI requests 198 and usage records 284.
- The worker is restored to `proof_slow,publish_package` and qualification-only credential/preview
  authority was removed. Caddy remained at SHA-256
  `8d3b0a269e0310a559cd50cf960b9683efa306a02f5521ab6296c7158d2d2098`.
- V1 remains default; V2 customer flags are absent/off; managed settlement remains paused; no
  Stripe transaction ran.

## Verdict and next package

Package 14R is **FAIL** as a Builder V2 quality qualification. Mandatory binding, repair headroom,
checkpoint resume and durable wizard primitives are repaired, but two remaining platform-quality
defects are now evidenced:

1. completion/green accounting can accept a project after a contracted secondary journey fails;
2. the booking core planner does not reliably preserve modular decomposition across bounded patch
   attempts, and the complexity classifier labelled the explicit multi-step booking as `simple`.

The next authority is Package 14S: deterministic contracted-journey completion gating, booking
module-plan enforcement and complexity classification repair, followed by one separately approved
bounded booking-only proof. Package 15 remains blocked.
