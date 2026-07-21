// POST /api/stripe/webhook — verifies the Stripe signature, then hands the event to the PROVEN
// pure handler (src/billing/stripe.mjs handleStripeEvent), which grants bundle/top-up credits and
// syncs entitlement. Same path proveBilling.mjs + webhookServer.mjs exercise; idempotent at the DB.
//
// The raw request body (not JSON-parsed) is required for signature verification, so index.mjs routes
// this path with the raw buffer.

import { billing, stripe } from "../lib/services.mjs";
import { requireEnv } from "../lib/env.mjs";

export async function handleWebhook(req, res, rawBody) {
  const sig = req.headers["stripe-signature"];
  let event;
  try {
    event = stripe().webhooks.constructEvent(rawBody, sig, requireEnv("STRIPE_WEBHOOK_SECRET"));
  } catch (e) {
    console.error(`[stripe-webhook:signature] ${e?.message || e}`);
    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "signature verification failed" }));
  }
  try {
    const result = await billing().handleStripeEvent(event);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
  } catch (e) {
    console.error(`[stripe-webhook:handler] ${e?.stack || e}`);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "webhook processing failed" }));
  }
}
