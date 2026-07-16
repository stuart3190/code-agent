// Platform admins — accounts that pass the paid-feature gates (publish, custom domains)
// without a subscription. Owner-account concept only: ADMIN_EMAILS in shell/.env is a
// comma-separated allowlist matched against the VERIFIED token email (ownerFromToken →
// Supabase getUser — not a client-supplied value, so it can't be spoofed).
//
// Deliberately NOT a database flag: webhooks (subscription.deleted) own customers.tier and
// would fight a hand-set tier; an env allowlist survives billing events, is visible in one
// place, and needs no migration. Credits are untouched — admin skips tier GATES, it does not
// grant or exempt metering (tierless debits already work with an Infinity ceiling).

const list = () =>
  (process.env.ADMIN_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

export function isAdmin(owner) {
  const email = owner?.email?.toLowerCase();
  return !!email && list().includes(email);
}
