// Phase 4 (LIVE) — the production Stripe webhook endpoint. Verifies each event's signature with the
// endpoint signing secret (STRIPE_WEBHOOK_SECRET) BEFORE trusting it, then dispatches to the pure
// handler in stripe.mjs. The live proof (harness/proveBilling.mjs) exercises the SAME handler with
// real test-mode events without needing this server running; this is what you deploy / point
// `stripe listen --forward-to localhost:PORT/webhook` at.
//
//   Run:  STRIPE_SECRET_KEY=… STRIPE_WEBHOOK_SECRET=… SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=…
//         STRIPE_PRICE_STARTER=… STRIPE_PRICE_PRO=… STRIPE_PRICE_STUDIO=… STRIPE_PRICE_TOPUP=…
//         node src/billing/webhookServer.mjs

import http from "node:http";

import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

import { createLedger } from "./ledger.mjs";
import { createBilling } from "./stripe.mjs";

const PORT = Number(process.env.PORT || 4242);

// Read the raw body — Stripe signature verification is over the EXACT bytes, so we must not re-encode.
function rawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export function createWebhookServer({ env = process.env } = {}) {
  const stripe = new Stripe(env.STRIPE_SECRET_KEY);
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY); // service-role: server writes
  const ledger = createLedger(supabase);
  const billing = createBilling({ stripe, ledger, env });
  const webhookSecret = env.STRIPE_WEBHOOK_SECRET;

  const server = http.createServer(async (req, res) => {
    if (req.method !== "POST" || !req.url.endsWith("/webhook")) {
      res.writeHead(404).end("not found");
      return;
    }
    let event;
    try {
      const body = await rawBody(req);
      const sig = req.headers["stripe-signature"];
      event = stripe.webhooks.constructEvent(body, sig, webhookSecret); // throws on bad/forged signature
    } catch (err) {
      res.writeHead(400).end(`signature verification failed: ${err.message}`);
      return;
    }
    try {
      const result = await billing.handleStripeEvent(event);
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
    } catch (err) {
      // 500 -> Stripe retries; the ledger's idempotency makes the retry safe.
      res.writeHead(500).end(`handler error: ${err.message}`);
    }
  });

  return { server, stripe, ledger, billing };
}

// Direct-run entry point.
if (import.meta.url === `file://${process.argv[1]}` || import.meta.url === new URL(`file:///${process.argv[1]?.replace(/\\/g, "/")}`).href) {
  const { server } = createWebhookServer();
  server.listen(PORT, () => console.log(`[stripe-webhook] listening on http://localhost:${PORT}/webhook`));
}
