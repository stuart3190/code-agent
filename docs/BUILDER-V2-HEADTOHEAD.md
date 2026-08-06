# Builder v1 vs v2 — the measured head-to-head (2026-08-06)

All numbers are MEASURED from production diagnostics (canonical creditsForUsage path,
Codex lane, gpt-5.5). The comparison prompt is the stored Berry Brook Farm booking fixture
(diag 689e49e1) — the exact prompt v1 was instrumented on. WP-11 is PARKED, not exited:
attempt 4 waits until WP-12's cost work lands (decision 2026-08-06, this doc is the
interim report the gate requires).

## The same booking prompt, both builders

| run | builder | credits | outcome | died on |
|---|---|---|---|---|
| cf130c23 | v1 + PR1-7 | 24.26 | blocked | verification |
| 178f7fc8 | v1 + acceptance stages | 46.10 | blocked | verification, 3 repair loops |
| 17b6513f | v1 + modular scaffold | 32.65 | blocked | verification (honesty clean) |
| 1e682279 | v2 attempt 1 | 6.02 | blocked | 2 verifier driving gaps + auth-lane 500 |
| d1d33ff5 | v2 attempt 2 | 3.88 | blocked | blind compile brief + unpatchable CSS |
| b4d2b704 | v2 attempt 3 | 3.68 | blocked | import-as-symbol + duplicate default |
| 3e0e318a | v2 attempt 4 | 3.69 | aborted | infrastructure: provider stream terminated mid-repair |
| 580f4477 | v2 attempt 5 | 9.29 | ceiling stop | repair regressed working selection state, thrashed to the 9cr guard |

v1 three attempts: **102.9 credits, zero green, zero page-level progress between runs.**
v2 five attempts: **26.56 credits (3.9× less than v1 for 5 runs vs 3), the platform-defect
classes all closed, the guard proven live (attempt 5 is the first ceiling stop in v2 history).** Attempt 1 reached 5/7
essential journey steps (date+slot selection passing semantically) and its recovered tree
drives END-TO-END green by hand (wizard → counters → submit → visitor auth → entities 201
→ confirmation) — the app was buildable; the platform's eyes and hands were the gap.

## The completed gates

| gate | target | measured | outcome |
|---|---|---|---|
| WP-9 simple first-green | ≤2 cr | **1.73** | GREEN (attempt 7; snapshot promoted, C4 live) |
| WP-10 edit | ≤0.5 cr | 1.64 | GREEN (variance: monolith context ×2 rounds, 0 cached) |
| WP-11 booking core | ≤6 cr | not yet green | parked at 13.58 over 3 attempts |

Arc total 25.97 credits vs ~25 projected for all three gates. Context: v1's single
CHEAPEST attempt at the booking prompt (24.26) bought one blocked run; v2's entire arc —
two green gates plus three progressively-deeper booking attempts — cost about the same.

## What the spend actually bought (each class regression-tested, most benefit v1 too)

1. No-op patch batches → deterministic rejection before any gate cycle.
2. Verifier keyword contract → v1's transition brief w/ exact expectationKeywords in every
   patch prompt.
3. Capability method misuse (`contactForm.submit`) → D1 usage lint, drift-guarded.
4. Capability bypass / sessionless writes → owned-entity + sessionless-mutation lint.
5. Verifier driving: form-submit priority, control-before-prose locator ordering,
   counter/stepper semantics, 20s submit poll, section-jumps navigational.
6. **The fill-vs-navigated bug: every combined "enter … then submit" step in v1's entire
   history filled the form and never clicked submit.**
7. Blind briefs → compiler stderr excerpts ride every repair prompt.
8. Patch vocabulary: `add_import` (imports are lines, not symbols), `replaceFile` (opaque
   files were unpatchable), duplicate-default rejection at apply time.
9. app-auth v3: visitor signup idempotent under races (the 500 class), transient-retry,
   platform egress exempt from the per-IP cap, cap 10→30/h (broke NAT'd venues too).

## The gate's conclusion (2026-08-06, after 5 attempts)

Every remaining booking failure is MODEL-SIDE: hand-rolled multi-step wizard selection
state (aria/data-state wiring) breaking under repair pressure — attempt 5's repair
regressed a passing date selector. No platform defect has surfaced since attempt 3. The
verifier calibrations demonstrably work (form fill, terms, counters, date/slot selection
all pass when the app wires state correctly). RECOMMENDATION: roll v2 out for the SIMPLE
profile on the strength of the green WP-9/10 gates (that is WP-16's plan anyway); close
the booking gap with a composable booking-wizard piece in the scaffold's ui/ library so
selection-state wiring is assembly, not invention — then re-run this gate once, cheaply.

## Why attempt 4 waited for WP-12

Attempt cost is now dominated by context (14-15k in/run, ≤52% cached) and taught rounds.
WP-12 lands retrieval-sliced repair/edit context and better prefix reuse — the same fixes
the WP-10 variance analysis called for — so the next booking attempt runs with materially
cheaper rounds. The remaining failure surface after 9 closed classes is small; the two
model-miss classes that consumed attempt 3 are now free rejections.
