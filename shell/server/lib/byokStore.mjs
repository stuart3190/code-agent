// Secure storage for per-user BYOK provider keys. The raw key is encrypted at rest (AES-256-GCM)
// and read/written ONLY here, server-side, through the service-role client (public.byok_keys has
// RLS deny-all for clients). Nothing in this module logs, returns, or persists the raw key anywhere
// but the encrypted column — same custody standard as the Stripe secret.
//
//   setKey(owner, rawKey, provider)  -> { provider, hint, created_at }   (never returns the raw key)
//   getKeyRecord(owner)              -> { set, provider, hint, created_at } | { set:false }
//   getDecryptedKey(owner)           -> raw key string | null   (SERVER-ONLY; for provider injection)
//   clearKey(owner)                  -> { set:false }
//   maskKey(rawKey)                  -> 'sk-ant-…w9Qd'           (safe display; never the middle)

import { serviceClient } from "./supabase.mjs";
import { decryptSecret, encryptedStorageConfigured, encryptSecret } from "./secretCrypto.mjs";

const TABLE = "byok_keys";

export function byokConfigured() {
  return encryptedStorageConfigured();
}

// Masked display: keep a short recognizable prefix + last 4, hide everything between. Never reveals
// enough to reconstruct the key.
export function maskKey(rawKey) {
  const k = String(rawKey);
  const prefix = k.startsWith("sk-ant-") ? "sk-ant-" : k.slice(0, 3);
  const last4 = k.slice(-4);
  return `${prefix}…${last4}`;
}

export async function setKey(owner, rawKey, provider = "anthropic") {
  const key_encrypted = encryptSecret(rawKey);     // throws (fail-closed) if encryption is not configured
  const key_hint = maskKey(rawKey);
  const now = new Date().toISOString();
  const { error } = await serviceClient()
    .from(TABLE)
    .upsert({ owner, provider, key_encrypted, key_hint, updated_at: now }, { onConflict: "owner" });
  if (error) throw new Error(`byok store: ${error.message}`);
  return { provider, hint: key_hint, created_at: now }; // NOTE: never includes the raw key
}

export async function getKeyRecord(owner) {
  const { data, error } = await serviceClient()
    .from(TABLE).select("provider, key_hint, created_at").eq("owner", owner).maybeSingle();
  if (error) throw new Error(`byok read: ${error.message}`);
  if (!data) return { set: false };
  return { set: true, provider: data.provider, hint: data.key_hint, created_at: data.created_at };
}

// SERVER-ONLY. Returns the decrypted raw key for provider injection, or null if none. Callers must
// never send this to the client or log it.
export async function getDecryptedKey(owner) {
  const { data, error } = await serviceClient()
    .from(TABLE).select("key_encrypted").eq("owner", owner).maybeSingle();
  if (error) throw new Error(`byok read: ${error.message}`);
  if (!data?.key_encrypted) return null;
  return decryptSecret(data.key_encrypted);
}

export async function clearKey(owner) {
  const { error } = await serviceClient().from(TABLE).delete().eq("owner", owner);
  if (error) throw new Error(`byok clear: ${error.message}`);
  return { set: false };
}

// Exported for offline tests (pure crypto round-trip without the DB).
export const _internal = { encrypt: encryptSecret, decrypt: decryptSecret };
