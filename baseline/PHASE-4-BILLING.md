# Phase 4 — Billing: cost model, tiers & credit ledger (DESIGN + MODEL)

_Recorded 2026-06-30 · **design + math only** — no Stripe, no live ledger, no network. Pure logic
that runs anywhere (`node scripts/billing-model.mjs`). Stripe integration + the live Supabase ledger
are the NEXT session._

This phase turns the retired technical risks (reliable generation on two providers, isolated
multi-tenant backend, measured sandboxed runtime) into a **business layer**: what a credit costs us,
what we charge for it, and how the ledger accounts for it. Every figure traces to a recorded
baseline; the three ASSUMED inputs are flagged explicitly.

## Artifacts

| file | what |
|---|---|
| `src/billing/costModel.mjs` | pure module — cost-per-credit, model weights, runtime cost, floor, tiers, breakeven |
| `scripts/billing-model.mjs` | runnable — plug numbers in, print the whole model (output reproduced below) |
| `harness/_billing-tests.mjs` | 21 offline assertions — formula vs recorded spend, floor never breached, £/credit strictly decreasing, weights bound Opus |

Run: `node scripts/billing-model.mjs` · Test: `node harness/_billing-tests.mjs` (21/21 green).

---

## 1 · The credit unit

**1 credit = 10,000 blended tokens** (locked in `src/cost.mjs` `TOKENS_PER_CREDIT` and the build
plan). A **fixed token bucket**, never "1 turn = 1 credit" — turns vary wildly in tokens (the harness
saw 2–9 turns per case), so a token bucket keeps cost-per-credit flat regardless of routing or app
complexity. At the measured Sonnet rate a credit costs us ~£0.04 and retails at £0.06–0.12, so it's a
sensible meter granularity ("X credits left ≈ £Y of building").

The blended-token shape is **measured**: `ANTHROPIC.json --ctx` recorded input 37,469 / output 7,671
→ **output = 17% of blended**. Fed through the published rates this blend reproduces the recorded
£0.0398/credit *exactly* (asserted in the tests), so the formula is validated against real spend.

## 2 · Cost-per-credit by path (REAL measured)

| path | £/credit | basis |
|---|---|---|
| BYOK (user's key) | **£0.0000** | inference on the user's key — ~£0 to us |
| Managed Sonnet, **uncached** | **£0.0398** | formula, validated to REAL `ANTHROPIC.json --ctx` |
| Managed Sonnet, cached | £0.0312 | REAL spend — `--cache` (caching cuts ~22%) |
| Router cheap-edits (Haiku) | £0.0106 | REAL spend — `PHASE-2.4` routed (£0.1096 / 10.33 credits) |
| Codex gpt-5.5 | £0.0257 | **ASSUMED** rates, FREE on the ChatGPT sub |

We price the floor against the **conservative worst case — uncached Sonnet, £0.0398**. Caching and
cheap-edit routing put *real* blended cost below it; that gap is margin cushion, not exposure.

## 3 · Model weights — the move that makes the floor hold

A naive "1 credit = 10k raw tokens" **breaks on Opus**: 10k Opus tokens cost **£0.0664**, which
exceeds the £0.06 Studio price → that tier would be underwater on any Opus-heavy session.

Fix: **debit credits = (tokens / 10k) × modelWeight**, where weight normalizes a model's blended
$/token to Sonnet = 1.0 (computed from the published rates, not hand-set):

| model | weight | raw 10k-token cost | per **debited** credit |
|---|---|---|---|
| claude-sonnet-4-6 (anchor) | 1.000 | £0.0398 | £0.0398 |
| claude-haiku-4-5 | 0.333 | £0.0133 | £0.0398 |
| claude-opus-4-8 | 1.667 | £0.0664 | £0.0398 |

After weighting, **one debited credit always costs us ~£0.0398 regardless of which model served it** —
so the floor is a single number and every tier sits safely above it. The router already prices models,
so the weight is available at debit time. (Tests: unweighted Opus *would* breach £0.06; weighted it
lands at £0.0398.)

## 4 · Runtime cost (`RUNTIME.md` — measured capacity, one assumed price)

`RUNTIME.md` **measured** on 4 vCPU / 7.6 GB: idle RSS **118.1 MiB**/container, **RAM-bound**, **55
concurrent** previews, CPU negligible (0.57% peak). Idle strategy: **`docker stop` after ~10 min
idle** frees the full RSS, so only *actively-previewing* apps hold a slot.

The one number `RUNTIME.md` does **not** state is the box's £/month, so it's a knob:

- `VPS_GBP_PER_MONTH` = **£13** _(ASSUMED — realistic for 4 vCPU / 7.6 GB, e.g. Hetzner CPX31 ≈ £13)_
- £13 ÷ 55 slots = **£0.236 / always-on-slot-month**
- £13 ÷ 730 h ÷ 55 = **£0.000324 / preview-hour** (with reaping)
- Folded per credit @ 0.25 preview-h/credit _(ASSUMED)_ = **£0.00008/credit** — rounding error.

Runtime is negligible *per credit*, but it's the **dominant cost on the BYOK path** (where inference
is ~£0): an un-reaped always-on preview is £0.236/slot-month. The `docker stop` reaper + a
concurrency cap are what keep BYOK near-free to us.

## 5 · The floor

```
inference £0.0398 (uncached Sonnet, weighted -> bounded) + runtime £0.0001 = FLOOR £0.0399/credit
```

No retail £/credit may fall below this. The three managed tiers and the top-up all clear it.

## 6 · Tiers

Effective £/credit **drops as tiers rise** (volume discount) but **never below the £0.0399 floor**.
Bundled credits **reset** each cycle (roll over capped at 1× allotment); **top-ups roll over freely**
and are priced **above every bundle** so they're the margin valve on heavy users.

| tier | £/mo | bundle | eff £/credit | markup | gross margin | profit @ full burn | floor ok |
|---|---|---|---|---|---|---|---|
| **BYOK Dev** | £0 | — | — (user's key) | — | — | loss-leader, bounded | ✅ |
| **Starter** | £12 | 120 | £0.1000 | 2.51× | 60.1% | £7.21 | ✅ |
| **Pro** | £40 | 500 | £0.0800 | 2.01× | 50.1% | £20.06 | ✅ |
| **Studio** | £120 | 2000 | £0.0600 | 1.50× | 33.5% | £40.24 | ✅ |
| **Top-up** | — | £0.12/cr | £0.1200 | 3.01× | 66.8% | — | ✅ |

- Effective £/credit is **strictly decreasing**: £0.100 → £0.080 → £0.060. ✅ (asserted)
- "Profit @ full burn" = the tier fee minus the cost of serving *every* bundled credit at the floor —
  positive on all tiers, so even a user who exhausts the bundle is profitable.

### BYOK Dev — a bounded loss-leader

BYOK Dev is a **deliberate £0 loss-leader**: a developer acquisition on-ramp that feeds the managed
tier. The user's key pays inference (~£0 to us), so the only loss is **runtime**. We bound it with a
**concurrent-preview-slot cap**:

- **Free BYOK = 3 concurrent preview slots.** A box holds 55 slots (RUNTIME.md), so 3 slots back
  **~18 free developers per box** at full concurrency — enough to *build* (one app live + a reference),
  not enough to run a *farm* of always-on apps.
- **Worst-case runtime loss = 3 × £0.236 = £0.71/user/month** (every slot pinned always-on, no
  reaping). This is the eyes-open ceiling; the `docker stop` reaper makes the real figure far lower.
  At £0.71 worst-case, one Starter conversion (£7.21 profit) covers ~10 always-on free users.

## 7 · Breakeven, the top-up valve & the rollover cap

Breakeven credits = fee ÷ floor (where revenue = cost). Because bundles are **hard caps** and the
only way past them is top-ups (priced above the floor), the breakeven count sits **above** the bundle —
the tier **cannot go underwater on bundled credits** *in a single cycle*.

**Floor-protection: the rollover cap must enforce the breakeven.** Unused bundle may roll over, but a
fixed "1× allotment" cap is unsafe — it would let Studio bank 2000 carried + 2000 granted = **4000**
available bundle credits, **above** its 3009 breakeven, so a user could spend past breakeven on
bundled credits before top-ups ever kick in → the tier goes underwater. The fix: set each tier's
**rollover cap = breakeven − bundle**, so grant + carry can **never exceed breakeven**.

| tier | breakeven | bundle | rollover cap | max bundle balance | ≤ breakeven? | headroom |
|---|---|---|---|---|---|---|
| Starter | 301 | 120 | 181 | 301 | ✅ | 2.51× |
| Pro | 1003 | 500 | 503 | 1003 | ✅ | 2.01× |
| Studio | 3009 | 2000 | 1009 | 3009 | ✅ | 1.50× |

`max bundle balance = bundle + rollover cap == breakeven` on every tier (asserted in the tests), so a
user who banks the maximum rollover and burns it all lands exactly at break-even — never a loss. Past
that, the user buys top-ups at £0.12 (66.8% margin), so **heavier usage adds margin instead of eroding
it**. The headroom shrinks as tiers get cheaper-per-credit (2.51× → 1.50×) — the volume discount
showing up as a thinner but still-positive cap; the top-up valve backstops it on every tier.

---

## 8 · Credit ledger (schema design — lives in Supabase, NOT built live yet)

**Append-only.** Balance is never stored or mutated; it's the sum of immutable entries. Corrections
are compensating rows (`refund`/`adjust`), never updates or deletes. This gives a full audit trail and
makes retries safe via idempotency keys.

```sql
-- Supabase / Postgres. RLS owner-scoped exactly like Phase 3.1 `entities`.
create table public.credit_ledger (
  id        uuid primary key default gen_random_uuid(),
  owner     uuid not null default auth.uid(),       -- RLS subject (Phase 3.1 pattern)
  ts        timestamptz not null default now(),
  delta     numeric(14,4) not null,                 -- + grant / top-up, − debit / expire
  bucket    text not null check (bucket in ('bundle','topup')),
  kind      text not null check (kind in ('grant','debit','expire','refund','adjust')),
  model     text,                                   -- debit: which model (-> weight applied)
  tokens    integer,                                -- debit: raw blended tokens served
  weight    numeric(6,4),                           -- debit: model weight applied
  cycle     text,                                   -- bundle grants/expiry: billing period e.g. '2026-07'
  ref       text not null,                          -- stripe id / generation-turn id / idempotency key
  created_at timestamptz not null default now()
);
create unique index credit_ledger_ref_kind_uq on public.credit_ledger (owner, ref, kind);  -- idempotency
create index credit_ledger_owner_ts on public.credit_ledger (owner, ts);

-- RLS: append + read only. No update/delete policy is granted -> rows are immutable by construction.
alter table public.credit_ledger enable row level security;
create policy ledger_select_own on public.credit_ledger for select to authenticated using (owner = auth.uid());
create policy ledger_insert_own on public.credit_ledger for insert to authenticated with check (owner = auth.uid());
-- (no update/delete policies — corrections are new 'refund'/'adjust' rows)
```

**Balances** (computed, never stored):

```
bundle_balance = Σ delta where bucket = 'bundle'
topup_balance  = Σ delta where bucket = 'topup'
balance        = bundle_balance + topup_balance
```

**Debit order — bundle first (use-it-or-lose-it), then top-up (rolls freely).** A generation turn
debits `creditsForTurn({tokens, model})` (model-weighted). If it spans both buckets it writes **two
rows** (one per bucket) so every row stays single-bucket and the accounting is unambiguous:

```
need = creditsForTurn({tokens, model})            # e.g. 1.667 credits for 10k Opus tokens
fromBundle = min(need, bundle_balance)             # spend resetting credits first
fromTopup  = need − fromBundle                     # then rolling credits
-> insert debit(bucket='bundle', delta=−fromBundle, model, tokens, weight, ref=<turn id>)
-> insert debit(bucket='topup',  delta=−fromTopup,  model, tokens, weight, ref=<turn id>)
```

**Rollover rules** (monthly reconciliation job):

- **Bundle** resets each cycle. Carry up to the tier's **rollover cap = breakeven − bundle**
  (`bundleRolloverCapCredits(tier)`, §7) into the next cycle so that carry + next grant never exceeds
  breakeven; expire the remainder with an `expire` row (`bucket='bundle'`, negative delta,
  `cycle=<ending>`). Then write the next cycle's `grant`. The cap is **derived from the breakeven, not
  a fixed multiple** — this is what keeps a rollover-banking user from going underwater on bundled
  credits (e.g. Studio carries ≤ 1009, never 2000).
- **Top-up** never expires — no action.

**Pre-turn balance check + hard ceiling** (the runaway-account guardrail from the plan):

```
estimate = creditsForTurn({tokens: estTokens, model})
if (bundle_balance + topup_balance) < estimate           -> refuse the turn (or prompt to top up)
if monthly_debit_sum(owner) + estimate > USER_HARD_CEIL  -> refuse (per-user cost ceiling)
```

Idempotency: the `(owner, ref, kind)` unique index means re-running the same generation turn (same
`ref`) can't double-debit — a retry no-ops at the DB.

---

## 9 · Assumptions & missing numbers (flagged)

| # | assumption | default | how to retire |
|---|---|---|---|
| 1 | VPS £/month | £13 | `RUNTIME.md` gives capacity (55) but no price; confirm the real box bill |
| 2 | preview-hours per credit | 0.25 | instrument real preview-session durations once the runtime ships |
| 3 | Codex gpt-5.5 £/credit | £0.0257 | ASSUMED — no public price; FREE on the sub, so not a real bill anyway |
| 4 | tier prices / bundle sizes | as above | product decision — knobs in `TIERS`; the floor/monotonic checks re-run on any change |

All four are **knobs** in `src/billing/costModel.mjs`; changing one and re-running
`node scripts/billing-model.mjs` re-derives the tiers, floor check and breakevens, and
`node harness/_billing-tests.mjs` re-asserts the invariants.

## Scope / not built here

No Stripe, no live ledger writes, no Supabase calls, no entitlement sync, no provider-fallback logic.
This is the **model and the schema design**. Next session: Stripe (subscriptions + top-ups + webhooks)
and the live ledger on Supabase with the RLS above.
