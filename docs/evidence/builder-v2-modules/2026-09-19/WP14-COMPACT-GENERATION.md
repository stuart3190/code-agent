# WP14 — Compact generation and repair ownership (2026-09-19)

Two claims, both measurable.

## Architectural change

- **Public-ABI projection** `platformModules/abiProjection.mjs`: a build with a module lock is briefed with what `src/lib/app` exports, read from the composed bytes rather than declared a second time, so the brief cannot drift from the file. The full composed surface is no longer sent. Measured on a representative locked build, the projection is roughly half the size of the brief it replaces, and it names every composed facade while naming no private module path — the parity check asserts both.
- **The brief now agrees with the rule it teaches.** Listing private module internals argued against the very boundary generated code is supposed to respect. The compact form names only what may be imported and says outright that `lib/modules`, `lib/capabilities` and `lib/backend` are not for importing.
- **Module-fault repair ownership** `repairGovernance.mjs`: a new `module_fault` outcome, decided FIRST. A defect whose implicated files are all platform-owned is platform remediation or a versioned module upgrade, never an application patch. Reaching the generated-app default with a list of module paths is how a model is asked to patch code it may not write, after which the write guard reports that as an application failure.
- **The rule is "all", not "any".** A screen that misuses a module is still the screen's defect, and withholding that repair would leave a real fault unfixed. Contract-invalid and platform-provider outcomes still win where they applied before.

## Compatibility

- A build with no lock gets the legacy projection unchanged. A tree composed before the facade
  existed cannot import from it, so it is not told to.
- Every repair ownership outcome that existed before is unchanged.

## Shared-layer defect found and fixed

The honesty scan treated `setTimeout` inside platform modules as "a fake loading delay standing in
for a backend call". In generated code that finding is right; in the platform runtime the timer is
a real retry backoff or poll interval. Every build composing the WP13 modules therefore tripped a
hard honesty finding and entered a correction loop over code the model may not even write — the
same shape as the WP7 static-gate defect, and the same fix: the platform boundary is now stated
identically in `honestyScan`, `staticApplicationGate`, `moduleContracts`, `persistenceLint`,
`wizardEntryTransform` and `repairGovernance`.

## Tests

`builder-v2-compact-generation.test.mjs` (7): the projection read from composed bytes with parity
and no private paths; a measured size reduction with the delta arithmetic checked; an unlocked
build keeping the legacy brief; a locked prompt carrying the public ABI and still naming the
facade exports; platform-only defects classified as module faults across runtime, composed, facade
and backend paths; mixed and application-only defects keeping the application repair; and the
ownership vocabulary.

## Defect found by live qualification, 2026-09-20

The first live build (`51da3b63-3dfd-41c1-b48a-274bb170efbc`, landing + contact) blocked after
2.77 credits with the candidate correction patch still invalid. The proximate error:

    src/screens/scaffold/HomeScreen.jsx (4:9): "makeContactForm" is not exported by
    "src/lib/capabilities/composed/contact.js"

The root cause was in this projection, not in the model. The brief listed only `src/lib/app`
facades while announcing itself as "the whole platform surface this application has", and closed
by telling the model never to import from `lib/capabilities`. The contact capability has no
facade: it exists only at `composed/contact.js`. So for a contact form the brief was not merely
incomplete, it was unfollowable — the one path to the capability was the one path it forbade. The
model guessed the registry's factory name `makeContactForm`, which the composed module does not
export (it exports the pre-wired `contactCapability`), then tried to patch the protected composed
file to make the guess true, was refused by the write guard, and the build ended blocked.

**Fix, in two halves.** The brief now names composed modules that have no facade, with the exact
path and real exports, and its closing line permits precisely the paths it has just listed.

The first attempt at that got the second half wrong: it decided "has no facade" by comparing
filenames, which promoted `composed/crud.js`, `composed/session.js` and `composed/roles.js` into
the brief. Those are not facade-less at all — the `entities`, `identity` and `accounts` facades
absorbed them under different names. The brief would have offered private plumbing on one line and
called it private on the next, and it grew 40% doing so. Coverage is now a fact the composer
records when it assembles a facade (`under(...)` in `capabilityFiles`, plus `FACADE_SUPERSEDES`
for the three legacy modules a later facade absorbed), never a guess from a path.

Net effect on the representative locked build: 1411 → 1006 characters, ratio against the legacy
brief 0.645 (it was 0.454 while the brief was incomplete, and 0.904 while it named the privates).
Completeness was never really in tension with compactness here; naming private plumbing was waste.

**Why no deterministic test caught it.** Every WP14 test asserted over a contract whose
capabilities all have facades, so the facade-less path was never exercised. Two tests now cover
both halves: a contact-shaped contract proving the capability is named with an importable path and
that `makeContactForm` appears nowhere, and a facade-covered contract proving `crud`, `session`,
`roles`, `authorization` and `admin` modules stay unnamed while their exports remain reachable
through the facades.
