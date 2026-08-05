// WP-5 — booking-domain capabilities, proven hermetically against a memory backend double.
// Every behaviour here is one the live 32.65-credit run FAILED verification on: capacity
// refusal, visible cancellation transition, newsletter feedback states.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The scaffold modules are plain ESM importable in node; ../backend resolves through the
// scaffold's own directory, whose index degrades to the unconfigured fallback — which is
// exactly why deps injection exists and is what these tests use.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CAP = (name) => import(`file://${path.join(HERE, "..", "..", "src", "scaffolds", "reactVite", "lib", "capabilities", name)}`);

function memoryBackend() {
  const rows = new Map();
  let counter = 0;
  const db = {
    entity(type) {
      return {
        async create(data) {
          const row = { id: `row-${++counter}`, type, data: { ...data }, created_at: new Date().toISOString() };
          rows.set(row.id, row);
          return row;
        },
        async list({ filters = {} } = {}) {
          return [...rows.values()].filter((r) => r.type === type
            && Object.entries(filters).every(([k, v]) => (k === "id" ? r.id === v : r.data[k] === v)));
        },
        async get(id) { return rows.get(id) || null; },
        async update(id, data) { const row = rows.get(id); row.data = { ...data }; return row; },
        async delete(id) { rows.delete(id); },
        async count() { return rows.size; },
        subscribe() { return () => {}; },
      };
    },
  };
  return { db, ensureSession: async () => ({ id: "visitor-1" }), rows };
}

const SLOTS = [{ id: "morning", capacity: 4 }, { id: "afternoon", capacity: 1 }];

test("WP5 — create validates, confirms with a reference, and the lookup finds it", async () => {
  const { makeBookingSystem, CREATE_RESULT, BOOKING_STATUS } = await CAP("booking.js");
  const system = makeBookingSystem({ slots: SLOTS, deps: memoryBackend() });

  const invalid = await system.createBooking({ date: "2026-08-10", slotId: "morning", email: "nope", name: "" });
  assert.equal(invalid.result, CREATE_RESULT.INVALID);

  const ok = await system.createBooking({
    date: "2026-08-10", slotId: "morning", partySize: 2, name: "Ada", email: "Ada@Example.com ",
  });
  assert.equal(ok.result, CREATE_RESULT.OK);
  assert.match(ok.booking.reference, /^BK-[A-Z0-9]{6}$/, "a reference the confirmation can show");
  assert.equal(ok.booking.status, BOOKING_STATUS.ACTIVE);
  assert.equal(ok.booking.email, "ada@example.com", "email normalised for lookup");

  const found = await system.getBooking(ok.booking.reference, "ADA@example.com");
  assert.equal(found.id, ok.booking.id, "reference + email finds the booking");
  assert.equal(await system.getBooking(ok.booking.reference, "mallory@example.com"), null);
});

test("WP5 — capacity refuses over-booking, and the concurrent race admits exactly one writer", async () => {
  const { makeBookingSystem, CREATE_RESULT } = await CAP("booking.js");
  const deps = memoryBackend();
  const system = makeBookingSystem({ slots: SLOTS, deps });

  // Plain refusal: afternoon holds 1; a party of 2 never fits.
  const tooBig = await system.createBooking({ date: "2026-08-10", slotId: "afternoon", partySize: 2, name: "Bo", email: "bo@x.com" });
  assert.equal(tooBig.result, CREATE_RESULT.OVER_CAPACITY);

  // The RACE: two writers pass the pre-check together for the last space. The re-check after
  // create makes the loser withdraw its own row — exactly one booking survives.
  const [a, b] = await Promise.all([
    system.createBooking({ date: "2026-08-11", slotId: "afternoon", partySize: 1, name: "A", email: "a@x.com" }),
    system.createBooking({ date: "2026-08-11", slotId: "afternoon", partySize: 1, name: "B", email: "b@x.com" }),
  ]);
  const outcomes = [a.result, b.result].sort();
  assert.deepEqual(outcomes, [CREATE_RESULT.OK, CREATE_RESULT.OVER_CAPACITY].sort(),
    `exactly one winner: got ${outcomes.join(", ")}`);
  assert.equal(await system.remaining("2026-08-11", "afternoon"), 0);
  const survivors = (await system.listBookings()).filter((x) => x.date === "2026-08-11" && x.status === "Active");
  assert.equal(survivors.length, 1, "the loser's row was withdrawn, not left as a ghost");
});

test("WP5 — cancellation is a visible STATUS TRANSITION that releases capacity", async () => {
  const { makeBookingSystem, BOOKING_STATUS } = await CAP("booking.js");
  const system = makeBookingSystem({ slots: SLOTS, deps: memoryBackend() });
  const { booking } = await system.createBooking({ date: "2026-08-12", slotId: "afternoon", partySize: 1, name: "Cy", email: "cy@x.com" });

  assert.equal(await system.remaining("2026-08-12", "afternoon"), 0);
  const cancelled = await system.cancelBooking(booking.reference, "cy@x.com");
  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.booking.status, BOOKING_STATUS.CANCELLED, "the status the UI must render");
  assert.ok(cancelled.booking.cancelledAt);
  assert.equal(await system.remaining("2026-08-12", "afternoon"), 1, "capacity released");

  const again = await system.cancelBooking(booking.reference, "cy@x.com");
  assert.deepEqual([again.ok, again.reason], [false, "already_cancelled"], "idempotent, honestly reported");
  const wrong = await system.cancelBooking(booking.reference, "mallory@x.com");
  assert.deepEqual([wrong.ok, wrong.reason], [false, "not_found"], "no cross-email cancellation");
});

test("WP5 — newsletter returns the exact states the UI contract demands", async () => {
  const { makeNewsletter, NEWSLETTER_RESULT } = await CAP("forms.js");
  const newsletter = makeNewsletter({ deps: memoryBackend() });
  assert.equal((await newsletter.subscribe("not-an-email")).result, NEWSLETTER_RESULT.INVALID);
  assert.equal((await newsletter.subscribe("kim@example.com")).result, NEWSLETTER_RESULT.OK);
  assert.equal((await newsletter.subscribe(" KIM@example.com ")).result, NEWSLETTER_RESULT.DUPLICATE,
    "normalised duplicate detection — the state the live run never showed");
});

test("WP5 — contact form maps field problems the UI can render inline", async () => {
  const { makeContactForm, CONTACT_RESULT } = await CAP("forms.js");
  const contact = makeContactForm({ deps: memoryBackend() });
  const invalid = await contact.submitContact({ name: "", email: "x", message: "" });
  assert.equal(invalid.result, CONTACT_RESULT.INVALID);
  assert.deepEqual(Object.keys(invalid.problems).sort(), ["email", "message", "name"]);
  const sent = await contact.submitContact({ name: "Ada", email: "ada@x.com", message: "hello" });
  assert.equal(sent.result, CONTACT_RESULT.OK);
  assert.equal(sent.message.email, "ada@x.com");
});
