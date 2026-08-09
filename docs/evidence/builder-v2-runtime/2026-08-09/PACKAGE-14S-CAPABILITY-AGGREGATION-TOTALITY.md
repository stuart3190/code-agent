# Package 14S capability aggregation totality and bounded live proof

Date: 2026-08-09 UTC

Status: **DETERMINISTIC REPAIR PASS; LIVE BOOKING QUALITY FAIL**

## Confirmed defect and repair

The linter recognised `makeEntityStore` while parsing modules but pre-created aggregate records only
for contract-required booking, wizard, contact and newsletter factories. A generated module using
`makeBookingSystem` with auxiliary `makeEntityStore` therefore dereferenced an absent fact record.

Commit `6677361f9a8fc70dd36689d16b55e9eafe2d7b6d` derives the recognised factory set from the
authoritative capability registry and pre-creates an aggregate record for every factory. Contract
requiredness is metadata rather than a condition for fact existence. Each record retains factory,
requiredness, instances, bound methods, invoked methods and generated modules. Required capability
checks remain unchanged and auxiliary factories cannot satisfy them.

The registry currently contains six factories:

- `makeBookingSystem`
- `makeContactForm`
- `makeEntityStore`
- `makeNewsletter`
- `makeWizardMachine`
- `makeWizardPersistence`

The method table now covers `makeWizardPersistence` (`save`, `load`, `clear`) and its methods are
checked against the real scaffold implementation.

## Zero-model matrix

- focused capability/14R/14S tests: 42/42 passed;
- relevant Builder V2/provider/verification tests: 302/302 passed;
- `git diff --check`: passed;
- provider calls before the deterministic gate: zero.

The matrix covers every registry factory as required where supported and as auxiliary, required plus
auxiliary factories in one module, multiple auxiliary factories, direct member invocation,
two-step destructuring, exported two-step destructuring, aliases, cross-module named imports,
bound-but-unused methods, actual invocation, unrelated local functions/objects, missing factories
and methods, duplicate instances and multi-module aggregation. It reproduces both
`makeBookingSystem` + `makeEntityStore` and the booking/wizard/contact/entity-store combination.

The matrix was not actually grammar-complete: its destructuring cases all first assigned the factory
result to an identifier. It omitted direct destructuring of a factory call. The live run exposed this
gap; this evidence does not describe the matrix as comprehensive after that discovery.

## Dark deployment identity

- source commit: `6677361f9a8fc70dd36689d16b55e9eafe2d7b6d`
- source archive SHA-256: `38e7c7db58cd16b4dbc193a764aa36805e52b3b039921dd2df8f1d875b160b7c`
- web artifact SHA-256: `a11df6274ea4ccd8020bdd3b669d2210907963cf845b06ae79542005b238e475`
- shell artifact SHA-256: `ab224f04e86e2ebf9ec2efc9616ff6ae5899191ee6be7d91ad565199d3473430`
- worker artifact SHA-256: `961651c3486cbb4a27e83b5555f6c5e87b8642059f0881a6de809b5eba05cada`
- deployment identity: `1c4066286adf165ebaf164337a178cc9d6e55fc55f993aa6a1d1ff812efe4ded`
- migration ledger inherited unchanged: 71

## Single live booking proof

The one authorized AUTO lifecycle used connected Codex allowance with the 12-credit internal guard.
It ran from `2026-08-09T12:04:18.066Z` to `2026-08-09T12:12:05.811Z` (467.745 seconds).

- complexity: `medium` (`multi-step booking flow requires coordinated durable state`);
- plan: booking adapter, wizard adapter, flow, review, confirmation and status modules;
- required bindings: booking (`createBooking`, `cancelBooking`, `getBooking`), wizard (`getState`,
  `subscribe`, `restore`, `select`, `next`, `confirm`, `cancel`) and contact (`submitContact`);
- attempt 1: no usable module tree;
- attempt 2: rejected as a four-journey god component;
- attempt 3: module plan passed and the registry-total aggregator did not throw, but capability lint
  reported direct factory-result contact destructuring as missing and correctly reported wizard
  `getState`/`subscribe` as bound but never invoked;
- compile: not reached;
- working checkpoint: none;
- browser journeys: not reached;
- first-pass strict green: false;
- targeted repair: not run because no immutable working checkpoint existed;
- final strict green: false.

The exact new false rejection is valid JavaScript with machine-verifiable provenance:

```js
export const { submitContact } = makeContactForm({ entity: "contactMessage" });
```

The AST grammar only attributes object-pattern destructuring when its initializer is a previously
recognised instance identifier. It does not attribute an object pattern initialized directly by a
known factory call. This is the next bounded platform-linter defect. Separately, merely binding
wizard methods without calling them must continue to fail.

## Usage and routing

All four calls used `connected_allowance:codex:gpt-5.5:medium` under AUTO routing. The contract
required the quality tier; core required balanced or stronger. Router rationale was persisted.

- calls: 4 (one contract, three core);
- input tokens: 15,586;
- cached input tokens: 7,424;
- output tokens: 24,972;
- reasoning tokens: 706;
- provider-reported aggregate tokens: 40,558;
- provider latency: 462.030 seconds;
- Thrallo internal credits: 3.3876 / 12.

## Cleanup and safety

Project erasure removed the disposable project, one public build, one V2 build, four reservations,
four AI requests, one worker job/result, 83 worker events, one contract, six knowledge rows and one
diagnostic run. No snapshot, blob, release, deployment, site or custom-domain row was created.

All twelve canonical pre/post counts and full-row hashes matched exactly. Production returned to 13
projects, 39 build jobs, 198 AI requests, 284 usage records, six historical V2 builds, ten historical
reservations, eight historical worker jobs, one published site and five deployments.

The worker is restored to `proof_slow,publish_package`. Shell and worker are active, Builder V1
remains the customer default, `bv2.enabled` and `bv2.owners` remain absent, managed settlement is
paused, and the Caddy hash remains
`8d3b0a269e0310a559cd50cf960b9683efa306a02f5521ab6296c7158d2d2098`.

Package 14S is not green and Package 15 remains blocked. No additional repair or live call was run.
