# Package 14S contact-driveability repair

Date: 2026-08-09

Scope: zero-model retained-evidence diagnosis and generic interaction contract/verifier repair.

## Retained evidence boundary

The production evidence directory contained `state.json` and `evidence.jsonl`. Cleanup had already
removed generated snapshot/blob source bytes, preview filesystem materialisation, DOM/HTML,
screenshots, and browser traces. The exact original and repaired `BookingFlow.jsx` bytes therefore
cannot be reconstructed honestly from this evidence.

The durable browser evidence is nevertheless conclusive about the first causal failure:

- date: the verifier selected `Friday 14 February 2026`;
- slot: the verifier moved the same option group to `Friday 21 February 2026`;
- party: the verifier moved that same option group back to `Friday 14 February 2026`;
- contact: no visible form control was driveable;
- confirmation and reload ran afterward even though contact had blocked the primary journey.

For name, email, and phone, the retained evidence proves only that no control was visible/driveable
at the attempted step. Element type, input type, name, id, label, ARIA name, disabled/read-only
state, value binding, handler, and state destination were not retained and are recorded as unknown,
not inferred.

## Root cause

The interaction contract was built and structurally linted before generation, but the production
runtime sent the browser worker only `{ journeys: [journey] }`. The machine-readable interaction
facts were dropped. The verifier then guessed selection groups from broad English keywords, chose
the date option group for slot and party, and never advanced the application to its contact step.

Classification:

- E, verifier locator grammar/integration: confirmed;
- F, interaction contract insufficiently transported to runtime verification: confirmed;
- G, repair diagnostics insufficient: confirmed;
- A-D (missing, inaccessible, non-editable, or incorrectly bound generated contact controls): not
  provable from the retained artifacts because those controls were never reached and source/DOM was
  no longer present.

The old interaction planner also emitted duplicate semantic requirements (`dateId`, `dateLabel`,
`date`; `guestName`, `name`; and similar compatibility fields). Those aliases now collapse to one
logical control while retaining all locator aliases.

## Repair

- Preserve the scoped interaction contract through orchestrator, production composition, worker,
  and browser-verifier boundaries.
- Drive selection groups by contracted logical identity, not broad prose.
- Drive each contracted form field with precedence: role/accessibility name, associated label,
  name/id, then placeholder fallback.
- Capture attempted locators and rendered control facts (element/type/name/id/labels/ARIA,
  visibility, editable/disabled/read-only state, expected and observed values).
- Require an accessible, editable control with compatible input type and a source-backed state
  connection before browser verification when it can be proven statically.
- Accept standards-compliant label/htmlFor, wrapped-label, aria-label, and aria-labelledby naming;
  styling and layout remain unrestricted.
- Require exact entered values to appear in a contracted review.
- Mark all steps after the first causal failure `not_reached`; they are excluded from repair defects.
- Include browser control evidence plus source file/line/span facts in targeted repair diagnostics.
- Strengthen generic generation guidance for contact, checkout, authentication, CRM, settings, and
  wizard forms without introducing a booking template.

## Deterministic replay

A real Vite/React candidate reproducing the retained evidence shape was compiled and served to the
same Playwright verifier.

1. With the pre-repair runtime payload (interaction facts omitted), slot reused the date group,
   contact remained hidden/undriveable, and review was `not_reached`.
2. With the repaired scoped interaction contract, the same compiled bytes drove the date, slot,
   and party groups independently; drove name, email, and phone; observed the exact filled values;
   and proved all three exact values in the review.

This replay does not claim to be the deleted production source. It reproduces the retained causal
shape and exercises the same verifier against a real compiled application.

## Validation

- Focused/relevant Package 14S, verifier, orchestrator, runtime composition, and verification tests:
  111/111 passed.
- Real retained-shape Vite compilation: passed.
- Real Playwright failed-shape replay: passed (failure reproduced).
- Real Playwright corrected replay: passed.
- Provider/model calls: zero.
- Production mutation: none.
