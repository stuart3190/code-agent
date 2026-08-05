// Contact + newsletter capabilities v1 — platform infrastructure, do not edit.
//
// Both return RESULT STATES the UI must render (linted at D1): a newsletter signup that
// stores a row but shows nothing failed the live run's verification — feedback is part of
// the behaviour, not decoration.

import { db as defaultDb } from "../backend/index.js";
import { ensureSession as defaultEnsureSession } from "./session.js";

export const CONTACT_RESULT = Object.freeze({ OK: "sent", INVALID: "invalid" });
export const NEWSLETTER_RESULT = Object.freeze({ OK: "success", INVALID: "invalid", DUPLICATE: "duplicate" });

const emailOk = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
const flatten = (row) => (row ? { id: row.id, ...(row.data || {}) } : null);

export function makeContactForm({ entity = "contactMessage", deps = {} } = {}) {
  const db = deps.db || defaultDb;
  const ensureSession = deps.ensureSession || defaultEnsureSession;
  return {
    async submitContact(fields = {}) {
      const problems = {};
      if (!String(fields.name || "").trim()) problems.name = "Please tell us your name.";
      if (!emailOk(fields.email)) problems.email = "That email address doesn't look right.";
      if (!String(fields.message || "").trim()) problems.message = "Please include a message.";
      if (Object.keys(problems).length) return { result: CONTACT_RESULT.INVALID, problems };
      await ensureSession();
      const row = await db.entity(entity).create({
        name: String(fields.name).trim(),
        email: String(fields.email).trim().toLowerCase(),
        message: String(fields.message).trim(),
        createdAt: new Date().toISOString(),
      });
      return { result: CONTACT_RESULT.OK, message: flatten(row) };
    },
  };
}

export function makeNewsletter({ entity = "newsletterSignup", deps = {} } = {}) {
  const db = deps.db || defaultDb;
  const ensureSession = deps.ensureSession || defaultEnsureSession;
  return {
    async subscribe(email) {
      const normalized = String(email || "").trim().toLowerCase();
      if (!emailOk(normalized)) return { result: NEWSLETTER_RESULT.INVALID };
      await ensureSession();
      const existing = await db.entity(entity).list({ filters: { email: normalized }, limit: 1 });
      if (existing.length) return { result: NEWSLETTER_RESULT.DUPLICATE };
      const row = await db.entity(entity).create({ email: normalized, createdAt: new Date().toISOString() });
      return { result: NEWSLETTER_RESULT.OK, signup: flatten(row) };
    },
  };
}
