# Package 14S capability-linter grammar repair and bounded requalification

Date: 2026-08-09 UTC

Status: **LINTER REPAIR PASS; LIVE BOOKING QUALITY FAIL**

## Deterministic repair

Commit `6261a031dad593d38ec1021a70e624c2b4d44dab` replaces the required-capability
method regex with conservative Babel AST provenance. It separately tracks:

- capability objects produced by known factories, including the established `useMemo` wrapper;
- methods destructured from those exact objects, including safe local aliases;
- exported destructured methods and named imports between generated modules;
- whether each method is bound and whether the provenance-backed callable is actually invoked.

Unrelated objects, unrelated imports, local functions with matching names, unused destructured
methods, invalid factory objects, ambiguous/redeclared identifiers and aliases from unrelated
sources remain failures. Direct `instance.method(...)` calls continue to pass. Factory, entity,
module-plan, persistence, protected-path and modularity checks were not weakened.

- focused capability/14R/14S tests: 33/33 passed;
- relevant zero-model V2/provider suite: 255/255 passed;
- provider calls before the live gate: zero.

The exact prior live shape—exported booking/wizard/contact destructuring followed by local and
cross-module invocation—now passes.

## Dark deployment identity

- source commit: `6261a031dad593d38ec1021a70e624c2b4d44dab`
- source archive SHA-256: `7d7990ad74f0fe5420610909046f6e9bfc9d062866901178286ef595547a685c`
- web artifact SHA-256: `5612796859cbac55308cf6af9ef598569435f79be1f865d6f8a92644940f622f`
- shell artifact SHA-256: `43088ed92385718a8bc5cd947121fc532e200f084e461add88614ce6fc7c9fb0`
- worker artifact SHA-256: `07aac6f9518ed71119a734ffa6eabad0e27ad5c3a720ecd8f8f5db38bf247aa0`
- deployment manifest SHA-256: `a843758100594e4c40aa26d54e8edce03f13bf445a8b7f20a8c3e29f34531c58`
- production migration ledger: 71

## One live booking build

The single authorized AUTO build used the connected Codex allowance and a 9-credit aggregate
guard. Complexity was correctly `medium`. The exact six-module booking plan and required booking,
wizard and contact capability bindings were persisted.

Core attempt 1 was correctly rejected because wizard `cancel` was destructured but never invoked.
Core attempt 2 passed every capability and module-plan check. The tree compiled, produced an
immutable `working:core` checkpoint and entered browser journey verification. This proves the
destructuring false rejection is fixed in the real worker path.

First-pass journey results:

- `create-confirmed-booking`: FAIL—date/slot/party drove, contact entry was undriveable, review did
  not show exact selected/contact values, confirmation lacked the contracted durable state, and
  reload did not restore the selected values;
- `capacity-is-enforced`: not run after the essential failure;
- `cancel-booking`: not run after the essential failure;
- `validate-contact-details`: not run after the essential failure.

First-pass strict green: **false**.

## One bounded checkpoint repair

The one permitted `resume_repair` lifecycle was queued against the immutable working checkpoint
with the exact failed verifier steps and the three not-yet-verified journeys. It did not replay
contract or core. It failed before provider dispatch with:

`Builder V2 call cannot fit a useful response inside approved headroom`

The build had 5.901 credits remaining, while the repair router selected a 6-credit call ceiling and
10,000-token maximum. Reservation planning did not shrink that call to a useful bound within the
remaining approved build ceiling. Repair calls and credits were therefore zero. No second repair or
full build was attempted.

Final strict green: **false**.

## Usage

- calls: 3 (contract plus two core attempts)
- input / cached / output / reasoning tokens: 10,681 / 0 / 20,309 / 207
- provider-reported total tokens: 30,990
- aggregate provider latency: 372.044 seconds
- first lifecycle wall time: 456.281 seconds
- Thrallo internal credits: 3.099 / 9
- targeted repair: attempted once; zero provider calls and zero additional credits

## Cleanup and safety

The disposable project and every scoped runtime, diagnostic, AI, reservation, worker, snapshot,
blob and preview record were erased. Canonical pre/post hashes matched. Production returned to 13
projects, 39 build jobs, 198 AI requests, 284 usage rows, one published site and five deployments;
active V2 builds, reservations, worker jobs and Package 14S projects are zero.

The worker is back to `proof_slow,publish_package` with qualification authority removed. Builder V1
remains default; V2 flags and customer C7/C8 routing remain off; managed settlement remains paused.
Shell/app/site health is 200. Caddy was not touched and its hash remains
`8d3b0a269e0310a559cd50cf960b9683efa306a02f5521ab6296c7158d2d2098`.

Private incremental evidence is retained mode-restricted at
`/home/ubuntu/thrallo-deploy-evidence/package14s-live-repair-20260809`.
