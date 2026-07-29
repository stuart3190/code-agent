import assert from "node:assert/strict";
import { cleanIntegrationConfig } from "../shell/server/lib/appIntegrations.mjs";
import { REACT_VITE } from "../src/scaffolds/reactVite.mjs";

assert.deepEqual(cleanIntegrationConfig({
  webhookUrl: " https://hooks.example.com/event ", email: " ALERTS@EXAMPLE.COM ", phone: " +447700900000 ",
}), { webhook_url: "https://hooks.example.com/event", email: "alerts@example.com", phone: "+447700900000" });
assert.deepEqual(cleanIntegrationConfig({}), { webhook_url: null, email: null, phone: null });
assert.throws(() => cleanIntegrationConfig({ email: "bad" }), /valid notification email/);
assert.throws(() => cleanIntegrationConfig({ phone: "07700900000" }), /international format/);

const sdk = REACT_VITE["src/lib/backend/supabaseBackend.js"];
assert.match(sdk, /notifications/);
assert.match(sdk, /notify_self/);
assert.match(sdk, /email_self/);
assert.match(sdk, /async emit/);
assert.doesNotMatch(sdk, /TWILIO_AUTH_TOKEN|RESEND_API_KEY/);

console.log("App integration tests passed");
