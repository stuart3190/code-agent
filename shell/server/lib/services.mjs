// Compose the PROVEN billing layers over the server's service-role client, ONCE.
// This module reuses src/billing/{ledger,stripe}.mjs verbatim — it does not re-derive a
// price, a weight, or a ceiling. Stripe is pinned to TEST MODE (sk_test_) defensively, the
// same guard proveBilling.mjs enforces.

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
  if (!key.startsWith("sk_test_")) {
    throw new Error("Refusing to start: STRIPE_SECRET_KEY is not a test key (must start with sk_test_).");
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
