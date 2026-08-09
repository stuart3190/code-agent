import assert from "node:assert/strict";
import {
  createDevelopmentCredentialVault,
  createDeterministicAuthProvider,
  createHostCapabilities,
  createNativeAuthController,
  createPkceTransaction,
} from "../../shared/thrallo-client/src/index.mjs";

const provider = createDeterministicAuthProvider();
const vault = createDevelopmentCredentialVault();
const deviceId = "fixture-smoke-device-windows";
const capabilities = createHostCapabilities({ nativeKeychain: true });
let randomSequence = 0;
const pkceFactory = (options) => createPkceTransaction({
  ...options,
  randomBytes(length) {
    randomSequence += 1;
    return Uint8Array.from({ length }, (_, index) => (randomSequence * 41 + index * 17) % 256);
  },
});
const opened = [];

function controller() {
  return createNativeAuthController({
    provider,
    vault,
    capabilities,
    deviceId,
    now: provider.now,
    pkceFactory,
    browser: { openExternal: async (url) => opened.push(new URL(url).origin) },
  });
}

let checks = 0;
const first = controller();
const initiated = await first.startAuthorization();
assert.equal(first.getSnapshot().state, "awaiting_callback");
assert.equal(opened.length, 1);
checks += 1;

await first.handleCallback(provider.completeAuthorization(initiated.authorizationId));
assert.equal(first.getSnapshot().state, "authenticated");
checks += 1;

const restarted = controller();
await restarted.startup();
assert.equal(restarted.getSnapshot().state, "authenticated");
checks += 1;

await restarted.logout();
assert.equal(restarted.getSnapshot().state, "signed_out");
assert.deepEqual(vault.inspectKeys(), []);
checks += 1;

const signedInAgain = controller();
const next = await signedInAgain.startAuthorization();
await signedInAgain.handleCallback(provider.completeAuthorization(next.authorizationId));
provider.advance(901_000);
provider.revokeDevice({ accountId: "fixture-account-alpha", deviceId });
const revoked = controller();
await assert.rejects(revoked.startup());
assert.equal(revoked.getSnapshot().state, "revoked");
checks += 1;

assert.equal(checks, 5);
console.log(`Thrallo deterministic native-auth smoke: ${checks}/5`);
