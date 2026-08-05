// Session capability v1 — platform infrastructure, do not edit.
//
// Entities are owner-scoped by RLS: every read and write needs a session. This is the one
// supported way to get one — a signed-in user when the app has accounts, the shared visitor
// session otherwise. Nothing else in app code may touch credentials or storage.

import { auth } from "../backend/index.js";
import { ensureVisitorSession } from "../visitorSession.js";

export { ensureVisitorSession };

/** The current user, or null — never throws. */
export async function currentUser() {
  return auth.currentUser().catch(() => null);
}

/**
 * A session, whatever it takes: the signed-in user when one exists, the browser's shared
 * visitor identity otherwise. Every anonymous persist path calls this first.
 */
export async function ensureSession() {
  return (await currentUser()) || ensureVisitorSession();
}

export async function signOut() {
  return auth.signOut();
}
