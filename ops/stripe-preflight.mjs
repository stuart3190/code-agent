// Everything that must be true BEFORE a real card is used, and a fresh live checkout URL.
//
// Read-only against Stripe apart from the checkout session it creates, which is an intent and
// charges nothing until someone completes it. Nothing here simulates a payment; the point is to
// make sure that when a real payment happens, every path it will touch already works.

import Stripe from "stripe";
import { optionalEnv } from "../shell/server/lib/env.mjs";
import { thralloStripeConfigured, thralloWebhookConfigured, stripeConfigMistake } from "../shell/server/lib/subscriptionBilling.mjs";
import { planCatalogPublic } from "../shell/server/lib/usageBudgets.mjs";
import { serviceClient } from "../shell/server/lib/supabase.mjs";

const out = [];
let failed = 0;
const check = (ok, label, detail = "") => {
  out.push(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed += 1;
};

const key = optionalEnv("THRALLO_STRIPE_SECRET_KEY");
if (!key) { console.error("THRALLO_STRIPE_SECRET_KEY is not set"); process.exit(1); }
const stripe = new Stripe(key, { apiVersion: "2024-06-20" });
const db = serviceClient();

check(thralloStripeConfigured(), "Thrallo's Stripe configuration is complete");
check(thralloWebhookConfigured(), "and its webhook secret is present");
check(stripeConfigMistake() === null, "with no legacy-variable confusion", stripeConfigMistake() || "clean");

// ── Live mode, not test ─────────────────────────────────────────────────────────────────
check(key.startsWith("sk_live_"), "the key is a LIVE key", key.slice(0, 8));

// ── The Starter price ───────────────────────────────────────────────────────────────────
const starterPriceId = optionalEnv("THRALLO_STRIPE_PRICE_STARTER") || optionalEnv("THRALLO_STARTER_PRICE_ID");
check(!!starterPriceId, "a Starter price id is configured", starterPriceId ? starterPriceId.slice(0, 12) + "…" : "missing");

let price = null;
try {
  price = await stripe.prices.retrieve(starterPriceId, { expand: ["product"] });
  check(price.active, "the Starter price is active in Stripe");
  check(price.livemode === true, "and is a live-mode price", String(price.livemode));
  check(price.recurring?.interval === "month", "billed monthly", price.recurring?.interval || "not recurring");
  const catalogue = planCatalogPublic().find((p) => p.id === "starter");
  const stripeGbp = (price.unit_amount || 0) / 100;
  check(price.currency === "gbp", "priced in GBP", price.currency);
  check(stripeGbp === catalogue.priceGbp,
    "and Stripe's amount matches what Thrallo advertises",
    `Stripe £${stripeGbp} vs catalogue £${catalogue.priceGbp}`);
  check(!!price.product?.name, "the product is named", price.product?.name || "unnamed");
} catch (error) {
  check(false, "the Starter price could be read from Stripe", error.message);
}

// ── The Pro price, because the upgrade path needs it ────────────────────────────────────
{
  const proId = optionalEnv("THRALLO_STRIPE_PRICE_PRO") || optionalEnv("THRALLO_PRO_PRICE_ID");
  try {
    const pro = await stripe.prices.retrieve(proId);
    check(pro.active && pro.livemode, "the Pro price is active and live", `£${(pro.unit_amount || 0) / 100}`);
    check((pro.unit_amount || 0) > (price?.unit_amount || 0),
      "and costs more than Starter, so the upgrade is an upgrade");
  } catch (error) {
    check(false, "the Pro price could be read from Stripe", error.message);
  }
}

// ── Webhooks ────────────────────────────────────────────────────────────────────────────
try {
  const endpoints = await stripe.webhookEndpoints.list({ limit: 20 });
  const ours = (endpoints.data || []).filter((e) => /thrallo/i.test(e.url));
  check(ours.length > 0, "a webhook endpoint points at Thrallo", ours.map((e) => e.url).join(", ") || "none found");
  for (const endpoint of ours) {
    check(endpoint.status === "enabled", `${endpoint.url} is enabled`, endpoint.status);
    const events = endpoint.enabled_events || [];
    const needed = ["checkout.session.completed", "customer.subscription.updated", "customer.subscription.deleted"];
    const covered = needed.filter((e) => events.includes(e) || events.includes("*"));
    check(covered.length === needed.length,
      "and is subscribed to the events Thrallo acts on",
      `${covered.length}/${needed.length}: ${needed.filter((e) => !covered.includes(e)).join(", ") || "all present"}`);
  }
} catch (error) {
  check(false, "webhook endpoints could be listed", error.message);
}

// ── The Customer Portal ─────────────────────────────────────────────────────────────────
try {
  const configs = await stripe.billingPortal.configurations.list({ limit: 5 });
  const active = (configs.data || []).find((c) => c.active) || configs.data?.[0];
  check(!!active, "a Customer Portal configuration exists", active?.id || "none");
  if (active) {
    check(active.features?.subscription_cancel?.enabled === true,
      "portal cancellation is enabled",
      String(active.features?.subscription_cancel?.enabled));
    check(active.features?.payment_method_update?.enabled === true,
      "and card updates are enabled",
      String(active.features?.payment_method_update?.enabled));
    // Deliberately NOT enabled: this Stripe account is shared with another product and portal plan
    // switching is an account-wide setting, so turning it on would change that product too.
    // Thrallo does plan changes in-app instead.
    check(active.features?.subscription_update?.enabled !== true,
      "while portal plan switching stays OFF, as intended for a shared account",
      String(active.features?.subscription_update?.enabled));
  }
} catch (error) {
  check(false, "the portal configuration could be read", error.message);
}

// ── A new account really does start on Free ─────────────────────────────────────────────
{
  const { data: created, error } = await db.auth.admin.createUser({
    email: `p9-preflight-${Date.now()}@thrallo.invalid`,
    password: `P9!${Math.random().toString(36).slice(2)}Aa1`, email_confirm: true,
  });
  if (error) check(false, "a throwaway account could be created", error.message);
  else {
    const { budgetOverview } = await import("../shell/server/lib/usageBudgets.mjs");
    const overview = await budgetOverview(created.user.id);
    check(overview.plan.id === "free", "a brand-new account starts on Free", overview.plan.id);
    check(overview.subscription.stripeManaged === false, "with no Stripe subscription attached");
    await db.from("ca_subscriptions").delete().eq("owner", created.user.id).then(() => {}, () => {});
    await db.auth.admin.deleteUser(created.user.id).catch(() => {});
  }
}

// ── A fresh live checkout URL ───────────────────────────────────────────────────────────
//
// For Stuart to complete with a real card. Creating a session charges nothing.
let checkoutUrl = null;
if (!failed) {
  const owner = process.env.STRIPE_PREFLIGHT_OWNER;
  if (!owner) {
    out.push("SKIP  checkout URL — set STRIPE_PREFLIGHT_OWNER to the account that will pay");
  } else {
    try {
      const { startPlanCheckout } = await import("../shell/server/lib/subscriptionBilling.mjs");
      const result = await startPlanCheckout(owner, "starter");
      checkoutUrl = result.url || null;
      check(!!checkoutUrl || !!result.planChange,
        "a live Starter checkout session was created",
        checkoutUrl ? "url ready" : JSON.stringify(result.planChange));
    } catch (error) {
      check(false, "a live Starter checkout session was created", error.message);
    }
  }
}

console.log(`\n${out.join("\n")}\n`);
if (checkoutUrl) {
  console.log("─".repeat(72));
  console.log("LIVE STARTER CHECKOUT — complete this with a real card:");
  console.log(checkoutUrl);
  console.log("─".repeat(72));
}
console.log(failed ? `${failed} FAILED` : `${out.filter((l) => l.startsWith("PASS")).length} checks passed`);
process.exit(failed ? 1 : 0);
