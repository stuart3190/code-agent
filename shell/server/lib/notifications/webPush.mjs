// Web Push without dependencies: VAPID (RFC 8292, ES256 JWT) + payload encryption
// (RFC 8291 aes128gcm over RFC 8188). Node's crypto has everything needed — ECDH P-256,
// HKDF-SHA256, AES-128-GCM. Tested by round-trip decryption in
// test/code-agent/notifications.test.mjs.

import crypto from "node:crypto";

const b64url = (buf) => Buffer.from(buf).toString("base64url");

export function generateVapidKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const pubRaw = publicKey.export({ format: "jwk" });
  const privRaw = privateKey.export({ format: "jwk" });
  // Public key travels as the uncompressed EC point (0x04 || X || Y), base64url.
  const point = Buffer.concat([
    Buffer.from([4]),
    Buffer.from(pubRaw.x, "base64url"),
    Buffer.from(pubRaw.y, "base64url"),
  ]);
  return { publicKey: b64url(point), privateKey: privRaw.d, publicJwk: pubRaw };
}

function vapidKeyObjects(publicKey, privateKey) {
  const point = Buffer.from(publicKey, "base64url");
  const x = b64url(point.subarray(1, 33));
  const y = b64url(point.subarray(33, 65));
  const priv = crypto.createPrivateKey({
    key: { kty: "EC", crv: "P-256", x, y, d: privateKey },
    format: "jwk",
  });
  return { priv };
}

export function vapidHeaders({ endpoint, publicKey, privateKey, subject }) {
  const { priv } = vapidKeyObjects(publicKey, privateKey);
  const audience = new URL(endpoint).origin;
  const header = b64url(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const body = b64url(JSON.stringify({
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: subject || "mailto:support@thrallo.com",
  }));
  const unsigned = `${header}.${body}`;
  const signature = crypto.sign("sha256", Buffer.from(unsigned), { key: priv, dsaEncoding: "ieee-p1363" });
  return { Authorization: `vapid t=${unsigned}.${b64url(signature)}, k=${publicKey}` };
}

// RFC 8291: encrypt `payload` for a subscription's p256dh/auth keys. Returns the aes128gcm
// body (header block || ciphertext) ready to POST with Content-Encoding: aes128gcm.
export function encryptPayload(payload, { p256dh, auth }, { asPrivateKey = null, salt = null } = {}) {
  const userPub = Buffer.from(p256dh, "base64url");
  const authSecret = Buffer.from(auth, "base64url");

  const ecdh = crypto.createECDH("prime256v1");
  if (asPrivateKey) ecdh.setPrivateKey(asPrivateKey);
  else ecdh.generateKeys();
  const asPub = ecdh.getPublicKey(); // uncompressed point, 65 bytes
  const sharedSecret = ecdh.computeSecret(userPub);

  const saltBytes = salt || crypto.randomBytes(16);

  // IKM = HKDF(auth, ecdh_secret, "WebPush: info" || ua_public || as_public, 32)
  const ikm = Buffer.from(crypto.hkdfSync(
    "sha256", sharedSecret, authSecret,
    Buffer.concat([Buffer.from("WebPush: info\0"), userPub, asPub]), 32,
  ));
  const cek = Buffer.from(crypto.hkdfSync("sha256", ikm, saltBytes, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(crypto.hkdfSync("sha256", ikm, saltBytes, Buffer.from("Content-Encoding: nonce\0"), 12));

  // RFC 8188 single-record body: padding delimiter 0x02 appended to the plaintext.
  const plain = Buffer.concat([Buffer.from(JSON.stringify(payload)), Buffer.from([2])]);
  const cipher = crypto.createCipheriv("aes-128-gcm", cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);

  const recordSize = Buffer.alloc(4);
  recordSize.writeUInt32BE(ciphertext.length + 16 + 65 + 21);
  const headerBlock = Buffer.concat([saltBytes, recordSize, Buffer.from([asPub.length]), asPub]);
  return Buffer.concat([headerBlock, ciphertext]);
}

// POST one notification to a push endpoint. Returns { ok, status, gone } — `gone` means the
// subscription is dead (404/410) and should be pruned.
export async function sendWebPush({ subscription, payload, vapid, ttl = 3600, fetchImpl = fetch }) {
  const body = encryptPayload(payload, subscription.keys);
  const headers = {
    ...vapidHeaders({ endpoint: subscription.endpoint, ...vapid }),
    "Content-Encoding": "aes128gcm",
    "Content-Type": "application/octet-stream",
    TTL: String(ttl),
    Urgency: "normal",
  };
  const res = await fetchImpl(subscription.endpoint, { method: "POST", headers, body });
  return { ok: res.ok, status: res.status, gone: res.status === 404 || res.status === 410 };
}
