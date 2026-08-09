// Anonymous visitor sessions - platform infrastructure. Do not edit or reimplement.
//
// Entities are owner-scoped by RLS, so even an app with no sign-in needs a session before
// db.entity() can persist anything. This module mints ONE visitor identity per browser, caches
// its generated credentials (session credentials, not business records), and signs in on demand.
// Every persistent anonymous feature shares this identity and survives reload through the
// platform-backed entity runtime.
//
//   import { ensureVisitorSession } from "./lib/visitorSession";
//   const user = (await auth.currentUser()) || (await ensureVisitorSession());

import { auth } from "./backend/index.js";
import { ensureAppVisitorSession } from "./backend/supabaseBackend.js";

export async function ensureVisitorSession() {
  return ensureAppVisitorSession({
    auth,
    appId: import.meta.env?.VITE_APP_ID || "app",
    storage: globalThis.localStorage,
  });
}
