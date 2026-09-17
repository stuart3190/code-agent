# Builder V2 verifier audit — structured evidence only (2026-09-16)

Scope: `shell/server/lib/appBuild/journeyVerifier.mjs` (5.5k lines), `verifierPolicy.mjs`, and the one
downstream reader of verdict classes, `builderV2/verificationDefects.mjs`. Generation, contracts, routing,
repair, billing, workers, sandboxing and deployment were not modified in this audit.

Intended philosophy: can the required control be found; can it be activated; did the action happen; did the
expected state change; does persisted state survive reload; is access denied where required. Nothing else.

## 1. Every fuzzy / prose-inferred verdict path found

Line numbers are pre-audit. "False positive" means a CORRECT application could be failed purely by wording.

| # | Function (line) | Condition that produced red | Evidence class | False positive possible | Retained build where it fired |
|---|---|---|---|---|---|
| 1 | `expectationOutcome` minimal branch (4250-4273) | `found/wanted < 0.5` over `keywords(expect,5)` matched page-wide → APP_FUNCTIONAL_FAILURE; read-only arm → PLATFORM_INCONCLUSIVE | prose keywords, page-wide text scan | YES — the largest surface | every retained attempt's non-pass observation steps; auth-flow test fixture ("expected editor, workspace…; found email, account") |
| 2 | `runStep` (3817) | `keywords(expect)` empty → "the expectation named nothing findable" → undriveable | prose | YES | — |
| 3 | `runStep` auth flow-entry (3282-3299) | `waitForFreshExpectation` (≥50 % keywords, ≥1 fresh) else "did not produce the required signed-in state" | prose freshness | YES | 6833295, 46aab6c step 2 |
| 4 | `drivePrerequisites` (4664-4686) | producer replay requires `expectationBecameVisible(flow.observable)` AND a commit; prose half → "did not reach its contracted observable state" → whole consumer journey NOT_REACHED | prose freshness | YES | f8e2281 ×7 (new plan form) |
| 5 | `waitForAutoAdvanceEvidence`/`selectionTransition` (1631-1651, 2058-2062) | selection advanced to next control but ≥50 % expectation words absent → fail | prose | YES | — |
| 6 | `recoveryEvidenceVerdict` (2617-2631) via `durableStatusWords` | any of the mutation step's prose keywords absent after reload → PERSISTENCE_FAILURE | prose | YES | ca48824 ("recovered state no longer shows: status") |
| 7 | `expectationOutcome` collection membership (4220-4234) | region ranked by `keywords(spec.collection)`; unresolved generic member → fail | prose region ranking | YES (region not found) | — |
| 8 | `runStep` detail-surface observation (2983-2999) | prose nouns "summary/badges/list" → structural counts (≥2 badges, ≥20-char `<p>`) → APP_FUNCTIONAL_FAILURE | prose-armed thresholds | YES | — |
| 9 | `runStep` single-column layout (3907-3959) | prose "stacked in one column" → invented geometry thresholds → fail | prose-armed thresholds | YES | — |
| 10 | `runStep` product regexes (3592-3640) | "download all working export formats", "undo and redo", "open version history", "open duplicate" → literal button names → undriveable | hard-coded labels | YES | — |
| 11 | `driveExplicitAuthenticationAction` (2820-2839) | sign-out control found only by label `/sign out/`; public entry by `/sign in|create account|sign up/` | label vocabulary | YES ("Log out", "Get started") | f8e2281 ("no visible Sign out control was offered") |
| 12 | `activateContractedControl` fallback (2144-2164), `fillContractedFields` ladder (1137-1170), `driveKeyboardFocus` (1214-1239) | identity-less controls located by alias/label guessing | label guessing | only when the contract gives no machine identity | — |
| 13 | `runStep` focus-only arming (`isKeyboardFocusOnlyStep`) | action containing "tab" without a value verb diverts the step | prose arming | YES | — |
| 14 | `driveSelection` legacy group scoring (2262-2313) | group chosen by `keywords(target+action+expect)` against rendered text | prose | legacy contracts only | — |
| 15 | legacy `expectationOutcome` (4301-4331) | ratio / freshness / "nothing changed" verdicts | prose | YES | historical builds only (policy `legacy_rich_v1`) |
| 16 | `reviewValuesForStep` `/exact/` fallback, `openedARoute` `/open|go to/` fallback, `navigational` fallback, `commits` `/submit|send|…/` fallback | untyped-contract arming | prose arming | only for contracts that typed nothing | — |

Structured rules (unchanged, still the negative controls): machine identity resolution (`data-thrallo-control` /
`data-thrallo-action`), native value acceptance and validity, selection transition on aria/data-state,
flow-advance arrival on the contracted next control, durable value/reference recovery, review of exact entered
values, invalid-value acceptance, access leak of private values, fatal runtime errors, HTTP 429 platform signal,
prerequisite producer graph, deadlines.

## 2. Removed or constrained (production policy `minimal_contract_v1`)

- **#1, #2 — principal verdict.** `expectationOutcome` now routes to `structuredStepVerdict`. The verdict is
  decided only by structured checks: contracted route reached (`routeMatchesCurrent`), contracted values visible
  (step `reads` / `verificationValues`), contract-declared `visibleText`, collection member present (members are
  entered/selected/literal identities; an unlocated region is inconclusive), removal/reset measured on controls,
  mutation or action fired through its contracted control with a surface change (or entered values / next control),
  flow entry exposing the contract's next control, input accepted, selection transitioned or established. Prose
  words are recorded as the advisory `expectation_prose_unobserved` only. A step with no structured check is
  **CONTRACT_INCOMPLETE** (new class; status `undriveable`, not app-repairable, routed as a contract defect).
- **#3** — signed-in state is `waitForSignedInSurface`: route changed, credential form closed, or next contracted
  control visible. The credential driver is also keyed on the AUTHENTICATE-typed action (0a79523 stopped deriving a
  flow_start door, which had silently disabled it; bisected on a pre-session worktree).
- **#4** — the producer replay accepts the committed identity (entered value rendered, new durable reference, or
  contracted member present); the observable's words are evidence only.
- **#5** — the contract's next control being visible is the advance; a terminal selection whose group unmounted and
  whose surface changed is a proven transition.
- **#6** — `durableStatusWords` excludes indicator-kind nouns and is captured only when the record carries a
  declared status: the flow writes `*.durable.status`, or the entity declares a `status|state|stage|lifecycle` field
  (`entitiesDeclaringStatus`). Values and references remain the primary recovery evidence.
- **#7** — member identities must be structured; a collection region that cannot be located yields
  PLATFORM_INCONCLUSIVE, never an application failure.
- **#8** — not applied under the production policy (a detail observation is judged like any other step).
- **#9** — retained: the verdict is measured geometry (region widths, overlap, vertical order); only its arming
  reads the contract's explicit "single column" wording. (An interim version of this audit disabled it; the
  viewport browser suite proved the geometry negative control load-bearing and it was restored.)
- **Owning-form submission** — when the driver submits a contracted input's owning form (a sign-in with only an
  input declared), the submission is a structured check proven by the surface change it caused; a form that
  stays put fails (`builder-v2-contracted-auth-browser`).
- **Declared outcome precedence** — when every declared outcome (route, values, visible text, member, removal,
  reset) is present, an action that repainted nothing still reached its result; without any declared outcome a
  fired action needs a surface change, and gets the `action_outcome_undeclared` advisory.
- **Load-on-arrival read operations** — accepted only when the contract's declared outcome (`visibleText` or
  entered values it reads) is on the surface; the prose gate is gone (`builder-v2-passive-operations`).
- **Committed identity freshness** — the producer replay's committed identity is an entered value the commit
  NEWLY rendered (absent before, present after); a task form filled with the project's own title can no longer
  conceal a commit that stored nothing (`builder-v2-prerequisite-replay`).
- **#10** — disabled under the production policy.
- **#11** — sign-out is driven through its contracted action identity first; label fallback widened to "log out".
- Access denial extracted as `accessDenialVerdict` (pure) — unchanged semantics, exact private values only.

## 3. Fuzzy paths intentionally retained, and why

- **Label/alias locators as fallback (#12)** — only reached when a control has no machine identity, which the
  current derivation always provides. They can only find more, never fail an identified control.
- **Status-word recovery (#6, constrained)** — retained because the adversarial matrix proves it load-bearing
  (a Confirmed record reloading as Cancelled). It now fires only for records whose contract declares a status.
- **Prose arming for untyped contracts (#13, #14, #16)** — historical contracts that typed nothing; every
  Builder V2 contract is typed, so these do not run for it.
- **Legacy policy (#15)** — historical verdicts keep the policy that produced them; not used by Builder V2.
- **Product regexes (#10) under legacy only.**

## 4. Tests added / changed

- `test/code-agent/builder-v2-verifier-structured-evidence.test.mjs` (new, pure): reload with correct value but
  missing prose keyword ⇒ PASS; wrong persisted value ⇒ FAIL; membership without a literal phrase ⇒ PASS; missing
  created record ⇒ FAIL; dead button ⇒ FAIL; wrong route ⇒ FAIL (+ `routeMatchesCurrent`); unauthorized access ⇒
  FAIL; contract lacking a structured outcome ⇒ CONTRACT_INCOMPLETE (words present or absent); undriven step ⇒
  inconclusive; selection proven by next control.
- `test/code-agent/builder-v2-persistence-recovery-corpus.test.mjs` (new): the retained ca48824 reload evidence.
- `test/code-agent/builder-v2-minimal-contract-verifier.test.mjs` (browser): prose-only observation and detail
  cases now assert CONTRACT_INCOMPLETE; visible-text declaration cases added (pass and fail); "wrong state
  transition" and "missing filter result" now declare `visibleText`; a dead button beside static "saved" copy is
  a failure; parent budget raised to 900 s (60 real-browser cases).

## 5. Verifier suite result

Final run (`--test-concurrency=1`, real Chromium): `builder-v2-minimal-contract-verifier`, `builder-v2-adversarial-matrix`,
`builder-v2-auth-flow`, `builder-v2-defect-routing`, `journey-verifier-auth-on-current-surface`,
`journey-verifier-account-form-input`, `builder-v2-verifier-structured-evidence`, `builder-v2-persistence-recovery-corpus`:
**141 tests, 141 pass, 0 fail** (log: scratchpad `verifier-browser-final.log`).

Before the audit the same set stood at 111/124 (13 prose-driven or cascade failures), and `builder-v2-auth-flow` had
been red since 0a79523 (bisected: pass at c804749, pass at c804749+46aab6c, fail at 0a79523).

## 6. Can a correct generated app still be failed solely because of incidental prose wording?

**No** under `minimal_contract_v1`: no verdict path reads the action/expect sentence, except the status-word
recovery rule for records whose contract declares a status field, where the word is a declared lifecycle state.
Under the historical `legacy_rich_v1` policy, yes (unchanged by design).
