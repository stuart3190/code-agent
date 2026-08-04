// What Stripe sent the customer back with, and remembering it across a sign-in.
//
// The bug this exists for: the billing return was handled inside the authenticated workspace, and
// the auth gate above it renders the public landing page for anyone without a session. Someone who
// completed checkout in a different browser — a phone, a second machine, a private window — paid
// real money and was returned to a marketing page with no acknowledgement at all.
//
// Stripe's return is a NAVIGATION, not a session. It can arrive anywhere, so the outcome has to
// survive arriving signed-out and be shown once the customer signs in.

const KEY = "thrallo-billing-return";

/**
 * Read the return from the URL.
 *
 * Both spellings are accepted. `/?billing=success` is what checkout is configured with, and
 * `/billing-success` is a path people (and pasted links, and Stripe dashboard overrides) end up on
 * — it was a route that existed nowhere, so the SPA served the app and the app showed the landing.
 */
export function readBillingReturn(location = window.location) {
  const path = String(location.pathname || "");
  if (/^\/billing-success\/?$/i.test(path)) return "success";
  if (/^\/billing-cancelled\/?$/i.test(path)) return "cancelled";
  const value = new URLSearchParams(location.search || "").get("billing");
  return value === "success" || value === "cancelled" ? value : null;
}

// Held so it survives a sign-in, and a page load, but not the browser closing: an unclaimed
// celebration a week later would be confusing rather than helpful.
export function rememberBillingReturn(value) {
  try {
    if (value === "success") sessionStorage.setItem(KEY, value);
  } catch { /* private mode: the in-URL value still works for this page load */ }
}

export function takeRememberedBillingReturn() {
  try {
    const value = sessionStorage.getItem(KEY);
    if (value) sessionStorage.removeItem(KEY);
    return value || null;
  } catch {
    return null;
  }
}

// The address to settle on once the return has been consumed, so a refresh does not replay it.
export const BILLING_RETURN_HOME = "/";
