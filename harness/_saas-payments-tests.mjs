import assert from "node:assert/strict";
import { cleanProduct } from "../shell/server/lib/saasPayments.mjs";
import { REACT_VITE } from "../src/scaffolds/reactVite.mjs";

assert.deepEqual(cleanProduct({ name: " Pro plan ", description: " Access ", currency: "GBP", unitAmount: 1299 }), {
  name: "Pro plan", description: "Access", currency: "gbp", unit_amount: 1299, usage_units: 0, action_scope: [],
});
assert.deepEqual(cleanProduct({ name: "100 runs", currency: "gbp", unitAmount: 499, usageUnits: 100, actionScope: ["ai_text", "ai_image"] }).usage_units, 100);
assert.throws(() => cleanProduct({ name: "", currency: "gbp", unitAmount: 100 }), /Product name/);
assert.throws(() => cleanProduct({ name: "Plan", currency: "pounds", unitAmount: 100 }), /Currency/);
assert.throws(() => cleanProduct({ name: "Plan", currency: "gbp", unitAmount: 1.5 }), /Price/);
assert.throws(() => cleanProduct({ name: "Plan", currency: "gbp", unitAmount: 0 }), /Price/);

const backendIndex = REACT_VITE["src/lib/backend/index.js"];
const backendImpl = REACT_VITE["src/lib/backend/supabaseBackend.js"];
assert.match(backendIndex, /export const payments/);
assert.match(backendImpl, /Sign in before starting checkout/);
assert.match(backendImpl, /productId/);
assert.doesNotMatch(backendImpl, /STRIPE_SECRET_KEY/);

console.log("SaaS payment tests passed");
