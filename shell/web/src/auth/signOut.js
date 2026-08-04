// Signing out, and coming back to where you were.
//
// Two separate jobs that both live at the auth boundary:
//
//   1. Ending a session completely. Not just clearing the token — dropping every stream, timer and
//      piece of in-memory state that belonged to the person who just left. On a shared machine,
//      "signed out" that leaves the previous user's project titles on screen is not signed out.
//
//   2. Remembering where an unauthenticated visitor was trying to go, so signing in lands them
//      there instead of dumping them on the dashboard. Deliberately NOT applied after an explicit
//      log out: someone who chose to leave has not asked to be returned anywhere.

const INTENDED = "thrallo-intended-path";

/**
 * End the session and return to the public page.
 *
 * A full document navigation rather than SPA routing, on purpose. The workspace holds open event
 * streams, poll timers and a conversation cache; unmounting React does not reliably stop all of it,
 * and any of it surviving would be the previous user's data alive in the next user's tab. A reload
 * guarantees the process starts clean.
 *
 * The redirect happens even if the sign-out call fails — a token that could not be revoked
 * server-side must still not leave someone looking at an authenticated screen.
 */
export async function signOutCompletely(client, { to = "/" } = {}) {
  forgetIntendedPath();
  try {
    await client().auth.signOut();
  } catch {
    // Best effort. Supabase clears local storage before the network call in most versions, and
    // the reload below drops the rest either way.
  }
  window.location.assign(to);
}

/**
 * Where an unauthenticated visitor was trying to go.
 *
 * Only real in-app destinations are remembered. "/" is not worth restoring, and the billing return
 * carries its own handling — restoring it would replay a success screen after an unrelated sign-in.
 */
export function rememberIntendedPath(location = window.location) {
  const path = `${location.pathname || "/"}${location.search || ""}`;
  if (path === "/" || /billing[-=]/.test(path)) return;
  try { sessionStorage.setItem(INTENDED, path); } catch { /* private mode */ }
}

export function takeIntendedPath() {
  try {
    const path = sessionStorage.getItem(INTENDED);
    if (path) sessionStorage.removeItem(INTENDED);
    return path || null;
  } catch {
    return null;
  }
}

export function forgetIntendedPath() {
  try { sessionStorage.removeItem(INTENDED); } catch { /* private mode */ }
}
