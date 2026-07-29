# Phase 4 (LIVE) — Stripe + the Supabase credit ledger, proven end-to-end

_Recorded 2026-06-30. Makes the Phase 4 billing DESIGN (`PHASE-4-BILLING.md`) **live**: the append-only
credit ledger runs on Supabase with owner-scoped RLS, and Stripe (TEST MODE) drives grants, top-ups and
entitlement sync. Every credit figure comes from `src/billing/costModel.mjs` — the single source of
truth — and is asserted against it. `costModel.mjs` itself was only extended (one derived export),
never re-derived._

## Artifacts

| file | what |
|---|---|
| `migrations/credit_ledger.sql` | the §8 schema verbatim + a `customers` entitlement table; append-only, owner-scoped RLS, **no update/delete policy** (immutable by construction) |
| `src/billing/ledger.mjs` | ledger SDK: `getBalance` (Σ delta), `debit` (pre-turn balance check + per-tier hard ceiling + bundle-first split), `grant`, `rolloverJob` (breakeven-capped), `setEntitlement` |
| `src/billing/stripe.mjs` | tier→price map, checkout (subs + top-ups), the **pure** `handleStripeEvent`, price↔model reconciliation |
| `src/billing/webhookServer.mjs` | production endpoint; verifies signatures with `STRIPE_WEBHOOK_SECRET` then dispatches to the same handler |
| `src/billing/costModel.mjs` | +`userHardCeilCredits(tier)` = tier breakeven (the hard ceiling, **derived**) — the only change |
| `harness/_ledger-tests.mjs` | 19 offline assertions: split / ceiling / rollover / idempotency via an in-memory Supabase fake |
| `harness/proveBilling.mjs` | the live end-to-end proof (opt-in, creds-required, **test-mode only**) |

Tests: `node harness/_billing-tests.mjs` (35/35) · `node harness/_ledger-tests.mjs` (19/19).
Live proof: `node harness/proveBilling.mjs` (creds in env; skips cleanly without them).

## The single source of truth holds

`ledger.mjs` and `stripe.mjs` import `creditsForTurn`, `modelWeight`, `breakeven`,
`bundleRolloverCapCredits`, `userHardCeilCredits`, `TIERS`, `TOPUP_GBP_PER_CREDIT` from `costModel.mjs`
and never recompute a price or weight. The proof's first step reconciles **Stripe's** live price amounts
against the model (`assertPricesMatchModel`) so the dashboard can't silently drift from the math.

## Ledger schema (live-verified)

Append-only by construction: balance is **never stored**, it is Σ delta. The SQL grants `select_own`
+ `insert_own` to `authenticated` and **no update/delete policy**, so rows are immutable. Platform
writes (webhook grants, the engine's debits, the expiry job) run with the **service_role** key
(bypasses RLS); the decisive end-user policy is `select_own`. A `(owner, ref, kind, bucket)` unique
index makes every grant/debit idempotent — a Stripe redelivery or a replayed turn no-ops at the DB.

The carry in `rolloverJob` is **floored** (not rounded) to 4 dp: rounding could nudge the post-grant
balance a hair (~1e-5) above breakeven, so flooring keeps `carried ≤ cap` and `carry + grant ≤ breakeven`
by construction.

## Live proof — what ran (Supabase project `qgemqjcyhuejrsvjxkbh`, Stripe TEST MODE)

All steps PASS. Real identifiers from the recorded run:

1. **SETUP** — Stripe prices reconcile with costModel: `starter:£12 pro:£40 studio:£120 topup:£0.12`.
2. **SIGNUP** — a real user via the generated app's own anon SDK factory; reads an empty ledger through
   their **own** session.
3. **GRANT** — a real test subscription (`sub_1ToAe4C6PoSrpLpGgYeIZtTf`, `active`) emitted a real
   `invoice.paid` (`evt_1ToAe7C6PoSrpLpGlxsdwcPH`). The event **passes Stripe signature verification**
   (`constructEvent` — the same path `webhookServer.mjs` uses) and a **wrong signing secret is rejected**.
   The handler granted the **Starter bundle = 120 cr** (cycle `2026-06`); the user read 120 cr back
   through their own session (RLS read works); entitlement synced to `starter`; a **redelivered**
   `invoice.paid` did **not** double-grant (still 120 cr).
4. **DEBIT** — a simulated turn of 10k Opus tokens debited **1.667 cr** (model weight 1.667, straight
   from `creditsForTurn`); balance dropped to exactly **118.333 cr**.
5. **WALL** — a 200-cr turn was **refused** (`insufficient_balance`, need 200 > 118.33) and wrote nothing.
6. **TOP-UP** — a real £36 PaymentIntent (test card) → `checkout.session.completed` → **+300 topup cr**;
   balance restored to **418.33** (bundle 118.33 + topup 300); the previously-refused turn now **succeeds**,
   spending **bundle-first** (118.33 bundle + 81.67 topup).
7. **CEILING** — with balance available (218.3 cr > the 104.2-cr turn), the turn is **refused by the
   per-tier hard ceiling** (`hard_ceiling`: this month's 201.7 + 104.2 > Starter breakeven 300.9) — the
   runaway-account guard, independent of balance.
8. **ROLLOVER** — the monthly job on a full Studio bundle **caps carry at 1009** (not the full 2000),
   expires the 991 remainder, and lands the post-grant bundle exactly on breakeven **3009 — never above**.
9. **ISOLATE** — a second user reads **0** of user A's ledger rows (owner-scoped RLS; denial = pass,
   the Phase 3.1 bar).

Cleanup runs at the end: the test subscription is cancelled, the test Stripe customer deleted, and
A's ledger + entitlement rows removed.

## Stripe wiring

- **3 tiers as subscriptions** (Starter/Pro/Studio) + **top-ups as one-off purchases**, priced per
  credit. Price IDs come from env (`STRIPE_PRICE_*`), keys from env only — never logged or committed.
- **`handleStripeEvent` is pure** (parsed event in → ledger writes out): `invoice.paid` /
  `invoice.payment_succeeded` grant the tier bundle for the cycle and sync entitlement;
  `checkout.session.completed` (mode `payment`) grants top-up credits; `customer.subscription.deleted`
  clears the entitlement tier. Idempotency is keyed on the stable Stripe id (`invoice:<id>` /
  `session:<id>`), so redelivery is safe.
- **`webhookServer.mjs`** is the production deployment target; point
  `stripe listen --forward-to localhost:4242/webhook` at it. The live proof exercises the **same
  handler** with real events without needing the CLI running.

## Secrets / scope

Test mode only — `proveBilling.mjs` **refuses** any key that isn't `sk_test_…`. All creds (Supabase
URL/anon/service_role, Stripe secret + price IDs) are read from `process.env`; `.env*` is gitignored.
Not built here: a hosted checkout UI, proration/plan-change flows, dunning. The ledger, the Stripe
event→grant pipeline, entitlement sync, and the guardrails (balance, per-tier ceiling, breakeven-capped
rollover, RLS isolation) are proven live.
