# Simple Counter build 69f47bf4: a control named "Reset" read as a reset request (2026-09-24)

## The run

- Work job `6254234b-cfd4-491a-8d7f-88fbfc45c21a`, public build `8d6d1b74-7d36-47dc-a069-4dd9b9a7ab3d`,
  internal build `69f47bf4-fdb3-4e90-909f-954b6cd4f260`, project `fe2de4ab-e230-40e7-a83d-5eba98cfcf61`
  ("Simple Counter", profile `simple`, policy `minimal_contract_v1`, release `e83d4ef`).
- Queued 08:22:42Z, leased within 1 s, failed 08:32:28Z: 9 min 46 s, 6.97 of 12 approved credits
  (1.85 customer generation, 5.12 Thrallo-funded repair). Customer message:
  "Thrallo could not produce a verified preview" (`contracted_journeys_red`).

| stage | wall time | outcome |
| --- | --- | --- |
| contract (gpt-5.5, one call) | 47 s | 3 journeys, 1 entity, 3 operations, validated `basic_static` |
| capability preflight + scaffold composition (includes foundation compile) | 23 s | ok |
| core generation (one call) | 69 s | HomeScreen + 3 custom extensions, 0 static failures |
| browser verification pass 1 | 81 s | decrease-counter PASS; increase-counter and reset-counter FAIL at step 0 |
| repair 1 `exact_owning_file_repair` + verify | 110 s | defect set identical |
| repair 2 `causal_dependency_repair` + verify | 98 s | defect set identical |
| repair 3 `owner_module_regeneration` + verify | 135 s | defect set identical; ladder stops (3/11 rounds) |

Nothing stalled: every model call and browser pass completed in normal time, the sandbox
provenance check passed, and the queue lease was immediate. Six of the ten minutes were spent
repairing an application that was not broken.

## The first actual failure

Both red journeys failed on their opening step, `open the counter page`, whose expectation is
"the centered Simple Counter screen is visible with the counter starting at 0 and the Increase
(+1), Decrease (-1), and Reset buttons visible". The recorded page state shows exactly that
screen. The verdict was "the contracted control did not return to its default".

`expectationRequestsControlReset` tested `${action} ${expect}` with `\breset(?:s|ted|ting)?\b`;
the noun "Reset" in "Reset buttons visible" matched. `structuredStepVerdict` then required a
native control's non-default -> default transition. The page has no `input`, `textarea` or `select`
at all, so `controlResetTransition` reported `{ checked: false, ok: false }` and the check failed.
decrease-counter's opening step does not mention the Reset button, which is why it passed.

The generated HomeScreen (snapshot `2f676fea`) is a correct counter: local state, three buttons
carrying the contracted machine identities, +1 / -1 / 0. Replaying the retained contract in the
sandbox image against a page mirroring that screen reproduces the verdict byte for byte with the
e83d4ef verifier (`increase-counter` and `reset-counter` fail at step 1 with the same detail,
`decrease-counter` passes).

Classification: verifier false failure (platform), not a generation failure and not an
infrastructure stall. The same heuristic was independently hit on 2026-09-22 by the downlight
audit ("preferred spacing is blank" in a Calculate action), recorded in
`docs/evidence/downlight-20260922/HANDOFF.md`, finding 4.

## The fix (journeyVerifier.mjs)

1. `expectationRequestsControlReset` removes named controls ("Reset button", "Clear control", ...)
   before looking for reset language. "returns to 0", "resets to zero", "is blank" still count.
2. An observation-only step never expects a reset transition: nothing was driven, so nothing can
   return to a default.
3. `structuredStepVerdict` receives `resetChecked`. A reset the page cannot carry in a native
   control is judged on the contract's other declared outcome (visible text, values, member state)
   or on the surface change the action produced. A measurable native control that stayed
   non-default with nothing else declared is still a red reset, as before.

## Proof

- `builder-v2-minimal-contract-verifier.test.mjs`: unit rules for the named-control heuristic and
  the unmeasurable-reset verdict; a browser replay of the retained counter contract
  (`test/code-agent/fixtures/retained/simple-20260924-counter/contract.json`) that is green
  against a working counter and red on the Reset step against a Reset button that leaves the value
  alone (dead-Reset control), with the opening steps green in both cases.
- The same replay against the unmodified e83d4ef tree fails exactly as production did.

Known limit left as is: `visibleText` is a whole-page substring check, so a dead Increase button is
not caught when "1" appears elsewhere on the page ("Increase (+1)"). That is contract quality, not
this defect, and is tracked by the downlight audit's structured-outcome work.
