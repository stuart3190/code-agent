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

import crypto from "node:crypto";
import { serviceClient } from "./supabase.mjs";
import { optionalEnv } from "./env.mjs";

const TABLE = "byok_keys";
const ALGO = "aes-256-gcm";

// The 32-byte encryption key comes from BYOK_ENC_KEY (gitignored shell/.env), accepted as 64-char
// hex or base64. Absent/invalid -> we throw a clear, fail-closed error on any encrypt/decrypt. The
// value itself is never logged.
function encKey() {
  const raw = optionalEnv("BYOK_ENC_KEY");
  if (!raw) {
    throw new Error("BYOK storage is not configured: set BYOK_ENC_KEY (32 bytes as 64-hex or base64) in shell/.env.");
  }
  let buf;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) buf = Buffer.from(raw, "hex");
  else buf = Buffer.from(raw, "base64");
  if (buf.length !== 32) {
    throw new Error("BYOK_ENC_KEY must decode to exactly 32 bytes (use 64 hex chars, or 44-char base64 of 32 bytes).");
  }
  return buf;
}

export function byokConfigured() {
  try { encKey(); return true; } catch { return false; }
}

// iv(12) : authTag(16) : ciphertext, each base64, joined by ':'.
function encrypt(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, encKey(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("base64"), tag.toString("base64"), ct.toString("base64")].join(":");
}

function decrypt(stored) {
  const [ivB64, tagB64, ctB64] = String(stored).split(":");
  if (!ivB64 || !tagB64 || !ctB64) throw new Error("byok: malformed ciphertext");
  const decipher = crypto.createDecipheriv(ALGO, encKey(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]).toString("utf8");
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
  const key_encrypted = encrypt(rawKey);           // throws (fail-closed) if BYOK_ENC_KEY missing
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
  return decrypt(data.key_encrypted);
}

export async function clearKey(owner) {
  const { error } = await serviceClient().from(TABLE).delete().eq("owner", owner);
  if (error) throw new Error(`byok clear: ${error.message}`);
  return { set: false };
}

// Exported for offline tests (pure crypto round-trip without the DB).
export const _internal = { encrypt, decrypt };
