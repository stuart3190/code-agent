import crypto from "node:crypto";
import { optionalEnv } from "./env.mjs";

const ALGO = "aes-256-gcm";

function encryptionKey() {
  const raw = optionalEnv("PLATFORM_ENC_KEY") || optionalEnv("BYOK_ENC_KEY");
  if (!raw) throw new Error("Encrypted storage is not configured.");
  const key = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error("The platform encryption key must decode to exactly 32 bytes.");
  return key;
}

export function encryptedStorageConfigured() {
  try { encryptionKey(); return true; } catch { return false; }
}

export function encryptSecret(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString("base64")).join(":");
}

export function decryptSecret(stored) {
  const [iv, tag, ciphertext] = String(stored).split(":").map((part) => Buffer.from(part || "", "base64"));
  if (iv.length !== 12 || tag.length !== 16 || !ciphertext.length) throw new Error("Malformed encrypted value.");
  const decipher = crypto.createDecipheriv(ALGO, encryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

export function blindIndex(value, namespace = "default") {
  return crypto.createHmac("sha256", encryptionKey())
    .update(String(namespace))
    .update("\0")
    .update(String(value))
    .digest("hex");
}

export function secretHint(value) {
  const text = String(value);
  if (text.length <= 8) return `••••${text.slice(-2)}`;
  return `${text.slice(0, 3)}••••${text.slice(-4)}`;
}
