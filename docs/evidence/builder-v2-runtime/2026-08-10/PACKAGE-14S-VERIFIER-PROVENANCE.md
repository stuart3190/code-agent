# Package 14S — the verifier that graded production is four commits behind

Date: 2026-08-10 UTC · Read-only production inspection · Zero provider calls · Nothing deployed

## The finding

Browser verification does **not** run the repository's `journeyVerifier.mjs`, and has not for
several days. `runtimeComposition.mjs` dispatches a `browser_verify` job; the build worker runs it
inside a Docker sandbox (`build-worker/sandboxRunner.mjs`), and production pins that sandbox by
digest:

```
/etc/thrallo/build-worker.env
  THRALLO_BUILD_SANDBOX=docker
  THRALLO_BUILD_SANDBOX_IMAGE=sha256:22479a5d35d67de42e1844168c5aee0de2ffc10f61420553371982c672df9089
```

That digest is `thrallo-build-sandbox:0d5999c672fe`, **built 2026-08-07T19:04:34Z**. The
`journeyVerifier.mjs` baked into it is byte-identical (modulo CRLF) to commit **`b45a327`**
(2026-08-06) — LF-normalised sha256 prefix `9e3019e2b90a6e78`.

A newer image exists on the host (`thrallo-build-sandbox:latest`, built 2026-08-09T20:23:43Z,
carrying `d7f27f1`), but the pin means it has never been used.

Consequently **every verifier change since 2026-08-06 has never executed in a live
qualification**:

| Commit | Date | What production never ran |
|---|---|---|
| `d7f27f1` | 08-09 | contracted-control driving (`fillContractedFields`); stop-after-failed-step (`blockedBy`) |
| `92de017` | 08-09 | shared `controlIdentity` vocabulary |
| `804272c` | 08-10 | `useSemanticSelection` driveability alignment |
| `3b5a523` | 08-10 | review-step freshness exemption |

Two independent contradictions in the retained evidence pointed here before the image was opened,
and both are explained exactly by `b45a327`:

1. Step 6 of the live journey was `undriveable`, yet steps 7-10 still ran. `blockedBy` did not
   exist yet.
2. The contact step failed with the generic message `could not drive: …` rather than
   `contracted control(s) could not be driven: …`. Contracted-control driving did not exist yet.

**This is why four rounds of deterministic debugging produced misleading conclusions.** Fixtures
built against the repository ran code production does not run. Any conclusion drawn that way —
including the ones behind `d7f27f1`, `92de017`, `804272c` and `3b5a523` — was untested against
the artefact that actually grades builds.

## What the graded verifier actually did

Retained evidence: build `449cf290-587a-4d12-982c-703ffd40d3e1`, project
`f4036301-cf26-462c-b433-7342f342c586`, window 2026-08-10T09:07:39Z – 09:17:10Z, evidence dir
`/home/ubuntu/thrallo-deploy-evidence/package14s-terminal-20260810T0910Z`. Both browser passes
(core and post-repair) agree:

| # | Step | Verdict | Detail |
|---|---|---|---|
| 3 | select a dinner date | pass | `found: selected, date, visually, highlighted, slot` |
| 4 | select an available slot | **pass (false)** | `selection moved from "Friday 18 October…" to "Saturday 19 October…"` |
| 5 | choose a party size | **pass (false)** | `selection moved from "Saturday 19 October…" to "Friday 18 October…"` |
| 6 | enter guest name, email, phone | undriveable | `could not drive: …` |
| 7 | review the booking | fail | `nothing changed — "selected, date, slot" was already on the page…` |

Steps 4 and 5 drove the **date** group, ping-ponging between the same two date options. `slotId`
and `partySize` were never written. Contact stayed value-gated behind the party step, so the
review had nothing to show and every downstream step failed.

The mechanism is `driveSelection`'s group scorer: it picks a group by counting how many words of
the step's prose appear in the group container's rendered **text**. The generated app rendered the
expectation prose inside the selected date option ("selected date visually highlighted"), so the
date group out-scored the real slot and party groups on their own steps. `selectionTransition`
then passed both, because selection genuinely moved — inside the wrong group.

The application was not the primary defect. The verifier drove the wrong control, twice, and
called it green.

## Reproduction

`test/code-agent/builder-v2-live-shaped-harness.test.mjs` — zero-model, real Vite build, real
Chromium, the real `verifyJourneys` entry point, the retained contract and its retained derived
interaction contract, and the vendored graded artefact
(`test/code-agent/fixtures/live-journeyVerifier-b45a327.mjs`).

It reproduces steps 1-7 of the live transcript exactly, including both false passes and their
verbatim details. The retained evidence is committed at
`test/code-agent/fixtures/live-booking-2026-08-10T0910Z.json`.

## Operational consequence

The sandbox image pin is a deployment defect in its own right: shell-side code and sandbox-side
code drift silently, and nothing in the pipeline reports the skew. Until it is addressed, **no
verifier change can be assumed live**, and a live qualification proves the behaviour of whatever
`THRALLO_BUILD_SANDBOX_IMAGE` happens to point at.

Rebuilding and re-pinning the sandbox image is a prerequisite for the next live qualification. It
is not done here: this session had read-only production access and did not deploy.
