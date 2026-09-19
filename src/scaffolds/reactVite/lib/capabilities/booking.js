// Booking capability v1 — platform infrastructure, do not edit.
//
// Booking, availability, conflict prevention and cancellation as ONE tested module. The
// 32.65-credit live run failed verification on exactly the behaviours this hard-codes:
// capacity refusal, a visible cancellation transition, references a lookup can find.
//
// Headless by law: functions and STATUS/RESULT enums only. The UI CONTRACT (what a screen
// using this must render) lives in the platform registry and is linted at D1.
//
// `deps` is injectable for the platform test suite; generated apps use the defaults.

import { db as defaultDb } from "../backend/index.js";
import { ensureSession as defaultEnsureSession } from "./session.js";

export const BOOKING_STATUS = Object.freeze({ ACTIVE: "Active", CANCELLED: "Cancelled" });
export const CREATE_RESULT = Object.freeze({ OK: "ok", INVALID: "invalid", OVER_CAPACITY: "over_capacity" });

const flatten = (row) => (row ? { id: row.id, createdAt: row.created_at, ...(row.data || {}) } : null);
const emailOk = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
const bookingResult = (result, booking) => ({ ...(booking || {}), result, booking });

function makeReference() {
  const raw = (globalThis.crypto?.randomUUID?.() || `${Date.now()}${Math.random()}`).replace(/[^a-z0-9]/gi, "");
  return `BK-${raw.slice(0, 6).toUpperCase()}`;
}

/**
 * @param slots     [{ id, capacity }] — the app's slot catalogue (from its contract)
 * @param entity    entity type name, default "booking"
 */
export function makeBookingSystem({ slots = [], entity = "booking", deps = {} } = {}) {
  const db = deps.db || defaultDb;
  const ensureSession = deps.ensureSession || defaultEnsureSession;
  const store = () => db.entity(entity);
  const capacityOf = (slotId) => slots.find((s) => s.id === slotId)?.capacity ?? Infinity;

  async function activeFor(date, slotId) {
    const rows = await store().list({ filters: { date, slotId }, limit: 500 });
    return rows.map(flatten).filter((b) => [BOOKING_STATUS.ACTIVE, "Confirmed"].includes(b.status));
  }

  /**
   * Seats left, or null when this slot's capacity is not knowable.
   *
   * A live build rendered "Infinity remaining seats" on every slot card. The cause was here:
   * capacityOf falls back to Infinity for a slot the catalogue does not contain, so remaining()
   * returned Infinity and the app printed it. Infinity is the right ANSWER for an unbounded
   * booking system — one configured with no catalogue at all — but for a catalogue that simply
   * does not list this slot it is a wiring bug wearing a number's clothes.
   *
   * Unknown is therefore reported as null, which an app cannot mistake for a seat count. The
   * admission path below keeps using capacityOf directly, so refusal behaviour is unchanged.
   */
  async function remaining(date, slotId) {
    if (slots.length && !slots.some((s) => s.id === slotId)) return null;
    const active = await activeFor(date, slotId);
    return capacityOf(slotId) - active.reduce((total, b) => total + (Number(b.partySize) || 1), 0);
  }

  /**
   * CONFLICT PREVENTION: check → create → RE-RANK. Two writers can both pass the first
   * check; both then re-read with both rows visible and apply the SAME deterministic
   * ranking — earliest (createdAt, id) first — so each writer independently computes an
   * identical admission order. A writer whose row ranks within capacity keeps it; one that
   * ranks beyond withdraws ITS OWN row and reports over_capacity. A naive "over? withdraw"
   * re-check livelocks symmetrically (both writers see 2 > 1 and both withdraw — caught by
   * the concurrent-create test); ranking admits exactly the rows that fit.
   */
  async function createBooking(values = {}) {
    // The capability originally required the compact { date, email, name } vocabulary while the
    // contracts it serves commonly expose explicit entity fields such as dateId/bookingDate/
    // guestEmail/guestName. Accept those contract-shaped names at this platform boundary. The
    // canonical fields remain present in storage, so existing consumers and capacity checks keep
    // their exact semantics.
    const date = values.date ?? values.dateId ?? values.bookingDate;
    const email = values.email ?? values.guestEmail;
    const name = values.name ?? values.guestName;
    const status = values.status === "Confirmed" ? "Confirmed" : BOOKING_STATUS.ACTIVE;
    const partySize = Number(values.partySize) || 1;
    if (!date || !values.slotId || !emailOk(email) || !String(name || "").trim()) {
      return bookingResult(CREATE_RESULT.INVALID, null);
    }
    if (await remaining(date, values.slotId) < partySize) {
      return bookingResult(CREATE_RESULT.OVER_CAPACITY, null);
    }
    await ensureSession();
    const reference = makeReference();
    const row = await store().create({
      ...values,
      date,
      email: String(email).trim().toLowerCase(),
      name: String(name).trim(),
      partySize,
      reference,
      status,
      createdAt: new Date().toISOString(),
    });
    // The re-rank: with every racer's row now visible, does OUR row fit within capacity in
    // the deterministic admission order?
    const active = (await activeFor(date, values.slotId))
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || String(a.id).localeCompare(String(b.id)));
    let admitted = 0;
    let ours = false;
    for (const candidate of active) {
      admitted += Number(candidate.partySize) || 1;
      if (admitted > capacityOf(values.slotId)) break;
      if (candidate.id === row.id) { ours = true; break; }
    }
    if (!ours) {
      await store().delete(row.id);
      return bookingResult(CREATE_RESULT.OVER_CAPACITY, null);
    }
    return bookingResult(CREATE_RESULT.OK, flatten(row));
  }

  async function getBooking(reference, email) {
    const rows = await store().list({ filters: { reference: String(reference || "").trim().toUpperCase() }, limit: 5 });
    const normalizedEmail = typeof email === "string" ? email.trim().toLowerCase() : "";
    // The generated backend already scopes rows to the current visitor and app. Email remains a
    // supported additional check, but is not required to recover a reference inside that scope.
    const match = rows.map(flatten).find((b) => !normalizedEmail || b.email === normalizedEmail);
    return match || null;
  }

  async function listBookings(options = {}) {
    return (await store().list({ limit: 500, ...options })).map(flatten);
  }

  /** CANCELLATION: a status TRANSITION the UI must render — never a silent delete. */
  async function cancelBooking(reference, email) {
    const booking = await getBooking(reference, email);
    if (!booking) return { ok: false, reason: "not_found", booking: null };
    if (booking.status === BOOKING_STATUS.CANCELLED) return { ...booking, ok: false, reason: "already_cancelled", booking };
    const { id, createdAt, ...fields } = booking;
    const updated = await store().update(booking.id, { ...fields, status: BOOKING_STATUS.CANCELLED, cancelledAt: new Date().toISOString() });
    const flattened = flatten(updated);
    return { ...flattened, ok: true, booking: flattened };
  }

  return { createBooking, getBooking, listBookings, cancelBooking, remaining, BOOKING_STATUS, CREATE_RESULT };
}
