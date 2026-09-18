# Generation-envelope calibration (recessed-light rerun 675d2a73, 2026-09-17)

Source: `test/code-agent/fixtures/retained/medium-20260917-recessed/measured-calls.json` (provider usage per call, diag_steps). Pinned by `test/code-agent/builder-v2-generation-envelope.test.mjs`.

## What failed

- The medium core envelope is 9 credits = 90,000 tokens per call; core reserves 16,000 output tokens, so the input estimate must be <= 74,000.
- The full core prompt's wire (system prompt + user prompt + tool schema) was 275,912 bytes. The previous estimator (`bytes / 3 * 1.2 + 512`, i.e. 2.5 bytes per token) declared it 110,877 tokens; the provider's own usage on the same build's prompts is 4.02-4.87 bytes per token, so the real figure was ~63k.
- "maximum fitting output 0" forced twelve isolated headroom batches; a screen was generated with no imports (three `React.*` references), the project detail screen stayed a placeholder, corrections were fragmented in turn, and the build blocked at 40.29 credits before the browser.
- Corrections were worse: the four-screen module correction rendered the raw scoped capability graph (438k bytes) and every scoped interaction flow (197k bytes) - a 753k-byte prompt, estimated 316,254 tokens - so every correction was fragmented too.

## Measured calls (exact wire) and the two estimators

| seq | dispatch | system prompt | wire bytes | actual input tokens | bytes/token | previous estimate / actual | new estimate / actual |
|---|---|---|---|---|---|---|---|
| 2 | headroom_continuation | headroom_fragment | 185,984 | 40,788 | 4.56 | 1.84x | 1.21x |
| 3 | headroom_continuation | headroom_fragment | 96,403 | 23,409 | 4.12 | 1.67x | 1.11x |
| 4 | headroom_continuation | headroom_fragment | 74,548 | 18,075 | 4.12 | 1.68x | 1.11x |
| 5 | structural_modularity | core | 35,925 | 7,992 | 4.50 | 1.86x | 1.25x |
| 6 | headroom_continuation | headroom_fragment | 70,806 | 17,554 | 4.03 | 1.64x | 1.09x |
| 7 | headroom_continuation | headroom_fragment | 122,274 | 27,174 | 4.50 | 1.82x | 1.20x |
| 8 | micro_repair | headroom_fragment | 5,606 | 1,152 | 4.87 | 2.39x | 1.73x |
| 9 | micro_repair | headroom_fragment | 4,500 | 927 | 4.85 | 2.49x | 1.83x |
| 10 | headroom_continuation | headroom_fragment | 172,534 | 37,895 | 4.55 | 1.83x | 1.21x |
| 11 | headroom_continuation | headroom_fragment | 120,015 | 28,575 | 4.20 | 1.70x | 1.12x |
| 12 | scaffold_mount | core | 14,330 | 3,174 | 4.51 | 1.97x | 1.35x |
| 13 | headroom_continuation | headroom_fragment | 74,924 | 18,148 | 4.13 | 1.68x | 1.11x |
| 14 | headroom_continuation | headroom_fragment | 186,477 | 41,198 | 4.53 | 1.82x | 1.20x |
| 15 | headroom_continuation | headroom_fragment | 155,586 | 34,307 | 4.54 | 1.83x | 1.21x |
| 16 | headroom_continuation | headroom_fragment | 69,395 | 17,259 | 4.02 | 1.64x | 1.09x |
| 17 | micro_repair | headroom_fragment | 6,519 | 1,346 | 4.84 | 2.32x | 1.66x |
| 18 | micro_repair | headroom_fragment | 6,394 | 1,325 | 4.83 | 2.32x | 1.66x |

New estimator: `ceil(wire bytes / 3.8) + 512`. Smallest margin on any retained call 1.09x; on calls >= 20k wire bytes 1.09-1.25x. Previous estimator on calls >= 60k wire bytes: 1.64-1.84x.

## Why 3.8 and not 3.5

- At 3.5 the retained core estimates 79,344 tokens: with 16,000 output that is 95,344 > 90,000, so the retained build would still fragment. 3.6 gives 77,155 and 3.7 gives 75,083 - both still over 74,000.
- 3.8 gives 73,121 (+16,000 = 89,121 <= 90,000): one full-context core call, full output retained. Offline render of the same core today: 275,409 wire bytes, 72,989 tokens.
- 3.8 is still below the densest measured wire (4.02 bytes per token), so no retained call is underestimated; the 512 framing tokens sit on top of that margin.
- The margin is deliberately thin because the medium envelope is the binding constraint, not the estimator: a medium core wire above ~279k bytes would fragment again. The levers if that happens are the prompt's largest sections (interaction contract 88k, per-module contracts 62k, capability graph 55k in the core prompt), not the divisor.

## Correction dispatches

- A bounded dispatch (module correction, targeted repair) now carries the bounded capability-graph brief and only the interaction flows its write boundary owns or its findings name - what headroom continuations always carried.
- The retained four-screen correction (candidate core-2 85406063) renders at 258,541 bytes, estimated 71,187 tokens (+16,000 = 87,187 <= 90,000): one bounded call instead of resize 1 (2 modules) -> resize 2 (1 module) fragments.
- Deterministic React import rewrite (`rewriteMissingReactImports`, applied by `preprocessCandidateTree` before every static verdict): candidate core-4 e1b99789 goes from 4 blocking findings to 1 (the genuine `journey_surface_unreachable`), with no model call.
