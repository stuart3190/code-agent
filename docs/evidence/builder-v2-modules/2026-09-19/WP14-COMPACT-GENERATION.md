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
