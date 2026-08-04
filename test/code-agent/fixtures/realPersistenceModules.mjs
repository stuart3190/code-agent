// The actual modules that defeated the first deterministic transform.
//
// Reconstructed from the honesty findings of the production run of 2026-08-04 (diag run for job
// e0bc177a), which recorded the exact failing lines. Owner and project identifiers removed; the
// code shapes are otherwise as generated.
//
// These are the corpus. The first transform was written against an idealised fixture — a module
// with one string-literal storage key and conventionally-named exports — and declined every real
// module it met. Each rejection reason is documented against the module that caused it.

// ── reservation.js ────────────────────────────────────────────────────────────────────────────
//
// WHY THE FIRST TRANSFORM DECLINED:
//   1. the storage key is a CONSTANT (`GUEST_RESERVATIONS_KEY`), not a string literal, so the key
//      extractor found zero keys and the "exactly one key" test failed immediately
//   2. access is via `window.localStorage`, not bare `localStorage`
//   3. the module mixes persistence with validation, reference generation and sorting, which a
//      whole-module rewrite would have destroyed
export const RESERVATION_MODULE = `import { db } from "../lib/backend";

const GUEST_RESERVATIONS_KEY = "berry-brook-guest-reservations";

function makeReference() {
  return "BB-" + Math.random().toString(36).slice(2, 7).toUpperCase();
}

export function validateReservation(input) {
  const errors = {};
  if (!input.name || input.name.trim().length < 2) errors.name = "Please give us a name.";
  if (!/^[^@]+@[^@]+\\.[^@]+$/.test(input.email || "")) errors.email = "That email doesn't look right.";
  if (!input.slotId) errors.slotId = "Choose a picking slot.";
  return { ok: Object.keys(errors).length === 0, errors };
}

export async function listReservations() {
  const saved = JSON.parse(window.localStorage.getItem(GUEST_RESERVATIONS_KEY) || "[]");
  return saved.sort((a, b) => (a.slotId || "").localeCompare(b.slotId || ""));
}

export async function createReservation(input) {
  const reservation = { ...input, reference: makeReference(), createdAt: new Date().toISOString() };
  const reservations = JSON.parse(window.localStorage.getItem(GUEST_RESERVATIONS_KEY) || "[]");
  reservations.push(reservation);
  window.localStorage.setItem(GUEST_RESERVATIONS_KEY, JSON.stringify(reservations));
  return reservation;
}
`;

// ── newsletterSubscription.js ─────────────────────────────────────────────────────────────────
//
// WHY THE FIRST TRANSFORM DECLINED:
//   1. the key is a local variable (`guestKey`) computed at run time
//   2. it is a HYBRID: signed-in users already go through the real store, and browser storage is a
//      guest fallback inside a ternary. A whole-module rewrite would have deleted the working
//      signed-in path along with the broken one.
//   3. the storage call is nested inside a larger expression rather than being its own statement
export const NEWSLETTER_MODULE = `import { db, auth } from "../lib/backend";

export async function listSubscriptions() {
  const user = await auth.currentUser();
  const store = user ? db.entity("newsletterSubscription") : null;
  const guestKey = "berry-brook-newsletter-guest";
  const subscriptions = store ? await store.list({ limit: 500 }) : JSON.parse(window.localStorage.getItem(guestKey) || "[]");
  return subscriptions;
}

export async function subscribe(email) {
  const user = await auth.currentUser();
  const store = user ? db.entity("newsletterSubscription") : null;
  const guestKey = "berry-brook-newsletter-guest";
  const subscriptions = await listSubscriptions();
  const guestSubscription = { email, subscribedAt: new Date().toISOString() };
  if (store) return store.create(guestSubscription);
  window.localStorage.setItem(guestKey, JSON.stringify([...subscriptions, guestSubscription]));
  return guestSubscription;
}
`;

// A shape the transform must still DECLINE: storage used for something that is not an entity at
// all. Rewriting this to db.entity() would be actively wrong.
export const UI_PREFERENCE_MODULE = `export function getTheme() {
  return window.localStorage.getItem("theme") || "light";
}

export function setTheme(theme) {
  window.localStorage.setItem("theme", theme);
}
`;

export const REAL_MODULES = [
  { path: "src/data/reservation.js", source: RESERVATION_MODULE, entity: "reservation" },
  { path: "src/data/newsletterSubscription.js", source: NEWSLETTER_MODULE, entity: "newsletterSubscription" },
];
