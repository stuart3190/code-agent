// Stable app-auth namespace. Keep existing account addresses unchanged across provisioning,
// sign-in and password recovery; changing this protocol requires an explicit migration.
export async function syntheticAppEmail(appId, email) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${appId}|${String(email).toLowerCase()}`));
  const hex = Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, '0')).join('');
  return `u.${hex.slice(0, 32)}@apps.thrallo.com`;
}
