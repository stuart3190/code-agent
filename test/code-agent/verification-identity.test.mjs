import test from "node:test";
import assert from "node:assert/strict";

import {
  appAuthRateLimitDefect,
  createVerificationIdentity,
  seedVerificationVisitorStorage,
  verificationCredentials,
  verificationToken,
} from "../../shell/server/lib/appBuild/verificationIdentity.mjs";

test("verification credentials are stable per project and purpose without crossing projects", () => {
  const project = createVerificationIdentity({ appId: "project-a", scope: "journey-a", secret: "test-authority" });
  assert.equal(verificationToken(project, "journey:journey-a"),
    verificationToken({ ...project }, "journey:journey-a"));
  assert.deepEqual(verificationCredentials(project, "smoke"),
    verificationCredentials(createVerificationIdentity({
      appId: "project-a", scope: "other", secret: "test-authority",
    }), "smoke"),
    "generic smoke reuses one app-scoped account across all repair rounds and journeys");
  assert.notDeepEqual(verificationCredentials(project, "smoke"),
    verificationCredentials(createVerificationIdentity({
      appId: "project-b", scope: "journey-a", secret: "test-authority",
    }), "smoke"));
});

test("anonymous visitor state is fresh per verification round while account credentials stay stable", () => {
  const first = createVerificationIdentity({
    appId: "project-a", scope: "journey-a", visitorScope: "round-1", secret: "test-authority",
  });
  const second = createVerificationIdentity({
    appId: "project-a", scope: "journey-a", visitorScope: "round-2", secret: "test-authority",
  });
  assert.notDeepEqual(verificationCredentials(first, "visitor", { kind: "visitor" }),
    verificationCredentials(second, "visitor", { kind: "visitor" }));
  assert.notDeepEqual(verificationCredentials(first, "mechanics", { kind: "visitor" }),
    verificationCredentials(second, "mechanics", { kind: "visitor" }));
  assert.deepEqual(verificationCredentials(first, "journey:journey-a"),
    verificationCredentials(second, "journey:journey-a"),
    "repair rounds reuse the explicit test account instead of consuming another signup");
});

test("the verifier restores visitor credentials but never injects a privileged session", async () => {
  const calls = [];
  const context = { addInitScript: async (fn, arg) => calls.push({ fn: String(fn), arg }) };
  const identity = createVerificationIdentity({ appId: "project-a", scope: "journey-a", secret: "test-authority" });
  assert.equal(await seedVerificationVisitorStorage(context, identity), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].arg.storageKey, "visitor-session:project-a");
  assert.match(calls[0].arg.storedCredentials.email, /^verify-visitor-/);
  assert.doesNotMatch(calls[0].fn, /access[_-]?token|refresh[_-]?token|sessionStorage/i,
    "only ordinary persisted credentials are restored; the app must obtain its own real session");

  const mechanicsCalls = [];
  const mechanicsContext = { addInitScript: async (fn, arg) => mechanicsCalls.push({ fn: String(fn), arg }) };
  assert.equal(await seedVerificationVisitorStorage(mechanicsContext, identity, "mechanics"), true);
  assert.notEqual(mechanicsCalls[0].arg.storedCredentials.email, calls[0].arg.storedCredentials.email,
    "mechanics must not mutate the journey visitor's durable app state");
});

test("an app id alone cannot derive production verifier credentials", () => {
  assert.equal(verificationCredentials({ appId: "public-project-id", scope: "journey" }, "smoke"), null);
  assert.throws(() => createVerificationIdentity({ appId: "project", scope: "journey" }),
    (error) => error.code === "verification_identity_authority_missing");
});

test("only an app-auth 429 for a verifier-owned identity is a platform defect", () => {
  const response = (status, url, email) => ({
    status: () => status,
    url: () => url,
    request: () => ({ postData: () => JSON.stringify({ email }) }),
  });
  assert.equal(appAuthRateLimitDefect(response(200,
    "https://example.supabase.co/functions/v1/app-auth", "verify+abc@thrallo.dev")), null);
  assert.equal(appAuthRateLimitDefect(response(429,
    "https://example.supabase.co/functions/v1/other", "verify+abc@thrallo.dev")), null);
  assert.equal(appAuthRateLimitDefect(response(429,
    "https://example.supabase.co/functions/v1/app-auth", "customer@example.com")), null);
  assert.equal(appAuthRateLimitDefect(response(429,
    "https://example.supabase.co/functions/v1/app-auth", "verify+abc@thrallo.dev"))?.code,
  "journey_verifier_auth_rate_limited");
});
