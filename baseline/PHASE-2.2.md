# Phase 2.2 — context selection (input-side lever)

_Recorded 2026-06-29T10:03:04.752Z · model `gpt-5.5` · edit format **`apply_patch`** + context selection ON._

The lever: stop re-sending every accumulated file read and patch blob every turn. Carry a
paths-only **manifest** plus the **current contents of just the relevant files** (seeded from
`src/App.jsx` + its direct deps, grown as the model touches files) in the regenerated system
prompt, and **prune** the redundant copies out of the replayed history. The block also tells
the model not to re-read files already shown — so it patches directly instead of spending a
read turn. Output is untouched (same `apply_patch` edit path as 2.1), so the win is input-side.

## Headline vs 2.1 (26071 in-tok over 14 turns, 3/3 green)

- **Reliability:** 3/3 cases green — floor held ✅.
- **Total input:** 14206 tok over 6 turns vs 26071 over 14 (2.1) = **46% lower** — the real bill (context selection also cuts turn count).
- **Input tokens/turn:** 2368 vs 1862 (2.1) = -27% lower _(per-turn is confounded by the turn-count drop)_.
- **Output tokens/turn:** 463 vs 244 (2.1) — edit path unchanged, so this should roughly hold.

## Per case

| case | result | turns | input tok | in/turn | 2.1 in/turn | out tok |
|------|--------|-------|-----------|---------|-------------|---------|
| todo | GREEN | 2 | 6148 | 3074 | 2518 | 1507 |
| dashboard | GREEN | 2 | 4389 | 2195 | 1517 | 778 |
| form-validation | GREEN | 2 | 3669 | 1835 | 1224 | 492 |

## Caveats

- **Single-pass per case.** gpt-5.5 is nondeterministic; reliability is one run per case here.
- **Total input is the gate, not per-turn.** Context selection also cuts turn count (the model
  patches directly instead of spending list/read turns), which pushes per-turn input *up* even
  as the total bill falls. The total is the real cost; per-turn is reported for context.
- **Cost is hypothetical** — ASSUMED gpt-5.5 rates in `src/cost.mjs`; everything was FREE on the
  ChatGPT sub.
