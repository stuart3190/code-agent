// Owner accounts — Thrallo staff, identified by THRALLO_OWNER_EMAILS (comma-separated).
// Owners bypass usage ENFORCEMENT everywhere (limits, quotas, rate caps) but their usage
// is still METERED normally for analytics; recording paths are untouched. Resolution is by
// owner id → email via the auth admin API (works for PAT sessions too), cached briefly.

import { optionalEnv } from "./env.mjs";

const cache = new Map(); // ownerId -> { value, at }
const TTL_MS = 5 * 60_000;

export function ownerEmailList() {
  return (optionalEnv("THRALLO_OWNER_EMAILS", "") || "")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

async function defaultResolveEmail(ownerId) {
  const { serviceClient } = await import("./supabase.mjs");
  const { data } = await serviceClient().auth.admin.getUserById(ownerId);
  return data?.user?.email || null;
}

export async function isOwnerAccount(ownerId, { resolveEmail = defaultResolveEmail } = {}) {
  const list = ownerEmailList();
  if (!list.length || !ownerId) return false;
  const hit = cache.get(ownerId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  let value = false;
  try {
    const email = await resolveEmail(ownerId);
    value = !!email && list.includes(String(email).toLowerCase());
  } catch {
    value = false; // fail closed: enforcement stays on if we cannot prove ownership
  }
  cache.set(ownerId, { value, at: Date.now() });
  return value;
}

export function resetOwnerAccountCacheForTests() {
  cache.clear();
}
