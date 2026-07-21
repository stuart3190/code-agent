import assert from "node:assert/strict";
import {
  MANAGED_FINAL_JOB_GRACE_CREDITS, managedAffordableCreditLimit, managedJobCreditLimit,
} from "../shell/server/lib/billingLimits.mjs";

assert.equal(MANAGED_FINAL_JOB_GRACE_CREDITS, 5);
assert.equal(managedJobCreditLimit({ mode: "plan" }), 2);
assert.equal(managedAffordableCreditLimit({ balance: 0.01, mode: "build" }), 5.01);
assert.equal(managedAffordableCreditLimit({ balance: 30, mode: "build" }), 35);
assert.equal(managedAffordableCreditLimit({ balance: 100, mode: "build" }), 60);
assert.equal(managedAffordableCreditLimit({ balance: 100, mode: "plan" }), 2);
console.log("billing affordability limits: pass");
