import { auth, db } from "../lib/backend";

export const BOOKING_STATUS = {
  ACTIVE: "Active",
  CANCELLED: "Cancelled",
};

export const PICKING_DATES = [
  {
    id: "2025-06-20",
    date: "2025-06-20",
    label: "Fri 20 Jun",
    longLabel: "Friday 20 June",
    note: "Opening rows in the north meadow",
  },
  {
    id: "2025-06-21",
    date: "2025-06-21",
    label: "Sat 21 Jun",
    longLabel: "Saturday 21 June",
    note: "Family morning with extra picnic space",
  },
  {
    id: "2025-06-22",
    date: "2025-06-22",
    label: "Sun 22 Jun",
    longLabel: "Sunday 22 June",
    note: "Gentle afternoon picking windows",
  },
  {
    id: "2025-06-27",
    date: "2025-06-27",
    label: "Fri 27 Jun",
    longLabel: "Friday 27 June",
    note: "Second flush of ripe berries expected",
  },
];

export const PICKING_SLOTS = [
  { id: "morning-0900", label: "9:00–10:30", startsAt: "09:00", endsAt: "10:30", capacity: 24 },
  { id: "late-morning-1030", label: "10:30–12:00", startsAt: "10:30", endsAt: "12:00", capacity: 24 },
  { id: "midday-1200", label: "12:00–1:30", startsAt: "12:00", endsAt: "13:30", capacity: 20 },
  { id: "afternoon-1400", label: "2:00–3:30", startsAt: "14:00", endsAt: "15:30", capacity: 18 },
];

const bookingEntity = () => db.entity("booking");

async function requireBackendUser() {
  const user = await auth.currentUser();
  if (!user) {
    throw new Error("A backend session is required before reservation records can be saved or read.");
  }
  return user;
}

function unwrapRecord(row) {
  if (!row) return null;
  return { id: row.id, ...(row.data || {}) };
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function looksLikeEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function findSeededDate(date) {
  return PICKING_DATES.find((item) => item.date === date || item.id === date);
}

function findSeededSlot(slotId) {
  return PICKING_SLOTS.find((item) => item.id === slotId);
}

function assertPositiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) throw new Error(`${label} must be a whole number.`);
  return number;
}

function makeBookingReference() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let suffix = "";
  const bytes = new Uint8Array(6);
  globalThis.crypto?.getRandomValues?.(bytes);
  for (let index = 0; index < 6; index += 1) {
    const fallback = Math.floor(Math.random() * alphabet.length);
    suffix += alphabet[(bytes[index] || fallback) % alphabet.length];
  }
  return `BBF-${suffix}`;
}

export async function listBookings({ limit = 500 } = {}) {
  await requireBackendUser();
  const rows = await bookingEntity().list({ limit, order: "created_at", ascending: false });
  return rows.map(unwrapRecord).filter(Boolean);
}

export async function listActiveBookings(options = {}) {
  const bookings = await listBookings(options);
  return bookings.filter((booking) => booking.status !== BOOKING_STATUS.CANCELLED);
}

export async function getSlotAvailability() {
  const activeBookings = await listActiveBookings();
  const reservedGuests = new Map();

  for (const booking of activeBookings) {
    const key = `${booking.date}:${booking.slotId}`;
    reservedGuests.set(key, (reservedGuests.get(key) || 0) + Number(booking.totalGuests || 0));
  }

  return PICKING_DATES.map((date) => ({
    ...date,
    slots: PICKING_SLOTS.map((slot) => {
      const bookedGuests = reservedGuests.get(`${date.date}:${slot.id}`) || 0;
      const remaining = Math.max(0, slot.capacity - bookedGuests);
      const availabilityLabel = remaining === 0 ? "full" : remaining <= 5 ? "few left" : "plenty available";
      return { ...slot, date: date.date, bookedGuests, remaining, availabilityLabel };
    }),
  }));
}

export async function createBooking({
  date,
  slotId,
  adults,
  children,
  customerName,
  customerEmail,
  customerPhone,
  termsAccepted,
}) {
  await requireBackendUser();

  const seededDate = findSeededDate(date);
  if (!seededDate) throw new Error("Choose one of the available Berry Brook picking dates.");

  const seededSlot = findSeededSlot(slotId);
  if (!seededSlot) throw new Error("Choose one of the available 90-minute picking slots.");

  const adultCount = assertPositiveInteger(adults, "Adults");
  const childCount = assertPositiveInteger(children, "Children");
  const totalGuests = adultCount + childCount;
  if (totalGuests <= 0) throw new Error("Add at least one guest to the picking basket.");
  if (!String(customerName || "").trim()) throw new Error("Customer name is required.");
  const normalizedEmail = normalizeEmail(customerEmail);
  if (!looksLikeEmail(normalizedEmail)) throw new Error("Customer email must look like an email address.");
  if (!String(customerPhone || "").trim()) throw new Error("Customer phone is required.");
  if (termsAccepted !== true) throw new Error("Farm visit terms must be accepted before booking.");

  const availability = await getSlotAvailability();
  const day = availability.find((item) => item.date === seededDate.date);
  const slot = day?.slots.find((item) => item.id === seededSlot.id);
  if (!slot || slot.remaining < totalGuests) {
    throw new Error("That picking slot no longer has enough space for this party.");
  }

  const createdAt = new Date().toISOString();
  const booking = {
    reference: makeBookingReference(),
    date: seededDate.date,
    slotId: seededSlot.id,
    slotLabel: seededSlot.label,
    adults: adultCount,
    children: childCount,
    totalGuests,
    customerName: String(customerName).trim(),
    customerEmail: normalizedEmail,
    customerPhone: String(customerPhone).trim(),
    termsAccepted: true,
    status: BOOKING_STATUS.ACTIVE,
    createdAt,
    cancelledAt: null,
  };

  const row = await bookingEntity().create(booking);
  return unwrapRecord(row);
}

export async function readBookingByReferenceEmail(reference, email) {
  await requireBackendUser();
  const normalizedReference = String(reference || "").trim().toUpperCase();
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedReference || !normalizedEmail) return null;

  const rows = await bookingEntity().list({
    filters: { reference: normalizedReference, customerEmail: normalizedEmail },
    limit: 1,
  });

  return unwrapRecord(rows[0]) || null;
}

export async function cancelBooking(idOrBooking) {
  await requireBackendUser();
  const bookingId = typeof idOrBooking === "string" ? idOrBooking : idOrBooking?.id;
  if (!bookingId) throw new Error("A booking id is required to cancel a reservation.");

  const existingRow = await bookingEntity().get(bookingId);
  const existing = unwrapRecord(existingRow);
  if (!existing) throw new Error("Booking could not be found.");
  if (existing.status === BOOKING_STATUS.CANCELLED) return existing;

  const updated = {
    ...existing,
    status: BOOKING_STATUS.CANCELLED,
    cancelledAt: new Date().toISOString(),
  };
  delete updated.id;

  const row = await bookingEntity().update(bookingId, updated);
  return unwrapRecord(row);
}
