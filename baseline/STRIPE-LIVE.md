# Stripe test→live runbook (LAUNCH AUDIT item 1)

> Status **2026-07-08: LIVE — the flip is DONE and PROVEN.** Real £0.60 top-up checkout on the
> live key → live webhook verified → 5-credit ledger grant landed → refunded (re_3Tr3KaC6…) →
> ledger reversed (kind=refund row). `assertPricesMatchModel` PASSED on live from the VPS.
> Pin removed at services.mjs (now requires any sk_). Old test env backed up on the VPS as
> `shell/.env.pre-live-flip` (rollback = §6). Local shell/.env stays sk_test (dev only).
> Remaining niceties: subscription smoke (§5 last item — invoice.paid path unproven on live),
> product description still mentions the old SEO business, payout schedule still manual.

## 1. Live products + prices — DONE (2026-07-07)

Created in live mode on `acct_1T31YSC6PoSrpLpG` with lookup keys + tier metadata:

| Tier | Product | Price ID | Amount |
| --- | --- | --- | --- |
| Starter | `prod_UqAPvFXbSzkUft` | `price_1TqU4tC6PoSrpLpGgDCZrXr6` | £12/mo (1200p recurring) |
| Pro | `prod_UqAPStn1pn72tS` | `price_1TqU4vC6PoSrpLpGtOmhFcPE` | £40/mo (4000p recurring) |
| Studio | `prod_UqAPoH9vI0NgQ9` | `price_1TqU4wC6PoSrpLpGARKtzVXC` | £120/mo (12000p recurring) |
| Top-up | `prod_UqAPnAq4M57tXT` | `price_1TqU4xC6PoSrpLpGedBiZ5Gy` | £0.12/credit (12p one-time, qty = credits) |

Lookup keys: `buildr101_starter` / `buildr101_pro` / `buildr101_studio` / `buildr101_topup`.
Amounts come from `src/billing/costModel.mjs` (the single pricing truth — if the model ever
changes, create NEW prices; never edit these in the dashboard).

## 2. Dashboard housekeeping (Stuart, manual — MCP connector doesn't expose these)

> Audited live via the MCP account read 2026-07-08 (`GetAccountsAccount`) — statuses below.

- [x] **Dashboard display name** "Zataus" → "Buildr101" — DONE (confirmed 2026-07-08).
- [ ] **Statement descriptor** still `ZATAUS` (`settings.payments.statement_descriptor`) →
      `BUILDR101` (Settings → Public details). Shows on card statements.
- [ ] **Public business profile** still Zataus: `business_profile.name` = "Zataus", url =
      www.zataus.com, product description = "SEO and expired or expiring domain lists",
      support email EMPTY. Set name Buildr101, url https://buildr101.com, description to match
      the product, support email support@buildr101.com (address live as of 2026-07-08).
- [x] **Payouts** — VERIFIED OK 2026-07-08: payouts_enabled, individual verified, no outstanding
      requirements, GB bank (Revolut …9102) default for GBP. NOTE payout schedule is **manual** —
      switch to automatic (e.g. weekly) unless you want to trigger each payout yourself.
- [ ] Public **support contact + ToS/refund-policy URLs** in Stripe's public details — Stripe
      requires these to take live payments (legal pages are live: buildr101.com/terms /refunds).

## 3. Live webhook endpoint (dashboard — MCP doesn't expose webhook_endpoints)

- [ ] Dashboard (LIVE mode) → Developers → Webhooks → Add endpoint:
      `https://buildr101.com/api/stripe/webhook`
      Events (exactly what `handleWebhookEvent` consumes):
      `invoice.paid`, `invoice.payment_succeeded`, `checkout.session.completed`,
      `customer.subscription.deleted`
- [ ] Copy the endpoint's signing secret (`whsec_…`) for step 4.
      (The existing `we_1TqIZvC6PoSrpLpG` endpoint is TEST-mode; live mode needs its own.)

## 4. The flip (VPS env + code pin) — do steps 2–3 first

- [ ] Reveal the **live** `sk_live_…` at https://dashboard.stripe.com/acct_1T31YSC6PoSrpLpG/apikeys
      (goes in `~/Desktop/key.txt` custody, NEVER the repo).
- [ ] **Remove the sk_test safety pin** at `shell/server/lib/services.mjs:23` (it refuses live
      keys by design). One-line change; commit it as the flip commit.
- [ ] VPS `~/app-builder/shell/.env`: set
      `STRIPE_SECRET_KEY=sk_live_…` · `STRIPE_WEBHOOK_SECRET=<live whsec from step 3>` ·
      `STRIPE_PRICE_STARTER/PRO/STUDIO/TOPUP=` the four live price IDs above.
- [ ] `sudo systemctl restart buildr-shell` (env is read once at start).
- [ ] Local `shell/.env` stays on sk_test — local is dev only; keep the pin removed but the test
      key means local behavior is unchanged.

## 5. Verify on live

- [ ] `assertPricesMatchModel()` against live (needs the live key; run on the VPS):
      reconciles the four live prices against costModel — must pass before any real checkout.
- [ ] One real checkout end-to-end: smallest top-up with a real card → webhook fires →
      `credit_ledger` grant lands → refund via dashboard (or the MCP's create_refund).
- [ ] Subscription smoke: Starter checkout → invoice.paid grants 120 credits + entitlement →
      cancel immediately (no proration surprises; farm-proof switch logic already covers it).

## 6. Rollback

Set `STRIPE_SECRET_KEY` back to sk_test + test whsec + test price IDs, restart buildr-shell.
The live products/prices just sit unused (archive them in the dashboard if abandoning).
