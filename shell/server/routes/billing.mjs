// Billing routes — thin wrappers over the PROVEN createBilling()/ledger. No pricing is
// re-derived here; tier ids and top-up credits map straight through to costModel via stripe.mjs.
//
//   POST /api/billing/checkout  { tierId }  | { credits }   -> { url }  (Stripe Checkout, test mode)
//   GET  /api/billing/balance                               -> { bundle, topup, total }

import { billing, ledger } from "../lib/services.mjs";
import { optionalEnv } from "../lib/env.mjs";
import { ensureWelcomeGrant } from "../lib/welcome.mjs";

function appUrls() {
  // Never trust a checkout return URL from the browser; that would turn this into an open redirect.
  const base = optionalEnv("APP_URL", "http://localhost:5173").replace(/\/$/, "");
  return {
    successUrl: `${base}/?billing=success`,
    cancelUrl: `${base}/?billing=cancel`,
  };
}

export async function handleCheckout(req, res, body, owner) {
  const { successUrl, cancelUrl } = appUrls();
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
    console.error(`[billing:checkout] ${e?.stack || e}`);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Checkout could not be started. Please try again." }));
  }
}

// GET /api/billing/subscription -> { active, tier, cancelAtPeriodEnd, periodEnd }
export async function handleSubscription(req, res, owner) {
  try {
    const status = await billing().subscriptionStatus(owner.id);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(status));
  } catch (e) {
    console.error(`[billing:subscription] ${e?.stack || e}`);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Subscription details are temporarily unavailable." }));
  }
}

// POST /api/billing/switch { tierId } — in-place plan change (see stripe.mjs semantics).
export async function handleSwitch(req, res, body, owner) {
  try {
    if (!body?.tierId) throw new Error("tierId required");
    const out = await billing().switchTier({ owner: owner.id, tierId: body.tierId });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(out));
  } catch (e) {
    console.error(`[billing:switch] ${e?.stack || e}`);
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "The plan could not be changed. Please check the plan and try again." }));
  }
}

// POST /api/billing/cancel { resume?: true } — cancel at period end, or undo a pending cancel.
export async function handleCancel(req, res, body, owner) {
  try {
    const out = await billing().setCancelAtPeriodEnd({ owner: owner.id, cancel: !body?.resume });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(out));
  } catch (e) {
    console.error(`[billing:cancel] ${e?.stack || e}`);
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "The subscription could not be updated. Please try again." }));
  }
}

export async function handleBalance(req, res, owner) {
  try {
    await ensureWelcomeGrant(owner.id); // materializes the signup gift on first balance read
    const bal = await ledger().getBalance(owner.id);
    const ent = await ledger().getEntitlement(owner.id);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ balance: bal, tier: ent?.tier ?? null }));
  } catch (e) {
    console.error(`[billing:balance] ${e?.stack || e}`);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Your balance is temporarily unavailable." }));
  }
}
