// Offline BYOK tests — NO network, NO DB. Exercises the pure surfaces of shell/server/lib/byokStore:
// the AES-256-GCM encrypt/decrypt round-trip, the masking, and fail-closed behaviour when the server
// encryption key (BYOK_ENC_KEY) is missing or malformed. Run: node shell/harness/_byok-tests.mjs
//
// We set a known BYOK_ENC_KEY in process.env BEFORE importing the store — env.mjs's loadEnv never
// overrides an already-set var, so this test controls the key deterministically.

process.env.BYOK_ENC_KEY = "0".repeat(64); // 32 bytes of zeros as 64 hex chars — a valid test key

const { _internal, maskKey, byokConfigured } = await import("../server/lib/byokStore.mjs");

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); }
}

const SAMPLE = "sk-ant-api03-SECRETMIDDLEabcdefghij0123456789wxyz";

// ── crypto round-trip ────────────────────────────────────────────────────────────────────────
const ct = _internal.encrypt(SAMPLE);
check("encrypt produces iv:tag:data (3 base64 parts)", typeof ct === "string" && ct.split(":").length === 3);
check("ciphertext does not contain the plaintext", !ct.includes(SAMPLE) && !ct.includes("SECRETMIDDLE"));
check("decrypt recovers the exact key", _internal.decrypt(ct) === SAMPLE);

const ct2 = _internal.encrypt(SAMPLE);
check("same plaintext encrypts differently each time (random IV)", ct !== ct2 && _internal.decrypt(ct2) === SAMPLE);

// GCM auth tag: tampering with the ciphertext must fail decryption, not silently return garbage.
let tamperThrew = false;
try {
  const [iv, tag, data] = ct.split(":");
  const bad = Buffer.from(data, "base64"); bad[0] ^= 0xff;
  _internal.decrypt([iv, tag, bad.toString("base64")].join(":"));
} catch { tamperThrew = true; }
check("tampered ciphertext throws (GCM auth)", tamperThrew);

// ── masking ──────────────────────────────────────────────────────────────────────────────────
const masked = maskKey(SAMPLE);
check("mask keeps the sk-ant- prefix", masked.startsWith("sk-ant-…"));
check("mask keeps the last 4 chars", masked.endsWith("wxyz"));
check("mask hides the secret middle", !masked.includes("SECRETMIDDLE"));

// ── fail-closed when BYOK_ENC_KEY is absent / malformed ────────────────────────────────────────
byokConfigured(); // ensure loadEnv has run once (with our valid key present, so it isn't overridden)

const saved = process.env.BYOK_ENC_KEY;
delete process.env.BYOK_ENC_KEY;
check("byokConfigured() is false with no BYOK_ENC_KEY", byokConfigured() === false);
let missingThrew = false;
try { _internal.encrypt(SAMPLE); } catch { missingThrew = true; }
check("encrypt fails closed with no BYOK_ENC_KEY", missingThrew);

process.env.BYOK_ENC_KEY = "abcd"; // wrong length
check("byokConfigured() is false with a malformed key", byokConfigured() === false);

process.env.BYOK_ENC_KEY = saved; // restore
check("byokConfigured() true again after restore", byokConfigured() === true);

console.log(`\n${fail === 0 ? "ALL GREEN" : "FAILURES"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
