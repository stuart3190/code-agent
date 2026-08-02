#!/usr/bin/env node
// Validates Thrallo's live Stripe billing configuration against Stripe itself.
//
// Thrallo sells exactly two paid plans: Starter and Pro. This script proves that what the code
// will charge matches what the account actually offers, and that what the pricing page DISPLAYS
// matches what Stripe will CHARGE — a mismatch there is a consumer-law problem, not a cosmetic one.
//
// Read-only: it creates nothing and modifies nothing. Safe to run against live keys, and intended
// to be re-run whenever billing configuration changes.
//
//   node scripts/stripe-live-check.mjs
//   node scripts/stripe-live-check.mjs --json
//
// Price IDs are never hardcoded here. They come from the environment, so prices that Thrallo does
// not sell cannot be referenced by construction.

import Stripe from "stripe";
import { loadEnv } from "../shell/server/lib/env.mjs";

// Read shell/.env exactly as the server does, so this checks the configuration the running
// service actually sees rather than requiring the file to be sourced first.
loadEnv();

const JSON_OUT = process.argv.includes("--json");
const PLANS = [
  { id: "starter", envIds: ["THRALLO_STRIPE_PRICE_STARTER", "THRALLO_STARTER_PRICE_ID"], envGbp: "THRALLO_STARTER_PRICE_GBP" },
  { id: "pro", envIds: ["THRALLO_STRIPE_PRICE_PRO", "THRALLO_PRO_PRICE_ID"], envGbp: "THRALLO_PRO_PRICE_GBP" },
];

const results = [];
const record = (level, message, detail) => {
  results.push({ level, message, detail });
  if (JSON_OUT) return;
  const mark = level === "pass" ? "  ok  " : level === "warn" ? " warn " : " FAIL ";
  console.log(`[${mark}] ${message}${detail ? `\n         ${detail}` : ""}`);
};

function envValue(names) {
  for (const name of names) {
    const value = (process.env[name] || "").trim();
    if (value) return { name, value };
  }
  return null;
}

async function main() {
  const secret = (process.env.THRALLO_STRIPE_SECRET_KEY || "").trim();

  // ── Configuration shape ────────────────────────────────────────────────────────────────
  if (!secret) {
    record("fail", "THRALLO_STRIPE_SECRET_KEY is not set", "Billing stays dormant; the free plan is unaffected.");
    return finish();
  }
  if (!/^sk_(live|test)_/.test(secret)) {
    record("fail", "THRALLO_STRIPE_SECRET_KEY is not a Stripe secret key", "Expected it to start with sk_live_ or sk_test_.");
    return finish();
  }
  const mode = secret.startsWith("sk_live_") ? "live" : "test";
  record(mode === "live" ? "pass" : "warn", `Secret key is a ${mode}-mode key`);

  // The un-prefixed names belong to retired Buildr101 billing code and are deliberately ignored.
  for (const legacy of ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"]) {
    if ((process.env[legacy] || "").trim()) {
      record("warn", `Legacy ${legacy} is set and is deliberately ignored by Thrallo`,
        "Thrallo reads the THRALLO_-prefixed names so a Buildr101 credential can never be inherited.");
    }
  }

  const webhookSecret = (process.env.THRALLO_STRIPE_WEBHOOK_SECRET || "").trim();
  if (!webhookSecret) record("fail", "THRALLO_STRIPE_WEBHOOK_SECRET is not set", "Webhooks return 501 and subscriptions will never activate.");
  else if (!webhookSecret.startsWith("whsec_")) record("fail", "THRALLO_STRIPE_WEBHOOK_SECRET does not look like a signing secret", "Expected it to start with whsec_.");
  else record("pass", "Webhook signing secret is present");

  const stripe = new Stripe(secret);

  // Confirm the key works and report whose account this is, so a wrong-account key is obvious.
  try {
    const account = await stripe.accounts.retrieve();
    record("pass", `Key authenticates as ${account.id}`,
      [account.business_profile?.name, account.settings?.dashboard?.display_name, account.email]
        .filter(Boolean).join(" · ") || undefined);
  } catch (e) {
    record("fail", "Stripe rejected the secret key", e?.message);
    return finish();
  }

  // ── Each sold plan, checked against Stripe ─────────────────────────────────────────────
  const configuredIds = new Set();
  for (const plan of PLANS) {
    const configured = envValue(plan.envIds);
    if (!configured) {
      record("fail", `No price ID configured for ${plan.id}`, `Set one of: ${plan.envIds.join(" or ")}`);
      continue;
    }
    configuredIds.add(configured.value);

    let price;
    try {
      price = await stripe.prices.retrieve(configured.value, { expand: ["product"] });
    } catch (e) {
      record("fail", `${plan.id}: price does not exist in this Stripe account`, e?.message);
      continue;
    }

    // Archived prices still retrieve successfully but cannot be purchased — checkout fails at the
    // moment a real customer tries to pay, which is the worst possible time to discover it.
    if (!price.active) record("fail", `${plan.id}: price is ARCHIVED and cannot be purchased`, price.id);
    else record("pass", `${plan.id}: price is active`, price.id);

    if (price.currency !== "gbp") record("fail", `${plan.id}: currency is ${price.currency.toUpperCase()}, expected GBP`);
    if (price.type !== "recurring" || !price.recurring) {
      record("fail", `${plan.id}: price is not recurring`, "Subscription checkout requires a recurring price.");
      continue;
    }
    const { interval, interval_count: count } = price.recurring;
    if (interval !== "month" || count !== 1) {
      record("warn", `${plan.id}: bills every ${count} ${interval}(s), not monthly`,
        "Thrallo's plan allowances are described as monthly.");
    } else {
      record("pass", `${plan.id}: bills monthly`);
    }

    const gbp = price.unit_amount === null ? null : price.unit_amount / 100;
    const productName = typeof price.product === "object" ? price.product?.name : null;
    record("pass", `${plan.id}: Stripe charges £${gbp?.toFixed(2)}/month`, productName ? `product: ${productName}` : undefined);

    // The displayed price must equal the charged price.
    const displayed = Number(process.env[plan.envGbp] || "");
    if (!Number.isFinite(displayed) || displayed <= 0) {
      record("fail", `${plan.id}: ${plan.envGbp} is not set, so the plan stays unpurchasable`,
        `Set ${plan.envGbp}=${gbp} to match Stripe.`);
    } else if (Math.abs(displayed - gbp) > 0.005) {
      record("fail", `${plan.id}: DISPLAYED £${displayed.toFixed(2)} does not match CHARGED £${gbp.toFixed(2)}`,
        `Set ${plan.envGbp}=${gbp}.`);
    } else {
      record("pass", `${plan.id}: displayed price matches the charged price (£${gbp.toFixed(2)})`);
    }
  }

  // ── Nothing Thrallo does not sell is wired in ──────────────────────────────────────────
  // Reported from the account, never hardcoded, so unsold prices are named nowhere in the repo.
  const all = await stripe.prices.list({ limit: 100, expand: ["data.product"] });
  const otherActive = all.data.filter((p) => p.active && !configuredIds.has(p.id));
  if (otherActive.length) {
    record("warn", `${otherActive.length} other active price(s) exist in this account and are NOT sold by Thrallo`,
      otherActive.map((p) => `${p.id} — ${typeof p.product === "object" ? p.product?.name : "?"} `
        + `£${p.unit_amount === null ? "?" : (p.unit_amount / 100).toFixed(2)}`).join("\n         ")
      + "\n         These cannot be purchased through Thrallo; a subscription to one grants no plan.");
  } else {
    record("pass", "No unsold active prices are reachable");
  }

  // ── Webhook endpoint ───────────────────────────────────────────────────────────────────
  const origin = (process.env.THRALLO_APP_ORIGIN || "https://app.thrallo.com").replace(/\/$/, "");
  const expectedUrl = `${origin}/api/v1/billing/webhook`;
  const REQUIRED_EVENTS = ["checkout.session.completed", "customer.subscription.updated", "customer.subscription.deleted"];
  try {
    const endpoints = await stripe.webhookEndpoints.list({ limit: 100 });
    const match = endpoints.data.find((e) => e.url === expectedUrl);
    if (!match) {
      record("fail", "No Stripe webhook endpoint points at Thrallo", `Expected: ${expectedUrl}`
        + (endpoints.data.length ? `\n         Found instead: ${endpoints.data.map((e) => e.url).join(", ")}` : ""));
    } else {
      record(match.status === "enabled" ? "pass" : "fail", `Webhook endpoint is ${match.status}`, match.id);
      const subscribed = new Set(match.enabled_events);
      const missing = subscribed.has("*") ? [] : REQUIRED_EVENTS.filter((e) => !subscribed.has(e));
      if (missing.length) {
        record("fail", "Webhook is missing required events", missing.join(", ")
          + "\n         Without these, payments succeed but plans never activate or downgrade.");
      } else {
        record("pass", "Webhook subscribes to all required events");
      }
    }
  } catch (e) {
    record("warn", "Could not list webhook endpoints", e?.message);
  }

  // ── Customer Portal ────────────────────────────────────────────────────────────────────
  // Cancellation runs through the portal, so an unconfigured portal breaks the documented path.
  try {
    const configs = await stripe.billingPortal.configurations.list({ limit: 10 });
    const active = configs.data.find((c) => c.active) || configs.data.find((c) => c.is_default);
    if (!active) {
      record("fail", "No active Customer Portal configuration",
        "Cancellation and payment-method updates go through the portal. Configure it in Stripe → Settings → Billing → Customer portal.");
    } else {
      record("pass", "Customer Portal is configured", active.id);
      if (!active.features?.subscription_cancel?.enabled) {
        record("fail", "Customer Portal does not allow cancellation",
          "Users would have no self-service way to cancel.");
      } else {
        record("pass", "Customer Portal allows cancellation");
      }
    }
  } catch (e) {
    record("warn", "Could not read Customer Portal configuration", e?.message);
  }

  return finish();
}

function finish() {
  const failures = results.filter((r) => r.level === "fail");
  const warnings = results.filter((r) => r.level === "warn");
  if (JSON_OUT) {
    console.log(JSON.stringify({ ok: failures.length === 0, failures: failures.length, warnings: warnings.length, results }, null, 2));
  } else {
    console.log("");
    console.log(failures.length === 0
      ? `Billing configuration is consistent with Stripe (${warnings.length} warning(s)).`
      : `${failures.length} problem(s) must be fixed before taking live payments.`);
  }
  process.exitCode = failures.length === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error(e?.stack || e);
  process.exitCode = 1;
});
