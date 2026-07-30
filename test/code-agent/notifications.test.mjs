// Phase 22: web push (RFC 8291 aes128gcm + RFC 8292 VAPID) proven by doing the RECEIVER's
// side in the test — generate a real browser-style subscription keypair, encrypt with the
// sender code, decrypt per the RFC, and compare. Plus capability registration and the
// domain-check extensions.

import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { generateVapidKeys, vapidHeaders, encryptPayload, sendWebPush } from "../../shell/server/lib/notifications/webPush.mjs";
import { registerCoreCapabilities } from "../../shell/server/lib/capabilities/coreCapabilities.mjs";
import { listCapabilities, capabilityToolDefs, resetCapabilityRegistryForTests } from "../../shell/server/lib/capabilityRegistry.mjs";
import { previewDomainAllowed } from "../../shell/server/routes/previewDomainCheck.mjs";

function browserSubscription() {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  return {
    endpoint: "https://push.example.com/send/abc123",
    keys: {
      p256dh: Buffer.from(ecdh.getPublicKey()).toString("base64url"),
      auth: crypto.randomBytes(16).toString("base64url"),
    },
    receiverPrivate: ecdh,
  };
}

// RFC 8291 receiver: parse the aes128gcm body and decrypt.
function decryptPayload(body, subscription) {
  const salt = body.subarray(0, 16);
  const keyLen = body[20];
  const asPub = body.subarray(21, 21 + keyLen);
  const ciphertext = body.subarray(21 + keyLen);
  const shared = subscription.receiverPrivate.computeSecret(asPub);
  const authSecret = Buffer.from(subscription.keys.auth, "base64url");
  const userPub = Buffer.from(subscription.keys.p256dh, "base64url");
  const ikm = Buffer.from(crypto.hkdfSync("sha256", shared, authSecret,
    Buffer.concat([Buffer.from("WebPush: info\0"), userPub, asPub]), 32));
  const cek = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const tag = ciphertext.subarray(ciphertext.length - 16);
  const data = ciphertext.subarray(0, ciphertext.length - 16);
  const decipher = crypto.createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(data), decipher.final()]);
  assert.equal(plain[plain.length - 1], 2, "single-record padding delimiter");
  return JSON.parse(plain.subarray(0, plain.length - 1).toString());
}

test("web push payloads round-trip through RFC 8291 encryption", () => {
  const sub = browserSubscription();
  const payload = { title: "Preview ready", body: "FocusFlow is live.", url: "https://x.preview.thrallo.com/" };
  const body = encryptPayload(payload, sub.keys);
  assert.deepEqual(decryptPayload(body, sub), payload);
});

test("VAPID headers carry a valid ES256 JWT for the endpoint origin", () => {
  const vapid = generateVapidKeys();
  const { Authorization } = vapidHeaders({
    endpoint: "https://fcm.googleapis.com/send/xyz",
    publicKey: vapid.publicKey, privateKey: vapid.privateKey, subject: "mailto:t@thrallo.com",
  });
  const jwt = Authorization.match(/t=([^,]+),/)[1];
  const [header, claims, signature] = jwt.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url")), { typ: "JWT", alg: "ES256" });
  const parsed = JSON.parse(Buffer.from(claims, "base64url"));
  assert.equal(parsed.aud, "https://fcm.googleapis.com");
  assert.equal(parsed.sub, "mailto:t@thrallo.com");
  const pub = crypto.createPublicKey({ key: { kty: "EC", crv: "P-256", x: vapid.publicJwk.x, y: vapid.publicJwk.y }, format: "jwk" });
  const valid = crypto.verify("sha256", Buffer.from(`${header}.${claims}`),
    { key: pub, dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url"));
  assert.equal(valid, true);
  assert.ok(Authorization.endsWith(`k=${vapid.publicKey}`));
});

test("sendWebPush posts aes128gcm to the endpoint and flags dead subscriptions", async () => {
  const vapid = generateVapidKeys();
  const sub = browserSubscription();
  let captured = null;
  const fetchImpl = async (url, init) => { captured = { url, init }; return { ok: true, status: 201 }; };
  const out = await sendWebPush({ subscription: sub, payload: { title: "t" }, vapid, fetchImpl });
  assert.equal(out.ok, true);
  assert.equal(captured.url, sub.endpoint);
  assert.equal(captured.init.headers["Content-Encoding"], "aes128gcm");
  assert.ok(captured.init.headers.Authorization.startsWith("vapid t="));
  assert.deepEqual(decryptPayload(Buffer.from(captured.init.body), sub), { title: "t" });

  const gone = await sendWebPush({ subscription: sub, payload: { title: "t" }, vapid, fetchImpl: async () => ({ ok: false, status: 410 }) });
  assert.equal(gone.gone, true);
});

test("publish, configure_domain, and create_automation are registry capabilities", async () => {
  const saved = { url: process.env.PROVISIOND_URL, token: process.env.PROVISIOND_TOKEN, key: process.env.OPENAI_API_KEY };
  process.env.PROVISIOND_URL = "http://127.0.0.1:1";
  process.env.PROVISIOND_TOKEN = "t";
  process.env.OPENAI_API_KEY = "sk-unit";
  try {
    resetCapabilityRegistryForTests();
    registerCoreCapabilities();
    const ids = listCapabilities().map((c) => c.id);
    for (const id of ["publish", "configure_domain", "create_automation"]) {
      assert.ok(ids.includes(id), `${id} must be registered`);
    }
    const defs = await capabilityToolDefs({});
    const publish = defs.find((d) => d.name === "publish");
    assert.ok(publish, "publish must reach the Lead Agent's generated tool list");
    assert.deepEqual([...publish.parameters.required].sort(), [...Object.keys(publish.parameters.properties)].sort());
    const automation = defs.find((d) => d.name === "create_automation");
    assert.deepEqual(automation.parameters.properties.kind.enum, ["pr_review", "scheduled_task"]);
  } finally {
    resetCapabilityRegistryForTests();
    process.env.PROVISIOND_URL = saved.url ?? "";
    if (!saved.url) delete process.env.PROVISIOND_URL;
    process.env.PROVISIOND_TOKEN = saved.token ?? "";
    if (!saved.token) delete process.env.PROVISIOND_TOKEN;
    process.env.OPENAI_API_KEY = saved.key ?? "";
    if (!saved.key) delete process.env.OPENAI_API_KEY;
  }
});

test("the ask gate approves published app labels via provisiond /exists", async () => {
  const saved = process.env.PROVISIOND_URL;
  process.env.PROVISIOND_URL = "http://127.0.0.1:8791";
  try {
    const fetchImpl = async (url) => ({ ok: true, json: async () => ({ exists: url.includes("label=focusflow") }) });
    assert.equal(await previewDomainAllowed("focusflow.app.thrallo.com", { fetchImpl }), true);
    assert.equal(await previewDomainAllowed("ghost.app.thrallo.com", { fetchImpl }), false);
  } finally {
    process.env.PROVISIOND_URL = saved ?? "";
    if (!saved) delete process.env.PROVISIOND_URL;
  }
});
