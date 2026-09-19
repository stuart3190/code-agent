import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeByokSafety,
  normalizeByokSafetyDocument,
  validateByokSafetyInput,
  byokDispatchCheck,
  byokControlsEnabled,
  BYOK_CONTROLS,
} from "../../shell/server/lib/appBuild/byokSafety.mjs";

test("BYOK controls default to disabled in every stored shape", () => {
  for (const stored of [null, {}, { global: {} }, { providers: {} }, { maxCostPerBuild: 0 }]) {
    const settings = normalizeByokSafety(stored);
    for (const key of BYOK_CONTROLS) assert.equal(settings[key], null, `${key} must default to off`);
    assert.equal(byokControlsEnabled(stored), false);
  }
});

test("per-provider safeguards override global defaults independently", () => {
  const document = {
    global: { maxCostPerBuild: 10, maxRepairJobs: 2 },
    providers: { xai: { maxCostPerBuild: 3 }, openai: { maxCostPerBuild: null } },
  };
  assert.equal(normalizeByokSafety(document, { provider: "xai" }).maxCostPerBuild, 3);
  assert.equal(normalizeByokSafety(document, { provider: "xai" }).maxRepairJobs, 2);
  assert.equal(normalizeByokSafety(document, { provider: "openai" }).maxCostPerBuild, null);
  assert.equal(normalizeByokSafety(document, { provider: "anthropic" }).maxCostPerBuild, 10);
  assert.equal(normalizeByokSafety({ maxDailySpend: 7 }).maxDailySpend, 7, "legacy flat documents remain readable");
});

test("the stored settings document contains normalized controls and no key material", () => {
  const document = normalizeByokSafetyDocument({
    global: { maxCostPerBuild: "5", maxDailySpend: "", warnThreshold: -1 },
    providers: { xai: { maxRepairJobs: "2" }, gemini: {} },
    timezone: "Europe/London",
    secret_encrypted: "sk-live-should-never-appear",
    key: "sk-live-nope",
  }, { providers: ["xai"] });
  assert.equal(document.global.maxCostPerBuild, 5);
  assert.equal(document.global.maxDailySpend, null);
  assert.equal(document.global.warnThreshold, null);
  assert.equal(document.providers.xai.maxRepairJobs, 2);
  assert.ok(!("gemini" in document.providers));
  assert.equal(document.timezone, "Europe/London");
  assert.doesNotMatch(JSON.stringify(document), /sk-live|secret|key/i);
});

test("invalid BYOK safeguards are rejected before storage", () => {
  assert.equal(validateByokSafetyInput({ global: { maxCostPerBuild: 5 } }).ok, true);
  assert.equal(validateByokSafetyInput({ global: { maxCostPerBuild: null } }).ok, true);
  assert.equal(validateByokSafetyInput({ global: { maxCostPerBuild: -5 } }).ok, false);
  assert.equal(validateByokSafetyInput({ global: { maxCostPerBuild: "abc" } }).ok, false);
  assert.equal(validateByokSafetyInput({ global: { maxRepairJobs: 1.5 } }).ok, false);
  assert.equal(validateByokSafetyInput({ global: { nonsense: 1 } }).ok, false);
  assert.equal(validateByokSafetyInput({ timezone: "Not/AZone" }).ok, false);
  assert.equal(validateByokSafetyInput({ timezone: "Europe/London" }).ok, true);
});

test("BYOK dispatch checks enforce only configured owner safeguards", () => {
  assert.equal(byokDispatchCheck({ maxDailySpend: 10 }, { dailySpend: 4 }).ok, true);
  assert.equal(byokDispatchCheck({ maxDailySpend: 10 }, { dailySpend: 10 }).reason, "max_daily_spend");
  assert.equal(byokDispatchCheck({ maxCostPerBuild: 5 }, { lifecycleCost: 6 }).reason, "max_cost_per_build");
  assert.equal(byokDispatchCheck({ maxRepairJobs: 1 }, { repairJobs: 1 }).reason, "max_repair_jobs");
  assert.equal(byokDispatchCheck({ approvalThreshold: 3 }, { projectedCost: 9 }).reason, "approval_required");
  assert.equal(byokDispatchCheck(null, { dailySpend: 999_999 }).ok, true);
});
