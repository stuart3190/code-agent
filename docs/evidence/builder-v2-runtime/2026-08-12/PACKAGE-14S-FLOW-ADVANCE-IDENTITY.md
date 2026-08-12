# Flow advance by machine identity — removing the last word list from the driving path

Date: 2026-08-12 UTC · Zero provider calls · No live qualification run · Package 15 still blocked

Closes the class-B blocker from live qualification #4: a correct application labelled its forward
button `Next to party size`, `ADVANCE_ACTION_PATTERN` did not contain that phrase, and the
party-size control two screens away was reported missing.

## What changed

| Layer | Before | After |
|---|---|---|
| Scaffold | forward button hand-written | `useFlowAdvance()` emits `data-thrallo-action="act_27cc737d"` |
| Contract | `flow_advance` had no control requirement | carries the canonical `ADVANCE_ACTION_ID` |
| Manifest | no advance action | `{ id, primitive: "advance", action: "activate", expectedNextControl }` |
| Verifier | word list only | declared identity first; word list is legacy-only and never consulted when an identity is present |
| Brief | forward control untaught | one 3-line assembly pattern, advertised only when a flow spans steps |

The model is never told an id: it names the control, both sides compute the same FNV-1a hash, which
is the same mechanism fields and selections already used.

### One adjacent generic defect, fixed narrowly

`driveSelection` discarded any group unless some option label was ≥3 characters — a guess about
UNIDENTIFIED groups, meant to skip `+`/`−` steppers. Party sizes are `2`, `4`, `6`. The group was
dropped before its contracted identity was ever read. A guess no longer overrules the contract:
the length heuristic is skipped for the group carrying the contracted machine identity. Behaviour
for unidentified groups is unchanged.

## Proof — one compiled app, eleven presentations, real Vite + Chromium

`builder-v2-flow-advance` — **18/18** (host and inside the pinned image).

| Presentation | Forward button | Result |
|---|---|---|
| `live` | `Next to party size` (the paid label) | journey passes, party-size step drives |
| `next` / `continue` | the words the old list did contain | identical |
| `arrow` / `icon` | `→` / `▸`, no words | identical |
| `french` | `Passer à la taille du groupe` | identical |
| `renamed` | `Bananas` | identical |
| `decoy` | real control `Bananas`, plus a visible `Next` that leads to an unrecoverable dead end | passes — proof the decoy was never clicked |
| `reordered` | as above, forward control FIRST in the DOM, decoy after | identical |
| `wrongIdentity` | right shape, right words, DIFFERENT machine id | **undriveable**, not accepted |
| `missing` | no forward control | **undriveable**, reported |

The decoy is the adversarial claim made structural: if wording or DOM order could steer the driver,
the flow would enter a screen the contracted controls never mount in again.

## Audit — remaining lexical matchers in the primary V2 driving path

Measured by instrumenting every branch that chooses a DOM element by text and counting entries
across booking, checkout, CRM, adversarial and flow-advance matrices.

| Matcher | Hits on V2 contracts with structured manifests |
|---|---|
| `ADVANCE_ACTION_PATTERN` (English advance words) | **0** |
| stepper domain vocabulary (`adults\|children\|guests\|party size`) | **0** — evaluated, never entered |
| review word (`/^\s*review\b/`) | **0** |
| last-visible-button guess | **0** |
| contract-alias activation | fallback only, and every string is contract-supplied |
| generic alias click | fallback only, contract-supplied |

The word list still fires for the deliberate `wrongIdentity`/`missing` negatives, which is the
legacy path doing its job and correctly failing. The three matrix fixtures were migrated to declare
their forward control, exactly as a generated application now does; all matrices stay green,
including the adversarial `dom-only-advance` defect, which is still caught.

The stepper vocabulary and the review word remain in the file as unreached V1 fallbacks. They are
the next candidates for removal, and neither is load-bearing for V2 today.

## Regressions

621 Builder V2 + package14 tests pass. `git diff --check` clean. Commit `f60873d`.

## Deployment

| | |
|---|---|
| Source commit | `f60873d` |
| Parity | 1232 tracked files hashed both sides — production == `f60873d` byte-for-byte |
| Image tag | `thrallo-build-sandbox:f60873d0be8b`, built 2026-08-12T08:50:17Z |
| Digest (pinned) | `sha256:9bf9466f8840ad395a45d542747565882789c3f715037159c5364e7f20bae30f` |
| Sandbox identity | `a7e4f030b31463f072aeaaa8d30d46e3722f1ace36fed575f5447696d8d4e69e` — host **and** image |
| Verifier hash | `d55463073a176223c3828e0cce8b49d9a448ab4ef3bdc8e630bb99d68fb486ed` — both |
| Skew guard | `compatible: true`, `sandboxBakedConsistent: true`, read from the worker's own EnvironmentFile |

Two files were added to `SANDBOX_IDENTITY_FILES`: the capabilities export barrel (a stale one makes
a new binding an unresolved import) and `capabilityRegistry.mjs` (an image whose prompt never
teaches the forward control produces apps the new verifier correctly calls undriveable).

In-image, from the pinned digest: **61/61** across the booking, checkout, CRM, adversarial,
live-shaped, generic-flow-navigation, opaque-identity, operand and operand-browser suites, plus
**18/18** flow-advance.

## Production preflight

`ops/prove-execution-first-preflight.mjs` — **20/20 GREEN**, "model dispatch is permitted".
Credentials were granted to that single process only; `/etc/thrallo/build-worker.env` was never
modified, so nothing had to be restored and zero qualification credential lines exist.

## Final state

`THRALLO_BUILD_JOB_TYPES=proof_slow,publish_package` · settlement paused · qualification authority
absent · shell, build worker and provisiond active · `thrallo.com/api/health` 200. Baseline
unchanged: **13 projects, 39 build jobs, 6 V2 builds, 0 active jobs**. No provider call, no
migration, no Stripe operation.

## Verdict

A live qualification is justified. The failure class that ended run #4 cannot recur: the browser
no longer needs to recognise any English word to reach a contracted control. It was not run, per
instruction.
