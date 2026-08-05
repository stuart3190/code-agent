import { auth, db } from "../lib/backend";

const newsletterEntity = () => db.entity("newsletterSignup");

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function looksLikeEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function unwrapRecord(row) {
  if (!row) return null;
  return { id: row.id, ...(row.data || {}) };
}

export async function createNewsletterSignup(email) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) throw new Error("Email is required for newsletter signup.");
  if (!looksLikeEmail(normalizedEmail)) throw new Error("Email must look like an email address.");

  let user = null;
  try {
    user = await auth.currentUser();
  } catch {
    user = null;
  }

  if (!user) {
    const record = {
      id: `local-${Date.now()}`,
      email: normalizedEmail,
      createdAt: new Date().toISOString(),
      localOnly: true,
    };
    try {
      const existing = JSON.parse(localStorage.getItem("berry-brook-newsletter-signups") || "[]");
      localStorage.setItem("berry-brook-newsletter-signups", JSON.stringify([record, ...existing].slice(0, 50)));
    } catch {
      // Public newsletter signup should still confirm when browser storage is unavailable.
    }
    return record;
  }

  const row = await newsletterEntity().create({
    email: normalizedEmail,
    createdAt: new Date().toISOString(),
  });

  return unwrapRecord(row);
}
