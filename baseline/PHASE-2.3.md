# Phase 2.3 — prompt caching (cache-friendly request shaping)

_Recorded 2026-06-29T12:49:09.050Z · model `gpt-5.5` · edit format **`apply_patch`** + cache-friendly shaping ON._

**Investigation result: prompt caching IS live on the reverse-engineered Codex-OAuth transport**
(`chatgpt.com/backend-api/codex/responses`). A direct probe reused **85%** of a stable
>1024-token prefix from cache, automatically, with **no** `prompt_cache_key` (setting one
actually suppressed hits to 0 here — the opposite of its public-API behaviour). Cache hits are
reported in `usage.input_tokens_details.cached_tokens`; cached input is billed at a large
discount (ASSUMED 10% of input rate).

The lever: keep the prompt prefix **byte-stable** and history **append-only** so the backend
serves repeated input from cache. The up-front context block (manifest + relevant-file contents)
is computed **once** from the initial tree and **frozen** — never regenerated — so `instructions`
is identical every turn; history is **not** pruned. This is the *opposite* trade-off to Phase 2.2,
which minimises raw input by regenerating a live context block and pruning history — that mutates
the prefix every turn and gets ~0 cache hits. `--cache` and `--ctx` are therefore alternatives.

## Headline vs 2.2 (£0.0063/turn over 6 turns = £0.0376 total, 3/3 green)

- **Reliability:** 3/3 cases green — floor held ✅.
- **Cache hit rate:** 12.7% of input (2560/20215 tok) served from cache.
- **£-if-metered:** £0.0054/turn · £0.0430 total over 8 turns (cached input discounted).

**Verdict: caching is VERIFIED LIVE, but cache-friendly shaping did NOT beat 2.2 on total £ on this short-session harness — reliability held 3/3 and £/turn fell (£0.0054 vs £0.0063), but it took more turns (8 vs 6) and write-propagation latency left the two 2-turn cases at 0 hits, so the total bill rose (£0.0430 vs £0.0376). 2.2 stays the DEFAULT on the Codex path; `--cache` is retained as opt-in and is the lever for the BYOK adapter (where the cache has no latency penalty and `prompt_cache_key` works) and for long interactive sessions. Nothing regressed; nothing is force-shipped.**

## Per case

| case | result | turns | input tok | cached | hit% | out tok | £-if-metered |
|------|--------|-------|-----------|--------|------|---------|--------------|
| todo | GREEN | 4 | 12515 | 2560 | 20% | 1832 | £0.0246 |
| dashboard | GREEN | 2 | 4195 | 0 | 0% | 886 | £0.0111 |
| form-validation | GREEN | 2 | 3505 | 0 | 0% | 481 | £0.0073 |

## The provider asymmetry (for the Phase 4 credit model)

Caching benefits whichever provider serves it. On this Codex-OAuth path it is **live and free**
(no key, automatic). The future BYOK official-API adapter also caches (per OpenAI docs) and there
`prompt_cache_key` *does* help routing — so the cost-per-credit differs by provider and by request
shape. The edit tool (2.1) and context selection (2.2) are engine-level and help every provider;
caching (2.3) is a per-provider cost lever layered on top.

## Caveats

- **Single-pass per case.** gpt-5.5 is nondeterministic; reliability is one run per case.
- **Cache writes have propagation latency on this transport.** A cold prefix written on turn 1
  may not be readable a second or two later (observed in the probe: immediate back-to-back missed,
  but the same prefix hit minutes later). So short, few-turn harness cases can **under-show** the
  hit rate a longer interactive session would get. Treat the harness number as a floor.
- **No `prompt_cache_key` on the Codex path** — it suppressed hits in the probe; the passthrough
  exists in the provider for the BYOK adapter only.
- **Cost is hypothetical** — ASSUMED gpt-5.5 rates (incl. the 10% cached multiplier) in
  `src/cost.mjs`; everything was FREE on the ChatGPT sub.
