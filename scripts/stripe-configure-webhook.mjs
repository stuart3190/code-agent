#!/usr/bin/env node
// Creates (or repairs) Thrallo's Stripe webhook endpoint and stores the signing secret.
//
// Stripe returns a webhook's signing secret exactly once, at creation. This script captures it and
// writes it directly into shell/.env, printing only a masked confirmation — so the secret never
// passes through a terminal transcript, a chat message, or a human clipboard.
//
//   node scripts/stripe-configure-webhook.mjs           # report only, changes nothing
//   node scripts/stripe-configure-webhook.mjs --apply   # create the endpoint and store the secret
//
// Requires THRALLO_STRIPE_SECRET_KEY. Re-runnable: an existing correct endpoint is left alone.

import Stripe from "stripe";
import { readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "../shell/server/lib/env.mjs";

// Read shell/.env exactly as the server does, so the script sees the same configuration the
// running service sees rather than requiring the file to be sourced first.
loadEnv();

const APPLY = process.argv.includes("--apply");
const ENV_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "shell", ".env");

// Thrallo acts on exactly these. checkout.session.completed activates a new subscription;
// updated syncs plan/status changes and payment failures; deleted downgrades to free.
// A missing event does not fail loudly — it simply means a paid customer is never upgraded,
// or a cancelled one is never downgraded.
const EVENTS = ["checkout.session.completed", "customer.subscription.updated", "customer.subscription.deleted"];

function mask(secret) {
  return `${secret.slice(0, 11)}…${secret.slice(-4)} (${secret.length} chars)`;
}

// Replace the variable in place if present, otherwise append. Never duplicates a key, because a
// duplicate in a .env is resolved by last-one-wins and is invisible when reading the file top-down.
function storeEnv(name, value) {
  const original = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8") : "";
  if (existsSync(ENV_PATH)) {
    copyFileSync(ENV_PATH, `${ENV_PATH}.bak-webhook-${Date.now()}`);
  }
  const line = `${name}=${value}`;
  const pattern = new RegExp(`^${name}=.*$`, "m");
  const next = pattern.test(original)
    ? original.replace(pattern, line)
    : `${original.replace(/\n*$/, "")}\n${line}\n`;
  writeFileSync(ENV_PATH, next, "utf8");
  return pattern.test(original) ? "replaced" : "appended";
}

async function main() {
  const secret = (process.env.THRALLO_STRIPE_SECRET_KEY || "").trim();
  if (!secret) {
    console.error("THRALLO_STRIPE_SECRET_KEY is not set. Nothing to do.");
    process.exitCode = 1;
    return;
  }
  const stripe = new Stripe(secret);
  const origin = (process.env.THRALLO_APP_ORIGIN || "https://app.thrallo.com").replace(/\/$/, "");
  const url = `${origin}/api/v1/billing/webhook`;

  // Name the account before changing anything — a key for the wrong Stripe account is the one
  // mistake that would be silently destructive here.
  const account = await stripe.accounts.retrieve();
  console.log(`Stripe account : ${account.id}`
    + `${account.settings?.dashboard?.display_name ? ` (${account.settings.dashboard.display_name})` : ""}`);
  console.log(`Mode           : ${secret.startsWith("sk_live_") ? "LIVE" : "test"}`);
  console.log(`Endpoint URL   : ${url}\n`);

  const existing = (await stripe.webhookEndpoints.list({ limit: 100 })).data.find((e) => e.url === url);

  if (existing) {
    const subscribed = new Set(existing.enabled_events);
    const missing = subscribed.has("*") ? [] : EVENTS.filter((e) => !subscribed.has(e));
    console.log(`An endpoint already exists: ${existing.id} (${existing.status})`);
    if (!missing.length && existing.status === "enabled") {
      console.log("It is enabled and subscribes to every required event. Nothing to change.");
      console.log("\nIts signing secret is only retrievable at creation time. If THRALLO_STRIPE_WEBHOOK_SECRET");
      console.log("is unknown, roll it in the Stripe dashboard and store the new value, or delete this");
      console.log("endpoint and re-run with --apply.");
      return;
    }
    console.log(`Needs repair: ${missing.length ? `missing events ${missing.join(", ")}` : ""}`
      + `${existing.status !== "enabled" ? ` status is ${existing.status}` : ""}`);
    if (!APPLY) return console.log("\nRe-run with --apply to update it.");
    const updated = await stripe.webhookEndpoints.update(existing.id, {
      enabled_events: [...new Set([...existing.enabled_events, ...EVENTS])],
      disabled: false,
    });
    console.log(`Updated ${updated.id}: now subscribes to ${updated.enabled_events.length} event(s).`);
    console.log("The signing secret is unchanged, so no .env update is needed.");
    return;
  }

  console.log(`No endpoint exists for this URL. It would be created subscribing to:\n  ${EVENTS.join("\n  ")}`);
  if (!APPLY) return console.log("\nReport only. Re-run with --apply to create it.");

  const created = await stripe.webhookEndpoints.create({
    url,
    enabled_events: EVENTS,
    description: "Thrallo subscription billing (Starter, Pro)",
  });
  console.log(`\nCreated ${created.id} (${created.status}).`);

  const signing = created.secret;
  if (!signing) {
    console.error("Stripe did not return a signing secret. Copy it from the dashboard and set "
      + "THRALLO_STRIPE_WEBHOOK_SECRET manually.");
    process.exitCode = 1;
    return;
  }
  const action = storeEnv("THRALLO_STRIPE_WEBHOOK_SECRET", signing);
  console.log(`Signing secret ${action} in shell/.env: ${mask(signing)}`);
  console.log("\nThe secret was written directly to the file and never printed in full.");
  console.log("Next: sudo systemctl restart thrallo-shell   (env is read at boot)");
  console.log("Then: node scripts/stripe-live-check.mjs");
}

main().catch((e) => {
  console.error(e?.message || e);
  process.exitCode = 1;
});
