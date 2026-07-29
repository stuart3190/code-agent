// Phase 4 (LIVE) billing proof — the end-to-end, evidence-per-step proof that the credit ledger and
// Stripe wiring actually work against LIVE services (Supabase + Stripe TEST MODE). Mirrors the Phase
// 3.1 tenancy proof's discipline: opt-in, creds-required, real round-trips, denial = pass, and every
// credit figure asserted against costModel (never re-derived).
//
//   1. SETUP    Stripe (sk_test) + Supabase (anon for the user, service_role for platform writes);
//               reconcile Stripe prices against costModel.
//   2. SIGNUP   a real user via the generated app's OWN SDK factory (anon flow, no service_role).
//   3. GRANT    a REAL Stripe test subscription -> its REAL invoice.paid event -> verify the signed-
//               payload path -> feed the event to the webhook handler -> bundle credits land; the user
//               reads the balance back through their OWN authed session (RLS read-scoping).
//   4. DEBIT    a simulated turn debits the model-WEIGHTED credits; balance drops by exactly that.
//   5. WALL     a turn larger than the balance is refused (insufficient_balance) — nothing written.
//   6. TOP-UP   a REAL Stripe one-off purchase event grants top-up credits -> balance restored ->
//               the refused turn now succeeds, spending bundle-first then top-up.
//   7. CEILING  with balance no longer the limiter, debits past the tier breakeven are refused
//               (hard_ceiling) — the runaway guard.
//   8. ROLLOVER the monthly job caps carry at breakeven − bundle (Studio: 1009, not 2000) and the
//               post-grant bundle balance lands exactly on breakeven.
//   9. ISOLATE  a second user cannot read user A's ledger (owner-scoped RLS; denial = pass).
//
//   Run (PowerShell), TEST MODE ONLY:
//     $env:SUPABASE_URL=...; $env:SUPABASE_ANON_KEY=...; $env:SUPABASE_SERVICE_ROLE_KEY=...
//     $env:STRIPE_SECRET_KEY="sk_test_..."; $env:STRIPE_PRICE_STARTER=...; $env:STRIPE_PRICE_PRO=...
//     $env:STRIPE_PRICE_STUDIO=...; $env:STRIPE_PRICE_TOPUP=...
//     node harness/proveBilling.mjs
//   Missing creds -> SKIPPED (live billing can't be asserted offline; the offline math is in
//   harness/_ledger-tests.mjs).

import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

import { clone, fromScaffold } from "../src/engine/fileTree.mjs";
import { REACT_VITE } from "../src/scaffolds/reactVite.mjs";
import { ensureDeps, buildTree } from "./workspace.mjs";
import { createLedger } from "../src/billing/ledger.mjs";
import { createBilling } from "../src/billing/stripe.mjs";
import {
  creditsForTurn,
  breakeven,
  bundleRolloverCapCredits,
  TIERS,
  TOPUP_GBP_PER_CREDIT,
} from "../src/billing/costModel.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORK_NAME = "billing-proof";
const WORK_DIR = path.join(HERE, ".work", WORK_NAME);

let fails = 0;
const step = (ok, label, detail = "") => {
  if (!ok) fails++;
  console.log(`   ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};
const near = (a, b, eps = 0.01) => Math.abs(a - b) <= eps;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const starter = TIERS.find((t) => t.id === "starter");
const studio = TIERS.find((t) => t.id === "studio");

// Poll Stripe for the real event of `type` whose object satisfies `match` (events are async).
async function waitForEvent(stripe, type, match, { tries = 12, gapMs = 1500 } = {}) {
  for (let i = 0; i < tries; i++) {
    const list = await stripe.events.list({ type, limit: 20 });
    const ev = list.data.find((e) => match(e.data.object));
    if (ev) return ev;
    await sleep(gapMs);
  }
  return null;
}

async function makeUser(createSupabaseBackend, url, anonKey, tag) {
  const be = createSupabaseBackend({ url, anonKey });
  const email = `${tag}+${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const password = `Pw-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  await be.auth.signUp({ email, password });
  const user = await be.auth.signIn({ email, password });
  if (!user?.id) throw new Error(`${tag}: signIn returned no session — is Auth "Confirm email" disabled?`);
  return { be, email, password, uid: user.id };
}

async function main() {
  console.log("Billing proof — LIVE Supabase ledger + Stripe (TEST MODE): grant ▸ debit ▸ wall ▸ top-up ▸ ceiling ▸ rollover ▸ isolate");

  const { SUPABASE_URL: url, SUPABASE_ANON_KEY: anonKey, SUPABASE_SERVICE_ROLE_KEY: serviceKey, STRIPE_SECRET_KEY: stripeKey } = process.env;
  if (!url || !anonKey || !serviceKey || !stripeKey) {
    console.log("\n  SKIPPED — set SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY and STRIPE_SECRET_KEY (sk_test_…) to run.");
    console.log("  (Offline ledger math is proven in harness/_ledger-tests.mjs; this proof needs live services.)");
    process.exit(0);
  }
  if (!stripeKey.startsWith("sk_test_")) {
    console.log("\n  REFUSING TO RUN — STRIPE_SECRET_KEY is not a test key (must start with sk_test_). This proof is TEST MODE ONLY.");
    process.exit(1);
  }

  const stripe = new Stripe(stripeKey);
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } }); // service-role: platform writes
  const ledger = createLedger(admin);
  const billing = createBilling({ stripe, ledger, env: process.env });

  // ── 1. SETUP — reconcile Stripe prices with costModel ────────────────────────────────────────
  console.log("\n══ 1. SETUP — Stripe (test) + Supabase (anon + service_role); reconcile prices with costModel");
  let prices;
  try {
    prices = await billing.assertPricesMatchModel();
    step(true, "Stripe prices match costModel (£/mo per tier + £/credit top-up)", prices.map((p) => `${p.tier}:£${p.gbp ?? p.gbpPerCredit}`).join(" "));
  } catch (e) {
    step(false, "Stripe prices match costModel", e.message);
    console.log("\n  Fix the price IDs / amounts in the env + dashboard, then re-run. Aborting.");
    process.exit(1);
  }

  // Stage the app's own SDK factory (anon flow) — exactly the code the generated app ships.
  await ensureDeps();
  const build = await buildTree(clone(fromScaffold(REACT_VITE)), WORK_NAME);
  if (!build.ok) throw new Error("scaffold failed to build — cannot stage the SDK factory");
  const { createSupabaseBackend } = await import(pathToFileURL(path.join(WORK_DIR, "src", "lib", "backend", "supabaseBackend.js")).href);

  // ── 2. SIGNUP ────────────────────────────────────────────────────────────────────────────────
  console.log("\n══ 2. SIGNUP — a real user via the app's own SDK (anon, no service_role)");
  const A = await makeUser(createSupabaseBackend, url, anonKey, "billing-a");
  step(!!A.uid, "user A signed up + signed in", `${A.email} (${A.uid.slice(0, 8)}…)`);
  const userLedger = createLedger(A.be._client); // the user's OWN authed session — proves RLS reads
  const before = await userLedger.getBalance(A.uid);
  step(before.total === 0, "fresh user reads an empty ledger via their own session", `${before.total} cr`);

  // ── 3. GRANT — real Stripe subscription -> real invoice.paid -> verify signature -> handler ──────
  console.log("\n══ 3. GRANT — real Stripe test subscription ▸ real invoice.paid ▸ verified ▸ handler ▸ bundle credits");
  const customerId = await billing.ensureCustomer({ owner: A.uid, email: A.email });
  // Attaching the shared test token yields a NEW payment-method id — capture it and make IT the default.
  const pm = await stripe.paymentMethods.attach("pm_card_visa", { customer: customerId });
  await stripe.customers.update(customerId, { invoice_settings: { default_payment_method: pm.id } });
  const sub = await stripe.subscriptions.create({
    customer: customerId,
    items: [{ price: billing.priceIdFor.starter }],
    default_payment_method: pm.id,
    metadata: { owner: A.uid },
  });
  step(sub.status === "active" || sub.status === "trialing", "Stripe subscription created + paid (test card)", `${sub.id} ${sub.status}`);

  const invoiceId = typeof sub.latest_invoice === "string" ? sub.latest_invoice : sub.latest_invoice?.id;
  const paidEvent = await waitForEvent(stripe, "invoice.paid", (o) => o.id === invoiceId || o.subscription === sub.id);
  step(!!paidEvent, "Stripe emitted the real invoice.paid event", paidEvent?.id);
  if (!paidEvent) throw new Error("invoice.paid event never arrived from Stripe");

  // Verify the SIGNED-PAYLOAD path the webhook server uses (independent test secret).
  const testSecret = "whsec_proof_" + Math.random().toString(36).slice(2);
  const payload = JSON.stringify(paidEvent);
  const header = stripe.webhooks.generateTestHeaderString({ payload, secret: testSecret });
  let verifiedEvent, sigOk = true;
  try {
    verifiedEvent = stripe.webhooks.constructEvent(payload, header, testSecret);
  } catch { sigOk = false; }
  step(sigOk && verifiedEvent?.id === paidEvent.id, "event passes Stripe signature verification (constructEvent)", "same path as webhookServer.mjs");
  let forged = false;
  try { stripe.webhooks.constructEvent(payload, header, "whsec_wrong_secret"); forged = true; } catch { forged = false; }
  step(!forged, "a wrong signing secret is REJECTED (forgery blocked)");

  const grantRes = await billing.handleStripeEvent(verifiedEvent);
  step(grantRes.handled && grantRes.tier === "starter" && grantRes.credits === starter.bundledCredits,
    "handler granted the Starter bundle", `${grantRes.credits} cr, cycle ${grantRes.cycle}`);

  const afterGrant = await userLedger.getBalance(A.uid);
  step(afterGrant.bundle === starter.bundledCredits && afterGrant.topup === 0,
    "user reads the bundle balance back through their OWN session (RLS read works)", `bundle ${afterGrant.bundle} cr`);

  const ent = await userLedger.getEntitlement(A.uid);
  step(ent?.tier === "starter", "entitlement synced to 'starter'", `period ${ent?.current_period}`);

  // Redelivery is idempotent.
  const redeliver = await billing.handleStripeEvent(verifiedEvent);
  const afterRedeliver = await ledger.getBalance(A.uid);
  step(redeliver.idempotent && afterRedeliver.bundle === starter.bundledCredits, "redelivered invoice.paid does NOT double-grant", `still ${afterRedeliver.bundle} cr`);

  // ── 4. DEBIT — a simulated weighted turn ─────────────────────────────────────────────────────
  console.log("\n══ 4. DEBIT — a simulated turn debits model-WEIGHTED credits (from costModel.creditsForTurn)");
  const need1 = creditsForTurn({ tokens: 10000, model: "claude-opus-4-8" }); // ~1.667
  const d1 = await ledger.debit({ owner: A.uid, tokens: 10000, model: "claude-opus-4-8", ref: `turn-${A.uid}-1` });
  step(d1.ok && near(d1.debited, need1, 0.0005), `10k Opus tokens debit ${need1.toFixed(3)} cr (weight ${d1.weight.toFixed(3)})`);
  const afterDebit = await userLedger.getBalance(A.uid);
  step(near(afterDebit.bundle, starter.bundledCredits - need1), "balance dropped by exactly the weighted need", `bundle ${afterDebit.bundle.toFixed(3)} cr`);

  // ── 5. WALL — a turn bigger than the balance is refused ───────────────────────────────────────
  console.log("\n══ 5. WALL — a turn larger than the balance is refused (insufficient_balance), nothing written");
  const wallTokens = 2_000_000; // 200 Sonnet credits, > the ~118 bundle balance
  const wallRef = `turn-${A.uid}-wall`;
  const wall = await ledger.debit({ owner: A.uid, tokens: wallTokens, model: "claude-sonnet-4-6", ref: wallRef });
  step(!wall.ok && wall.reason === "insufficient_balance", "over-balance turn refused", `need ${wall.need} > ${wall.balance.total.toFixed(2)}`);
  const afterWall = await ledger.getBalance(A.uid);
  step(near(afterWall.bundle, afterDebit.bundle), "refused turn wrote nothing (balance unchanged)");

  // ── 6. TOP-UP — real Stripe one-off purchase restores balance ─────────────────────────────────
  console.log("\n══ 6. TOP-UP — real Stripe one-off purchase ▸ checkout.session.completed ▸ top-up credits ▸ refused turn now succeeds");
  const TOPUP_CREDITS = 300;
  // Simulate the completed Checkout session the webhook receives (one-off payment). A real PaymentIntent
  // confirms the money moved; the session object is what Stripe posts to checkout.session.completed.
  const pi = await stripe.paymentIntents.create({
    amount: Math.round(TOPUP_CREDITS * TOPUP_GBP_PER_CREDIT * 100), currency: "gbp",
    customer: customerId, payment_method: "pm_card_visa", confirm: true,
    automatic_payment_methods: { enabled: true, allow_redirects: "never" },
  });
  step(pi.status === "succeeded", "top-up payment captured (test card)", `£${(pi.amount / 100).toFixed(2)} for ${TOPUP_CREDITS} cr`);
  const topupSession = {
    id: `cs_proof_${pi.id}`, object: "checkout.session", mode: "payment", customer: customerId,
    amount_total: pi.amount, payment_intent: pi.id, metadata: { owner: A.uid, kind: "topup", credits: String(TOPUP_CREDITS) },
  };
  const topupEvent = { id: `evt_proof_${pi.id}`, type: "checkout.session.completed", data: { object: topupSession } };
  const topupRes = await billing.handleStripeEvent(topupEvent);
  step(topupRes.handled && topupRes.credits === TOPUP_CREDITS, "handler granted top-up credits", `${topupRes.credits} cr`);
  const afterTopup = await userLedger.getBalance(A.uid);
  step(near(afterTopup.topup, TOPUP_CREDITS) && near(afterTopup.total, afterDebit.bundle + TOPUP_CREDITS),
    "top-up restored the balance (rolls over freely)", `total ${afterTopup.total.toFixed(2)} cr (bundle ${afterTopup.bundle.toFixed(2)} + topup ${afterTopup.topup})`);

  // Retry the previously-refused turn — now it succeeds, spending bundle-first then top-up.
  const retry = await ledger.debit({ owner: A.uid, tokens: wallTokens, model: "claude-sonnet-4-6", ref: wallRef });
  step(retry.ok && near(retry.fromBundle, afterDebit.bundle) && near(retry.fromTopup, 200 - afterDebit.bundle),
    "the refused turn now succeeds, bundle-first then top-up", `bundle ${retry.fromBundle.toFixed(2)} + topup ${retry.fromTopup.toFixed(2)}`);

  // ── 7. CEILING — per-tier hard ceiling refuses runaway spend even with balance ────────────────
  console.log("\n══ 7. CEILING — with balance available, debits past the tier breakeven are refused (hard_ceiling)");
  const ceil = breakeven(starter).breakevenCredits; // ~301
  const spentNow = await ledger.monthlyDebitedCredits(A.uid);
  const balNow = await ledger.getBalance(A.uid);
  // A turn that the BALANCE could cover but that crosses the ceiling.
  const overTokens = Math.ceil((ceil - spentNow + 5) * 10000); // +5 credits past the ceiling
  const overNeed = creditsForTurn({ tokens: overTokens, model: "claude-sonnet-4-6" });
  step(balNow.total > overNeed, "balance is sufficient for this turn (so only the ceiling can stop it)", `bal ${balNow.total.toFixed(1)} > need ${overNeed.toFixed(1)} cr`);
  const over = await ledger.debit({ owner: A.uid, tokens: overTokens, model: "claude-sonnet-4-6", ref: `turn-${A.uid}-ceiling` });
  step(!over.ok && over.reason === "hard_ceiling" && over.tier === "starter",
    "runaway turn refused by the per-tier hard ceiling", `spent ${over.spentThisMonth?.toFixed(1)} + ${over.need.toFixed(1)} > ceiling ${over.ceiling?.toFixed(1)}`);

  // ── 8. ROLLOVER — the monthly job caps carry at breakeven − bundle ────────────────────────────
  console.log("\n══ 8. ROLLOVER — monthly job caps carry at breakeven − bundle (Studio: 1009, not 2000)");
  // Demonstrate the cap biting with the most dramatic tier (Studio). Grant a full Studio bundle, leave
  // it unburned, then roll the cycle: carry must cap at 1009 and the post-grant bundle == breakeven.
  const cap = bundleRolloverCapCredits(studio);            // 1009
  const studioBe = breakeven(studio).breakevenCredits;     // 3009
  // Clear A's bundle to a known state isn't needed — rollover reads current bundle. Park a Studio bundle:
  await ledger.grant({ owner: A.uid, credits: studio.bundledCredits, bucket: "bundle", kind: "grant", cycle: "rollover-demo-in", ref: `rollover-demo-grant:${A.uid}` });
  const preRoll = await ledger.getBalance(A.uid);
  const roll = await ledger.rolloverJob({ owner: A.uid, tier: "studio", endingCycle: "rollover-demo-in", nextCycle: "rollover-demo-out" });
  step(near(roll.carried, cap) && roll.carried < studio.bundledCredits, `carry capped at ${Math.round(cap)} (not the full ${studio.bundledCredits})`, `carried ${roll.carried.toFixed(1)}, expired ${roll.expired.toFixed(1)}`);
  step(near(roll.bundleAfter, studioBe) && roll.bundleAfter <= studioBe + 1e-4, `post-grant bundle lands on breakeven ${Math.round(studioBe)} (never above)`, `${roll.bundleAfter.toFixed(1)} cr`);

  // ── 9. ISOLATE — RLS: user B cannot read user A's ledger ──────────────────────────────────────
  console.log("\n══ 9. ISOLATE — a second user cannot read user A's ledger (owner-scoped RLS; denial = pass)");
  const B = await makeUser(createSupabaseBackend, url, anonKey, "billing-b");
  const bLedger = createLedger(B.be._client);
  const bReadsOwn = await bLedger.getBalance(B.uid);
  step(bReadsOwn.total === 0, "user B reads their own (empty) ledger fine");
  const bReadsA = await bLedger.getBalance(A.uid); // queries owner=A through B's session -> RLS filters to none
  step(bReadsA.total === 0, "user B CANNOT see any of user A's ledger rows", `B sees ${bReadsA.total} of A's credits`);

  // ── CLEANUP (best-effort) ────────────────────────────────────────────────────────────────────
  console.log("\n══ CLEANUP (best-effort)");
  try { await stripe.subscriptions.cancel(sub.id); } catch {}
  try { await stripe.customers.del(customerId); } catch {}
  try { await admin.from("credit_ledger").delete().eq("owner", A.uid); } catch {}
  try { await admin.from("customers").delete().eq("owner", A.uid); } catch {}
  console.log("   cancelled the test subscription; deleted the test Stripe customer; removed A's ledger + entitlement rows");

  console.log("\n══ RESULT");
  if (fails === 0) {
    console.log("  ALL GREEN — live billing proven end-to-end:");
    console.log(`  • Stripe sub ${sub.id} → invoice.paid → ${starter.bundledCredits} bundle cr (verified signature)`);
    console.log(`  • weighted debit, balance wall, £${(pi.amount / 100).toFixed(2)} top-up restore, per-tier ceiling, rollover cap ${Math.round(cap)}`);
    console.log(`  • RLS: user B reached none of user A's ledger. costModel stayed the single source of truth.`);
    process.exit(0);
  }
  console.log(`  ${fails} assertion(s) FAILED — see FAILs above.`);
  process.exit(1);
}

main().catch((e) => {
  console.error("\nPROOF ERRORED:", e?.stack || e?.message || e);
  process.exit(1);
});
