# Package 14S repair-reservation sizing and one bounded live proof

Date: 2026-08-09 UTC

Status: **SIZING REPAIR PASS; LIVE BOOKING QUALITY FAIL**

## Deterministic repair

Commit `1cb6427e93df6860dcfce2733833aa34a667368d` makes the hard repair-call limit
`min(configured call ceiling, live approved build headroom)`. The former four-credit repair
allowance remains visible as a nominal planning target, but no longer strands approved whole-build
headroom. A small scope envelope now derives output allowance from retrieved files, retrieval
tokens, verifier problems and expected patch size. The durable reservation RPC remains the final
whole-build concurrency authority. Planning assumes uncached input conservatively; settlement
continues to reconcile actual cached/uncached telemetry through the canonical cost model.

The exact 5.901-credit headroom / 6.0-credit configured ceiling case now plans and is dispatchable.
Small repairs do not automatically request 10,000 output tokens; insufficient minimum-useful
headroom still fails before dispatch.

- focused reservation/14R/14S tests: 29/29 passed;
- relevant zero-model V2/provider tests: 235/235 passed;
- provider calls before the live gate: zero.

## Dark deployment identity

- source commit: `1cb6427e93df6860dcfce2733833aa34a667368d`
- source archive SHA-256: `6582973cab20d93a6385da2a7148bf0bc339d13e2437b1cf96a79a745e24b0f9`
- web artifact SHA-256: `5612796859cbac55308cf6af9ef598569435f79be1f865d6f8a92644940f622f`
- shell artifact SHA-256: `74795fd824e406f5947d004dd9d853dbc08571306e9c6c7a73f01f040cb5c60d`
- worker artifact SHA-256: `ff7b4fb54c1e46402edae1d6065ca4b3440317c9b069a042293a63d6d400ac09`
- deployment manifest SHA-256: `a6e8561971c963008e32f78e0e45a7253543c03d3ed6e242756939461e164ded`
- production migration ledger inherited unchanged: 71

## One fresh AUTO booking proof

The one authorized full build used connected Codex allowance, AUTO routing and the 12-credit
internal runaway guard. It classified the request as `medium`, persisted the required six-module
booking plan, and persisted booking, wizard and contact capability bindings. AUTO selected
`connected_allowance:codex:gpt-5.5:medium` for contract and core.

The contract call succeeded. The core call produced seven structured patches spanning the planned
booking adapters/components and Home page. Before compilation, required-capability lint threw:

`Cannot read properties of undefined (reading 'instances')`

The exact generated adapter used `makeEntityStore` alongside `makeBookingSystem`. The AST linter
records every recognized factory in `module.instances`, including `makeEntityStore`, but initializes
its aggregate `facts` map only for contract-required booking/wizard/contact/newsletter factories.
`facts.get("makeEntityStore").instances` therefore dereferences `undefined` at
`shell/server/lib/builderV2/capabilityLint.mjs`. This is a fail-closed platform exception, not a
model-quality verdict.

There was no compile result, browser journey, immutable working checkpoint or strict green state.
Because `workingSnapshotId` was absent, the one permitted checkpoint repair could not legally run;
no repair call and no second full build were attempted. The sizing repair is deterministically
proven but was not reached by this live run.

## Usage

- calls: 2 (contract, core)
- input / cached / output / reasoning tokens: 5,922 / 0 / 10,730 / 169
- provider-reported total tokens: 16,652
- aggregate provider latency: 196.183 seconds
- full lifecycle wall time: 203.9 seconds
- Thrallo internal credits: 1.6652 / 12
- targeted repair: not run; no working checkpoint existed

## Cleanup and safety

The disposable project and its build, two reservations, two AI requests, worker job/result/events,
contract, knowledge and diagnostics were erased. All twelve canonical baseline table counts and
full-row hashes matched exactly after cleanup. Production returned to 13 projects, 39 build jobs,
198 AI requests, 284 usage records, one published site and five deployments.

The worker is restored to `proof_slow,publish_package`. Builder V1 remains default; `bv2.enabled`
and `bv2.owners` remain absent/off; customer worker dispatch and atomic publishing remain off;
managed settlement remains paused. Shell/app health is green. Provisiond and Caddy were not
changed; the Caddy hash remains
`8d3b0a269e0310a559cd50cf960b9683efa306a02f5521ab6296c7158d2d2098`.

Package 15 remains blocked. The next work is a separately approved, narrow capability-linter
aggregate guard/regression for recognized non-required factories; it must not broaden Package 14S.
