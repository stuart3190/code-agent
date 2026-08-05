// WP-5 live headless proof — the booking-domain capabilities against the REAL entities
// schema (service role, dedicated test app id), zero model credits, cleaned up after.
//
// The same factory the generated apps ship (createSupabaseBackend) runs here in node — the
// P19 pattern — so what passes here is exactly what runs in the browser.
//
//   node ops/bv2-capabilities-proof.mjs

import { createSupabaseBackend } from "../src/scaffolds/reactVite/lib/backend/supabaseBackend.js";
import { makeBookingSystem, CREATE_RESULT, BOOKING_STATUS } from "../src/scaffolds/reactVite/lib/capabilities/booking.js";
import { makeNewsletter, NEWSLETTER_RESULT } from "../src/scaffolds/reactVite/lib/capabilities/forms.js";
import { optionalEnv } from "../shell/server/lib/env.mjs";

const url = optionalEnv("SUPABASE_URL");
const key = optionalEnv("SUPABASE_SERVICE_ROLE_KEY") || optionalEnv("SUPABASE_SERVICE_ROLE");
if (!url || !key) { console.error("no supabase service credentials in env"); process.exit(1); }

const APP_ID = "bv2-capability-proof";
const backend = createSupabaseBackend({ url, anonKey: key, appId: APP_ID });
// Service role needs no session; the capability's ensureSession is satisfied trivially.
const deps = { db: backend.db, ensureSession: async () => ({ id: "service-proof" }) };

const fail = (msg) => { console.error(`PROOF FAILED — ${msg}`); process.exit(1); };

async function cleanup() {
  for (const type of ["booking", "newsletterSignup"]) {
    const rows = await backend.db.entity(type).list({ limit: 500 }).catch(() => []);
    for (const row of rows) await backend.db.entity(type).delete(row.id).catch(() => {});
  }
}

console.log("BV2 CAPABILITIES — LIVE SCHEMA PROOF (app", APP_ID + ")");
try {
  await cleanup(); // stale rows from an interrupted prior run must not skew counts

  const system = makeBookingSystem({ slots: [{ id: "slot-1", capacity: 2 }], deps });

  const created = await system.createBooking({
    date: "2026-08-20", slotId: "slot-1", partySize: 2, name: "Proof", email: "proof@thrallo.invalid",
  });
  if (created.result !== CREATE_RESULT.OK) fail(`create: ${created.result}`);
  console.log(`create      OK — reference ${created.booking.reference}, real row ${created.booking.id}`);

  const refused = await system.createBooking({
    date: "2026-08-20", slotId: "slot-1", partySize: 1, name: "Late", email: "late@thrallo.invalid",
  });
  if (refused.result !== CREATE_RESULT.OVER_CAPACITY) fail(`capacity guard: ${refused.result}`);
  console.log("capacity    OK — over-capacity refused against real rows");

  const found = await system.getBooking(created.booking.reference, "proof@thrallo.invalid");
  if (!found || found.id !== created.booking.id) fail("lookup by reference+email");
  console.log("lookup      OK — reference + email finds the persisted row");

  const cancelled = await system.cancelBooking(created.booking.reference, "proof@thrallo.invalid");
  if (!cancelled.ok || cancelled.booking.status !== BOOKING_STATUS.CANCELLED) fail("cancel transition");
  const remaining = await system.remaining("2026-08-20", "slot-1");
  if (remaining !== 2) fail(`capacity release: remaining ${remaining}`);
  console.log("cancel      OK — status transitioned in the database, capacity released");

  const newsletter = makeNewsletter({ deps });
  if ((await newsletter.subscribe("proof@thrallo.invalid")).result !== NEWSLETTER_RESULT.OK) fail("newsletter ok");
  if ((await newsletter.subscribe("PROOF@thrallo.invalid")).result !== NEWSLETTER_RESULT.DUPLICATE) fail("newsletter duplicate");
  if ((await newsletter.subscribe("nope")).result !== NEWSLETTER_RESULT.INVALID) fail("newsletter invalid");
  console.log("newsletter  OK — ok/duplicate/invalid states against real rows");

  console.log("\nPROOF PASSED — the shipped capabilities behave on the real schema.");
} finally {
  await cleanup();
  console.log("cleaned up.");
}
