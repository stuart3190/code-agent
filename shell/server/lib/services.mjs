// Compose the PROVEN billing layers over the server's service-role client, ONCE.
// This module reuses src/billing/{ledger,stripe}.mjs verbatim — it does not re-derive a
// price, a weight, or a ceiling. Live keys allowed since the 2026-07-08 go-live flip
// (STRIPE-LIVE.md §4); proveBilling.mjs still enforces sk_test_ for its own runs.

import Stripe from "stripe";
import { createLedger } from "../../../src/billing/ledger.mjs";
import { createBilling } from "../../../src/billing/stripe.mjs";
import { serviceClient } from "./supabase.mjs";
import { requireEnv, optionalEnv } from "./env.mjs";

let _ledger = null;
export function ledger() {
  if (_ledger) return _ledger;
  _ledger = createLedger(serviceClient());
  return _ledger;
}

let _stripe = null;
export function stripe() {
  if (_stripe) return _stripe;
  const key = requireEnv("STRIPE_SECRET_KEY");
  if (!key.startsWith("sk_")) {
    throw new Error("Refusing to start: STRIPE_SECRET_KEY is not a Stripe secret key (must start with sk_).");
  }
  _stripe = new Stripe(key);
  return _stripe;
}

let _billing = null;
export function billing() {
  if (_billing) return _billing;
  _billing = createBilling({ stripe: stripe(), ledger: ledger() });
  return _billing;
}

export function haveStripeEnv() {
  return !!(optionalEnv("STRIPE_SECRET_KEY") && optionalEnv("STRIPE_PRICE_STARTER"));
}
