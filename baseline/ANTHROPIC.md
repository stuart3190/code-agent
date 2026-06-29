# Anthropic BYOK adapter — first second-provider runs

_Recorded 2026-06-29 · provider **anthropic** · model `claude-sonnet-4-6` · **REAL** published rates._

The first BYOK adapter (`src/providers/anthropicProvider.mjs`) runs behind the **same**
`runTurn({systemPrompt, messages, tools}) -> {text, toolCalls, usage}` seam as the Codex provider.
The engine — `runAgent`, the tools, the prompts, and context selection (`src/engine/context.mjs`) —
is **byte-identical**; the adapter alone translates the neutral message/tool/usage shapes to and
from Anthropic's Messages API (system param, `tool_use`/`tool_result` content blocks, SSE streaming,
`cache_control`, usage fields). Unlike the FREE Codex sub path, these runs **spent real money** on
the user's key (~$0.28 total across both configs); £ figures use the **REAL published** Anthropic
rates in `src/cost.mjs` (`claude-sonnet-4-6`: $3/MTok in, $15/MTok out; cache-read 0.1×, cache-write 1.25×).

> Curated record of **both** harness configs (one live run each; the model is nondeterministic),
> like `BASELINE.md`. Re-run `node harness/run.mjs --provider=anthropic --edit=apply_patch --ctx|--cache`
> to regenerate per-config numbers into `ANTHROPIC.json`.

## Headline — the seam holds on a second provider

| config | reliability | £/turn (REAL) | total £ | total tok | cache-read hit | cache-write |
|--------|-------------|---------------|---------|-----------|----------------|-------------|
| `--ctx` (2.2 default) | **3/3 ✅** | £0.0200 | £0.1797 | 45140 | 0.0% | 0 |
| `--cache` (2.3) | **3/3 ✅** | **£0.0174** | **£0.1564** | 50111 | **53.8%** (22740/42238) | 19483 |

**The SAME regression harness passes 3/3 on Anthropic with the engine untouched** — the proof the
Phase-2 seam was real, not incidental to Codex. The adapter alone made it fit.

## The 2.3 "BYOK-only caching win" — verified for real

On Anthropic, `--cache` beats `--ctx` on **both** axes (the opposite of the Codex short-session result):

- **£/turn:** £0.0174 vs £0.0200 — **~13% lower**.
- **total £:** £0.1564 vs £0.1797 — **~13% lower**, *net of* the 1.25× cache-write premium on 19483 write tokens.
- **cache-read hit:** **53.8%** vs Codex's 12.7% on the identical harness.

This is exactly what `PHASE-2.3.md` predicted: Anthropic's `cache_control` works as documented, with
no write-propagation latency, and Sonnet's **2048-token** minimum cacheable prefix lets the short
harness cases actually cache. Caching is a **BYOK lever**, not a Codex-short-session win.

## Per case

### `--ctx` (2.2 context selection — cache-hostile default)
| case | result | turns | input tok | output tok | cache-read | cache-write | £ (REAL) |
|------|--------|-------|-----------|------------|------------|-------------|----------|
| todo | GREEN | 2 | 10643 | 3323 | 0 | 0 | £0.0646 |
| dashboard | GREEN | 3 | 11884 | 2253 | 0 | 0 | £0.0549 |
| form-validation | GREEN | 4 | 14942 | 2095 | 0 | 0 | £0.0602 |

### `--cache` (2.3 cache-friendly — stable prefix + append-only)
| case | result | turns | input tok | output tok | cache-read | cache-write | £ (REAL) |
|------|--------|-------|-----------|------------|------------|-------------|----------|
| todo | GREEN | 2 | 9879 | 3583 | 3306 | 6569 | £0.0627 |
| dashboard | GREEN | 3 | 13311 | 2233 | 7175 | 6131 | £0.0463 |
| form-validation | GREEN | 4 | 19048 | 2057 | 12259 | 6783 | £0.0474 |

## Per-provider cost-per-credit (for the Phase 4 credit model)

1 credit = 10k blended tokens. £/credit = total £ ÷ (total tok ÷ 10k):

| provider · config | £/credit | basis |
|-------------------|----------|-------|
| Anthropic Sonnet `--ctx` | **£0.0398** | REAL spend |
| Anthropic Sonnet `--cache` | **£0.0312** | REAL spend (caching cuts ~22%) |
| Codex gpt-5.5 baseline | £0.0257 | ASSUMED, FREE on the sub |

> Codex £ are ASSUMED (no public gpt-5.5 price) and FREE on the sub; Anthropic £ are REAL spend —
> **not comparable as bills.** What's comparable: **reliability parity** (all 3/3) and this
> **per-provider cost-per-credit asymmetry**, which feeds the Phase 4 credit definition.

## Findings carried forward

- **`apply_patch` adherence is provider-dependent.** Sonnet often emitted patches that failed exact
  match (`apply_patch FAILED → write_file` fallback fired on dashboard + form-validation), where
  gpt-5.5 is Codex-tuned for that format. **Reliability held 3/3 because the proven `write_file`
  fallback caught it** — the Phase-2.1 fallback earning its keep — but the edit-tool cost saving was
  partly lost to full rewrites. The `search_replace` format (Aider-style, more familiar to Claude)
  is a flagged A/B for the router session.
- **Extended thinking is OFF** in the adapter. Enabling it would require the engine to carry and
  replay `thinking` blocks across turns — a seam extension, out of scope for "adapter only, engine
  unchanged." Revisit alongside the 2.4 router.

## Caveats

- **Single-pass per config;** the model is nondeterministic — reliability is one run per case.
- **A 0 cache-write/read is a floor, not a ceiling** — a frozen prefix under the model's minimum
  (2048 tok for Sonnet, 4096 for Opus/Haiku) silently won't cache. A longer session caches more.
- **£ is REAL** — published Anthropic rates in `src/cost.mjs`; these runs spent money on the key.
