# WP12 — Billing and entitlements (2026-09-19)

The audit's requirement: idempotent webhook lifecycle and entitlement enforcement, with generated
billing state logic removed. Generated billing was wrong in ways that cost money in both
directions.

## Architectural change

- **Entitlements** `src/lib/modules/billing.js`: a declared plan catalogue, and decisions made from the SERVER's subscription state. A client-held `plan` field is a plan anybody can set, and more commonly one that is simply stale, so nothing here consults one. Every denial carries a reason and the plans that would allow it, so an upgrade prompt names something real.
- **The lifecycle is a status, not a boolean.** `isSubscribed` collapsed trialing, active, past_due, cancelled-but-paid-until and expired into one bit. Each answers differently now: a failed card keeps access, because a payment problem is not a reason to lock someone out of their own data that hour; a cancelled subscription keeps what it paid for until the period it paid for ends, because cutting access at the moment of cancellation is taking money for time not served.
- **Limits are enforced where the work happens.** `require()` and `requireWithin()` are the calls a mutation makes, counting what is actually stored. A limit enforced by disabling a button is not enforced at all: the create call underneath never knew about it.
- **Service** `supabase/functions/app-accounts/billingService.mjs`: idempotent by event id — providers retry, and twenty deliveries of one event change the state once. Order-safe by the provider's own timestamp — a cancellation emitted at 10:00 arriving after a payment emitted at 10:05 is recorded and IGNORED, rather than downgrading a customer who has just paid. An event whose type, status or product the service does not recognise is recorded and ignored rather than guessed at.
- **Storage** migration `20260919120000_app_subscriptions.sql` (additive, idempotent, unapplied): `app_subscriptions` and `app_billing_events`, both deny-all RLS and service-role only. The event table's primary key IS the idempotence guarantee, and an append-only trigger keeps the trail readable, because a billing dispute needs something that cannot be rewritten.
- **SDK**: `accounts.subscription()` reads the derived state. There is deliberately no write path, and the client ABI has no operation that applies a billing event.

## What is claimed, and what is not

This is the narrowest derivation in the compiler, because guessing here decides what a customer's
customers are charged. A plan exists only where the contract declares one — an explicit `billing.plans`
section, or a plan entity carrying features, limits or a price. "Premium fixtures" is a product
line and is never read as a pricing tier. A project plan with dates and tasks is a schedule and
stays a domain record.

Product ids are never invented: they belong to a deployment's own provider account. A plan with no
configured product cannot start a checkout, and the module says so rather than sending someone to
a provider error.

Billing is availability-gated. Without the payments service the build blocks rather than shipping
a checkout button that fails.

## Compatibility

- Thrallo's own billing is untouched. This is storage and logic for generated applications'
  subscriptions, in their own tables.
- Nothing in the coverage contacts a payment provider. The service is exercised over its storage
  seam, exactly as the account and platform-state services are.
- A contract with no plan catalogue composes exactly as before and locks no billing module.
- Coverage ledger: formats `billingPlan: 1` and `billingService: 1`.

## One defect found while writing the coverage

Two provider events can carry the same timestamp — a cancellation and a creation emitted in the
same second — and the history sort had only that one key, so the order of a billing trail differed
between two reads of it. Arrival order is now the tie-break, and the suite asserts that two reads
agree.

## Tests

`builder-v2-billing-entitlements.test.mjs` (10): each lifecycle status answering differently,
including past_due keeping access and cancelled keeping it until the paid period ends; denials
naming the plans that would allow them; an undeclared feature raised as a wiring error rather than
a silent false; limits counting stored usage, an uncapped plan distinguished from a zero cap, and
an undeclared limit not denying; enforcement at the mutation with a billing outage falling back to
the declared default plan; five repeat deliveries of one event changing nothing; an out-of-order
cancellation ignored with the trail recording it and two reads agreeing; unknown types, statuses
and products recorded rather than guessed at; a member reading their own subscription and refused
another's; the catalogue declared rather than inferred from prose; composition with a protected
facade; and the availability gate with a negative control.
