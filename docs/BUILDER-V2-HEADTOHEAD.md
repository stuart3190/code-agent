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

v1 three attempts: **102.9 credits, zero green, zero page-level progress between runs.**
v2 three attempts: **13.58 credits (7.6× less), each failure a NEW class, each class now a
free deterministic rejection or a calibrated driver behaviour.** Attempt 1 reached 5/7
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

## Why attempt 4 waits for WP-12

Attempt cost is now dominated by context (14-15k in/run, ≤52% cached) and taught rounds.
WP-12 lands retrieval-sliced repair/edit context and better prefix reuse — the same fixes
the WP-10 variance analysis called for — so the next booking attempt runs with materially
cheaper rounds. The remaining failure surface after 9 closed classes is small; the two
model-miss classes that consumed attempt 3 are now free rejections.
