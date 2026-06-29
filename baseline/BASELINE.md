# Phase 2 baseline — full-file-rewrite engine

_Recorded 2026-06-29T06:40:45.237Z · model `gpt-5.5` · engine: full-file rewrite (`write_file` only), the Phase 1 proven path._

This is the line every Phase 2 optimisation must beat **on cost without dropping on reliability**.

## Headline

- **Reliability:** 3/3 cases green (100%).
- **£-if-metered per turn:** £0.0051 (ASSUMED gpt-5.5 rates — no public price; all FREE on the ChatGPT sub).
- **Totals:** 12 turns · 23932 blended tokens · £0.0615 if metered.

## Per case

| case | result | build | prior kept | new present | turns | in tok | out tok | total tok | £/turn |
|------|--------|-------|------------|-------------|-------|--------|---------|-----------|--------|
| todo | GREEN | ok | 4/4 | 2/2 | 4 | 7651 | 2516 | 10167 | £0.0069 |
| dashboard | GREEN | ok | 3/3 | 2/2 | 4 | 5708 | 1622 | 7330 | £0.0046 |
| form-validation | GREEN | ok | 3/3 | 2/2 | 4 | 5097 | 1338 | 6435 | £0.0039 |

## Caveats

- **Single-pass.** gpt-5.5 is nondeterministic; this reliability score is one run. A reliability *band* (repeat runs) is a future session.
- **Coarse assertions.** Build-passes + named-marker presence — the proven Phase 1 bar. Catches feature deletion and new-feature presence, not deep semantics.
- **Cost is hypothetical.** £ figures use clearly-labelled ASSUMED gpt-5.5 input/output rates in `src/cost.mjs`. Swap when a real metered rate is locked.
