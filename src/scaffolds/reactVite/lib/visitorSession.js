// Anonymous visitor sessions — platform infrastructure. Do not edit or reimplement.
//
// Entities are owner-scoped by RLS, so even an app with no sign-in needs a session before
// db.entity() can persist anything. This module mints ONE visitor identity per browser, caches
// its generated credentials (credentials are session state, not records — every record lives in
// the database under the session this establishes), and signs in on demand. Every feature that
// persists for anonymous visitors must share this one session, so bookings, signups, carts and
// lookups all land under the same identity and survive a reload together.
//
//   import { ensureVisitorSession } from "./lib/visitorSession";
//   const user = (await auth.currentUser()) || (await ensureVisitorSession());

import { auth } from "./backend";

const KEY = `visitor-session:${import.meta.env.VITE_APP_ID || "app"}`;

export async function ensureVisitorSession() {
  const current = await auth.currentUser().catch(() => null);
  if (current) return current;

  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(KEY) || "null");
  } catch {
    saved = null;
  }
  if (!saved?.email || !saved?.password) {
    const id = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    saved = { email: `visitor-${id}@visitor.local`, password: `Visitor-${id}-key` };
    try {
      localStorage.setItem(KEY, JSON.stringify(saved));
    } catch {
      // Storage may be blocked; a per-load session still works — records simply belong to a
      // fresh visitor next time.
    }
  }

  try {
    return await auth.signIn(saved);
  } catch {
    return auth.signUp(saved);
  }
}
