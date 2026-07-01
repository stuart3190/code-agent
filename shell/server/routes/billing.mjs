// Billing routes — thin wrappers over the PROVEN createBilling()/ledger. No pricing is
// re-derived here; tier ids and top-up credits map straight through to costModel via stripe.mjs.
//
//   POST /api/billing/checkout  { tierId }  | { credits }   -> { url }  (Stripe Checkout, test mode)
//   GET  /api/billing/balance                               -> { bundle, topup, total }

import { billing, ledger } from "../lib/services.mjs";
import { optionalEnv } from "../lib/env.mjs";

function appUrls(body) {
  const base = body?.appUrl || optionalEnv("APP_URL", "http://localhost:5173");
  return {
    successUrl: `${base}/?billing=success`,
    cancelUrl: `${base}/?billing=cancel`,
  };
}

export async function handleCheckout(req, res, body, owner) {
  const { successUrl, cancelUrl } = appUrls(body);
  try {
    const b = billing();
    let session;
    if (body?.credits) {
      const credits = Number(body.credits);
      if (!(credits > 0)) throw new Error("credits must be > 0");
      session = await b.createTopupCheckout({ owner: owner.id, email: owner.email, credits, successUrl, cancelUrl });
    } else if (body?.tierId) {
      session = await b.createSubscriptionCheckout({ owner: owner.id, email: owner.email, tierId: body.tierId, successUrl, cancelUrl });
    } else {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "provide either tierId (subscription) or credits (top-up)" }));
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ url: session.url, id: session.id }));
  } catch (e) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: e.message }));
  }
}

export async function handleBalance(req, res, owner) {
  try {
    const bal = await ledger().getBalance(owner.id);
    const ent = await ledger().getEntitlement(owner.id);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ balance: bal, tier: ent?.tier ?? null }));
  } catch (e) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: e.message }));
  }
}
