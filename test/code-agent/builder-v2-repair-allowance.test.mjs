// THE REPAIR ALLOWANCE AND THE DATABASE MUST AGREE.
//
// `bv2_builds.max_repair_dispatches` carries a CHECK constraint. A caller that computes a larger
// allowance does not get more repair rounds — the INSERT is rejected and the build dies at create,
// before a single line is generated. On 2026-08-20 a budget-derived allowance of 24 did exactly
// that to every build: the customer saw "The isolated build worker stopped before completion" and
// the worker log carried one line, `violates check constraint
// "bv2_builds_max_repair_dispatches_check"`.
//
// The constant and the migration are pinned to each other here so the next person to raise one is
// told to raise the other.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { MAX_REPAIR_DISPATCHES } from "../../shell/server/lib/builderV2/modelReservations.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const migrations = path.join(root, "supabase", "migrations");

/** The CHECK bounds the database actually enforces on the repair-dispatch column. */
function databaseBounds() {
  for (const file of readdirSync(migrations).sort().reverse()) {
    const sql = readFileSync(path.join(migrations, file), "utf8");
    const match = sql.match(/check\s*\(\s*max_repair_dispatches\s+between\s+(\d+)\s+and\s+(\d+)\s*\)/i);
    if (match) return { file, min: Number(match[1]), max: Number(match[2]) };
  }
  return null;
}

test("the repair-allowance constant matches the database CHECK constraint", () => {
  const bounds = databaseBounds();
  assert.ok(bounds, "no migration declares the max_repair_dispatches bounds");
  assert.equal(MAX_REPAIR_DISPATCHES, bounds.max,
    `MAX_REPAIR_DISPATCHES is ${MAX_REPAIR_DISPATCHES} but ${bounds.file} enforces a maximum of ${bounds.max}. `
    + "Raising the allowance requires a migration that widens the constraint first — otherwise every "
    + "build fails at INSERT with a check-constraint violation.");
  assert.equal(bounds.min, 0, "a build may legitimately be created with no repair allowance");
});

test("every budget the platform can approve derives an allowance the database will accept", () => {
  // The derivation in runtimeComposition, applied across the whole range of approved ceilings —
  // including the advanced-class ceiling that produced the failure.
  const estimate = 2.5;
  const derive = (ceiling) => Math.max(2, Math.min(MAX_REPAIR_DISPATCHES, Math.floor(ceiling / estimate)));
  for (const ceiling of [1, 3, 6, 9, 12, 25, 40, 60, 100, 250, 1000]) {
    const allowance = derive(ceiling);
    assert.ok(Number.isInteger(allowance), `ceiling ${ceiling} produced a non-integer allowance`);
    assert.ok(allowance >= 0 && allowance <= MAX_REPAIR_DISPATCHES,
      `ceiling ${ceiling} derived ${allowance}, outside the database's accepted range`);
    // A small budget must still buy the two rounds every build has always had.
    assert.ok(allowance >= 2, `ceiling ${ceiling} derived ${allowance}, fewer than the baseline two rounds`);
  }
  // The CAP IS HEADROOM, NOT THE GOVERNOR. A 60-credit build derives 24 rounds and the database
  // permits 40, so the approved budget decides how much repair happens and the constraint simply
  // stops being in the way. When the two were equal, ten dispatches had to cover the core AND
  // every secondary journey, and the secondaries got none.
  assert.equal(derive(60), 24);
  assert.ok(derive(60) < MAX_REPAIR_DISPATCHES, "the budget binds before the constraint does");
});

test("an explicit caller allowance is clamped, never passed through raw", () => {
  const clamp = (value) => Math.max(0, Math.min(MAX_REPAIR_DISPATCHES, value));
  assert.equal(clamp(MAX_REPAIR_DISPATCHES + 1), MAX_REPAIR_DISPATCHES,
    "an over-large explicit value is clamped to what the database accepts, not rejected");
  assert.equal(clamp(-5), 0);
  assert.equal(clamp(3), 3);
  assert.equal(clamp(24), 24, "a value the database accepts passes through untouched");
});
