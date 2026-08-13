import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AUDITED_MAIN_COMMIT,
  baselineViolations,
  classifySafetyState,
  collectGitBaseline,
  collectMigrationBaseline,
} from "../../ops/lib/remediationBaseline.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const KNOWN_GREEN_V2_BASELINE = "4785cb53dde39bf09d0dc2e5d12d98e62a0b0b81";

test("PR-01 — the implementation branch descends from the known-green V2 baseline", () => {
  const state = collectGitBaseline(ROOT);
  assert.equal(state.originMain, AUDITED_MAIN_COMMIT);
  assert.equal(state.matchesAuditedCommit, true);
  assert.ok(state.branch, "validation must run on a named integration branch");
  execFileSync("git", ["merge-base", "--is-ancestor", KNOWN_GREEN_V2_BASELINE, "HEAD"], {
    cwd: ROOT, stdio: "ignore",
  });
});

test("PR-01 — safety evidence reveals only state, never environment values or owner ids", () => {
  const secret = "sk-live-never-print-this";
  const owner = "00000000-0000-0000-0000-000000000001";
  const state = classifySafetyState({
    env: {
      THRALLO_MANAGED_SETTLEMENT_PAUSED: "1",
      THRALLO_BV2_KILL: "1",
      PROVIDER_SECRET: secret,
    },
    flags: new Map([
      ["bv2.enabled", false],
      ["bv2.owners", []],
      ["bv2.shadow", true],
      ["unrelated.secret", owner],
    ]),
  });
  assert.equal(state.complete, true);
  assert.equal(state.safe, true);
  assert.equal(state.observations.v2Owners.count, 0);
  const rendered = JSON.stringify(state);
  assert.doesNotMatch(rendered, new RegExp(secret));
  assert.doesNotMatch(rendered, new RegExp(owner));
});

test("PR-01 — missing evidence is unknown, never reported safe", () => {
  const state = classifySafetyState({ env: {}, flags: null });
  assert.equal(state.complete, false);
  assert.equal(state.safe, false);
  assert.equal(state.observations.settlementPause.observed, false);
  assert.equal(state.observations.v2Enabled.value, null);
  assert.equal(state.observations.v2Owners.safe, false);
});

test("PR-01 — unsafe live controls fail the safety classification", () => {
  const state = classifySafetyState({
    env: { THRALLO_MANAGED_SETTLEMENT_PAUSED: "0", THRALLO_BV2_KILL: "0" },
    flags: { "bv2.enabled": true, "bv2.owners": ["owner"] },
  });
  assert.equal(state.complete, true);
  assert.equal(state.safe, false);
});

test("PR-02 — authoritative active migration history has no duplicate versions", () => {
  const inventory = collectMigrationBaseline(path.join(ROOT, "supabase", "migrations"));
  assert.ok(inventory.count > 0);
  assert.match(inventory.manifestHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(inventory.duplicateVersions, []);
  const violations = baselineViolations({
    git: { matchesOriginMain: true, matchesAuditedCommit: true },
    migrations: inventory,
    safety: { complete: false, safe: false },
  });
  assert.deepEqual(violations, []);
});
