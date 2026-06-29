# Phase 2.4 — model router (the router, and only the router)

_Recorded 2026-06-29T21:43:38.702Z · provider **anthropic** · router strong=`claude-sonnet-4-6` cheap=`claude-haiku-4-5` · edit tool `apply_patch` · input strategy `--ctx`._

The router is a **selection layer ABOVE the provider seam**: a routing provider
(`src/providers/routingProvider.mjs`) that asks the pure policy (`src/router/router.mjs`
`chooseModel`) which model to use, then delegates `runTurn` to it. `runAgent`, the tools, the
prompts and the cost model are **untouched** — the router never reaches into the engine. On the
single-model Codex lane it is a **thin pass-through** (nothing to route); the abstraction bites on
the multi-model Anthropic side, measured here.

**The encoded finding (`baseline/ANTHROPIC.md`):** a cheaper model with weaker `apply_patch`
adherence falls back to full `write_file` rewrites, and a rewrite emits far more output than a
patch — so routing an edit to a cheap model only pays *if it still patches cleanly*. The policy
prices this (cost-aware `auto`); this run **measures it for real**.

## A/B — all-strong vs routed-cheap-edits (REAL Anthropic spend, paired single-pass)

| run | edit route | reliability | £/turn | total £ | input tok | output tok | patch out | rewrite out | clean applies | fallbacks |
|-----|-----------|-------------|--------|---------|-----------|------------|-----------|-------------|---------------|-----------|
| **A — all-strong** | `claude-sonnet-4-6` (`--route=strong`) | 3/3 | £0.0227 | £0.1813 | 34929 | 8315 | 1000 | 6729 | 0/2 | 0 |
| **B — routed** | `claude-haiku-4-5` (`--route=cheap-edits`) | 3/3 | £0.0050 | £0.1096 | 94396 | 8863 | 5931 | 2343 | 11/15 | 1 |

- **Reliability (the floor):** B = 3/3 — held ✅. (The Phase-2.1 `write_file` fallback is the safety net behind any failed cheap-model patch.)
- **Total £:** B DOWN ✅ vs A (£0.1096 vs £0.1813 = 40% lower). £/turn down.
- **Did fallbacks eat the saving?** 26% of claude-haiku-4-5's output went to full `write_file` rewrites (1 fallback(s) on 15 patch attempt(s)). They trimmed the saving but did not erase it.

**Verdict: routing edits to claude-haiku-4-5 HELD 3/3 and cut total £ by 40% vs all-claude-sonnet-4-6 — routing pays on the Anthropic path even with claude-haiku-4-5's weaker apply_patch adherence (1 fallback(s); 26% of its output went to rewrites, which trimmed but did not erase the saving). Eligible to ship as the edit route, with the write_file fallback as the reliability floor.**

## Measured adherence → what `auto` decides now (prior → measure → calibrate)

The catalogue seeded `claude-haiku-4-5` with a **prior** apply_patch adherence. This run **measured**
**73%** (clean applies ÷ patch attempts = 11/15).
Feeding that back into the pure `auto` policy, it would route an edit to:

> **claude-haiku-4-5** — auto: edit -> cheap claude-haiku-4-5 (E[$]=0.01520 < strong claude-sonnet-4-6 0.04680; cheap adherence 0.7333333333333333, expected out 1240 tok incl. fallbacks)

This closes the loop: the policy's edit decision is no longer a guess, it's grounded in a real
adherence number. (Update `MODEL_CAPS["claude-haiku-4-5"].patchAdherence` to 0.73 to make `auto` reflect it by default.)

## Per case (B — routed)

| case | route | result | turns | output tok | clean applies | fallbacks | write_file | £ (REAL) |
|------|-------|--------|-------|------------|---------------|-----------|-----------|----------|
| todo | claude-haiku-4-5 | GREEN | 9 | 5630 | 3/5 | 1 | 1 | £0.0619 |
| dashboard | claude-haiku-4-5 | GREEN | 8 | 1937 | 5/6 | 0 | 0 | £0.0303 |
| form-validation | claude-haiku-4-5 | GREEN | 5 | 1296 | 3/4 | 0 | 0 | £0.0174 |

## Scope + caveats

- **Router only.** No `search_replace`-vs-`apply_patch` A/B and no extended thinking this session
  (both flagged as separate future work; the router needs neither).
- **Single-intent harness.** Every case is an edit, so the route is uniform per run and telemetry
  prices it exactly at one model's rates. A future *mixed-intent* task switching models mid-run would
  need per-turn rate plumbing in telemetry — a seam extension, not built here.
- **Single-pass per case;** the model is nondeterministic — A and B are one paired run each.
- **£ is REAL** — published Anthropic rates in `src/cost.mjs`; these runs spent money on the key.
- **Generation route is policy-proven, not live-measured here** — the harness has no from-scratch
  generation case; `auto`/`cheap-edits` both keep generation on the strong model by construction.
