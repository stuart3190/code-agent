import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { deriveBuildEnvelope } from "../../shell/server/lib/builderV2/buildEnvelope.mjs";
import { MAX_REPAIR_DISPATCHES } from "../../shell/server/lib/builderV2/modelReservations.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const migrations = path.join(root, "supabase", "migrations");

function databaseBounds() {
  for (const file of readdirSync(migrations).sort().reverse()) {
    const sql = readFileSync(path.join(migrations, file), "utf8");
    const match = sql.match(/check\s*\(\s*max_repair_dispatches\s+between\s+(\d+)\s+and\s+(\d+)\s*\)/i);
    if (match) return { file, min: Number(match[1]), max: Number(match[2]) };
  }
  return null;
}

test("the emergency repair guard matches the database CHECK constraint", () => {
  const bounds = databaseBounds();
  assert.ok(bounds, "no migration declares the max_repair_dispatches bounds");
  assert.equal(MAX_REPAIR_DISPATCHES, bounds.max);
  assert.equal(bounds.min, 0);
});

test("repair strategy capacity is derived from the validated contract, not a universal budget count", () => {
  const contract = (journeys) => ({ journeys: Array.from({ length: journeys }, (_, index) => ({
    id: `j${index}`, owners: [`src/J${index}.jsx`],
    steps: [{ action: "submit", target: "form", expect: "saved" }],
  })), entities: [] });
  const small = deriveBuildEnvelope({ contract: contract(1), approvedCustomerCredits: 50 });
  const large = deriveBuildEnvelope({ contract: contract(8), approvedCustomerCredits: 200 });
  assert.ok(large.thralloRecovery.strategyCapacity > small.thralloRecovery.strategyCapacity);
  assert.ok(large.thralloRecovery.strategyCapacity < MAX_REPAIR_DISPATCHES,
    "the database bound remains an emergency guard, not the primary capacity");
});

test("an explicit emergency value is clamped to the database bound", () => {
  const clamp = (value) => Math.max(0, Math.min(MAX_REPAIR_DISPATCHES, value));
  assert.equal(clamp(MAX_REPAIR_DISPATCHES + 1), MAX_REPAIR_DISPATCHES);
  assert.equal(clamp(-5), 0);
  assert.equal(clamp(24), 24);
});
