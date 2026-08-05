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
    return rows.map(flatten).filter((b) => b.status === BOOKING_STATUS.ACTIVE);
  }

  async function remaining(date, slotId) {
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
    const partySize = Number(values.partySize) || 1;
    if (!values.date || !values.slotId || !emailOk(values.email) || !String(values.name || "").trim()) {
      return { result: CREATE_RESULT.INVALID, booking: null };
    }
    if (await remaining(values.date, values.slotId) < partySize) {
      return { result: CREATE_RESULT.OVER_CAPACITY, booking: null };
    }
    await ensureSession();
    const reference = makeReference();
    const row = await store().create({
      ...values,
      partySize,
      email: String(values.email).trim().toLowerCase(),
      reference,
      status: BOOKING_STATUS.ACTIVE,
      createdAt: new Date().toISOString(),
    });
    // The re-rank: with every racer's row now visible, does OUR row fit within capacity in
    // the deterministic admission order?
    const active = (await activeFor(values.date, values.slotId))
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
      return { result: CREATE_RESULT.OVER_CAPACITY, booking: null };
    }
    return { result: CREATE_RESULT.OK, booking: flatten(row) };
  }

  async function getBooking(reference, email) {
    const rows = await store().list({ filters: { reference: String(reference || "").trim().toUpperCase() }, limit: 5 });
    const match = rows.map(flatten).find((b) => b.email === String(email || "").trim().toLowerCase());
    return match || null;
  }

  async function listBookings(options = {}) {
    return (await store().list({ limit: 500, ...options })).map(flatten);
  }

  /** CANCELLATION: a status TRANSITION the UI must render — never a silent delete. */
  async function cancelBooking(reference, email) {
    const booking = await getBooking(reference, email);
    if (!booking) return { ok: false, reason: "not_found" };
    if (booking.status === BOOKING_STATUS.CANCELLED) return { ok: false, reason: "already_cancelled", booking };
    const { id, createdAt, ...fields } = booking;
    const updated = await store().update(booking.id, { ...fields, status: BOOKING_STATUS.CANCELLED, cancelledAt: new Date().toISOString() });
    return { ok: true, booking: flatten(updated) };
  }

  return { createBooking, getBooking, listBookings, cancelBooking, remaining, BOOKING_STATUS, CREATE_RESULT };
}
