// WP-6 — contract tiering, capability binding, image intents and the C4 preview-eligibility
// invariant, proven on the stored booking contract — including the exact regression the plan
// demands: core booking green, newsletter and cancellation failing, preview SHIPS with those
// two listed as pending increments.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { tierContract, bindCapabilities, imageIntents, previewEligibility } from "../../shell/server/lib/builderV2/contractTiering.mjs";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const CONTRACT = JSON.parse(readFileSync(path.join(FIXTURES, "cf130c23", "contract.json"), "utf8"));

test("WP6 — the booking contract tiers deterministically: primary journey + its entities are essential", () => {
  const tiers = tierContract(CONTRACT);
  assert.deepEqual(tiers.essential.journeys, ["reserve-picking-slot"], "the ONE primary journey");
  assert.ok(tiers.essential.entities.includes("booking"), `essential entities: ${tiers.essential.entities.join(", ")}`);
  assert.ok(tiers.secondary.journeys.includes("newsletter-signup"));
  assert.ok(tiers.secondary.journeys.includes("manage-reservation"));
  assert.deepEqual(tierContract(CONTRACT), tiers, "byte-stable");

  // The user marking a journey critical promotes it — and only it.
  const promoted = tierContract(CONTRACT, { userCritical: ["newsletter-signup"] });
  assert.deepEqual(promoted.essential.journeys.sort(), ["newsletter-signup", "reserve-picking-slot"]);
});

test("WP6 — capability bindings derive from the contract and validate against the registry", () => {
  const bindings = bindCapabilities(CONTRACT);
  const names = bindings.map((b) => b.name).sort();
  assert.ok(names.includes("booking"), "the booking vocabulary binds the booking capability");
  assert.ok(names.includes("newsletter"));
  assert.ok(names.includes("crud") && names.includes("session"), "kernel capabilities always bind");
  assert.ok(!names.includes("contact"), "no contact vocabulary in this contract — no binding");
});

test("WP6 — image intents come from the contract, one hero plus one per non-home route", () => {
  const intents = imageIntents(CONTRACT);
  assert.equal(intents[0].slot, "hero");
  assert.equal(intents[0].orientation, "landscape");
  const routeSlots = intents.filter((i) => i.slot.startsWith("route:"));
  assert.equal(routeSlots.length, (CONTRACT.routes || []).filter((r) => r.path !== "/").length);
  assert.deepEqual(imageIntents(CONTRACT), intents, "deterministic — the Asset Service caches on these");
});

test("WP6/C4 — THE BOOKING REGRESSION: core green, newsletter + cancellation fail → preview SHIPS with two pendings", () => {
  const tiers = tierContract(CONTRACT);
  const verdict = previewEligibility({
    tiers,
    gates: { ok: true },
    journeyResults: { journeys: [
      { id: "reserve-picking-slot", title: "reserve", status: "pass" },
      { id: "prevent-over-capacity-booking", title: "capacity", status: "pass" },
      { id: "manage-reservation", title: "cancel", status: "fail" },
      { id: "browse-farm-information", title: "browse", status: "pass" },
      { id: "newsletter-signup", title: "newsletter", status: "fail" },
    ] },
    backendRowFailures: [],
    blockingErrors: [],
  });
  assert.equal(verdict.eligible, true, verdict.failures.join("; "));
  assert.deepEqual(verdict.pendingIncrements.map((p) => p.journeyId).sort(),
    ["manage-reservation", "newsletter-signup"],
    "exactly the two failing secondaries surface as pending work");
});

test("WP6/C4 — essential failures BLOCK: journey fail, backend-row fail, blocking errors, missing verification", () => {
  const tiers = tierContract(CONTRACT);
  const base = {
    tiers, gates: { ok: true },
    journeyResults: { journeys: [{ id: "reserve-picking-slot", title: "r", status: "pass" }] },
    backendRowFailures: [], blockingErrors: [],
  };
  assert.equal(previewEligibility(base).eligible, true);

  assert.equal(previewEligibility({ ...base, journeyResults: { journeys: [{ id: "reserve-picking-slot", status: "fail" }] } }).eligible, false);
  assert.equal(previewEligibility({ ...base, journeyResults: { journeys: [] } }).eligible, false, "never-verified essential blocks");
  assert.equal(previewEligibility({ ...base, backendRowFailures: [{ journeyId: "reserve-picking-slot" }] }).eligible, false);
  assert.equal(previewEligibility({ ...base, blockingErrors: ["500 POST /api"] }).eligible, false);
  assert.equal(previewEligibility({ ...base, gates: { ok: false } }).eligible, false);

  // A secondary backend-row failure does NOT block.
  assert.equal(previewEligibility({ ...base, backendRowFailures: [{ journeyId: "newsletter-signup" }] }).eligible, true);
});
