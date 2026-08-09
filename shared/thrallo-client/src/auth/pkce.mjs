const encoder = new TextEncoder();

function base64Url(bytes) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let encoded = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const value = (bytes[index] << 16) | ((bytes[index + 1] || 0) << 8) | (bytes[index + 2] || 0);
    encoded += alphabet[(value >>> 18) & 63];
    encoded += alphabet[(value >>> 12) & 63];
    encoded += index + 1 < bytes.length ? alphabet[(value >>> 6) & 63] : "=";
    encoded += index + 2 < bytes.length ? alphabet[value & 63] : "=";
  }
  return encoded.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function secureBytes(length, randomBytes) {
  if (typeof randomBytes === "function") {
    const value = randomBytes(length);
    if (!(value instanceof Uint8Array) || value.length !== length) throw new TypeError("PKCE randomBytes must return the requested Uint8Array length");
    return value;
  }
  if (typeof globalThis.crypto?.getRandomValues !== "function") throw new TypeError("Secure random generation is unavailable");
  return globalThis.crypto.getRandomValues(new Uint8Array(length));
}

export function createPkceVerifier({ randomBytes } = {}) {
  return base64Url(secureBytes(64, randomBytes));
}

export function createCorrelationValue({ randomBytes } = {}) {
  return base64Url(secureBytes(32, randomBytes));
}

export async function createPkceChallenge(verifier, { digest } = {}) {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier || "")) throw new TypeError("Invalid PKCE verifier");
  const digestImpl = digest || (async (value) => {
    if (typeof globalThis.crypto?.subtle?.digest !== "function") throw new TypeError("SHA-256 is unavailable");
    return new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", value));
  });
  const hashed = await digestImpl(encoder.encode(verifier));
  return base64Url(hashed instanceof Uint8Array ? hashed : new Uint8Array(hashed));
}

export async function createPkceTransaction({ randomBytes, digest, createdAt, expiresInMs = 300_000 } = {}) {
  const verifier = createPkceVerifier({ randomBytes });
  const issuedAt = Number(createdAt ?? Date.now());
  return Object.freeze({
    verifier,
    challenge: await createPkceChallenge(verifier, { digest }),
    state: createCorrelationValue({ randomBytes }),
    nonce: createCorrelationValue({ randomBytes }),
    createdAt: issuedAt,
    expiresAt: issuedAt + expiresInMs,
  });
}

export function constantTimeEqual(left, right) {
  const a = encoder.encode(String(left ?? ""));
  const b = encoder.encode(String(right ?? ""));
  let difference = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) difference |= (a[index % Math.max(1, a.length)] || 0) ^ (b[index % Math.max(1, b.length)] || 0);
  return difference === 0;
}
