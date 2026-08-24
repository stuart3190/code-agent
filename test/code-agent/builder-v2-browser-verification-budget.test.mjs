import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  browserVerificationBudget, browserVerificationUsesBackend,
} from "../../shell/server/lib/builderV2/browserVerificationBudget.mjs";

const journey = (steps) => ({
  id: "enter-demo-competition",
  steps: Array.from({ length: steps }, (_, index) => ({ action: `step ${index + 1}` })),
});

const contract = (steps) => ({
  interactionContract: {
    flows: Array.from({ length: steps }, (_, index) => ({
      journeyId: "enter-demo-competition",
      stepIndex: index,
      controls: [{ machineId: `ctl-${index}` }],
      actions: index === steps - 1 ? [{ machineId: "act-submit" }] : [],
    })),
  },
});

test("retained smoke shape budgets smoke and journey sequentially before sandbox cleanup", () => {
  const budget = browserVerificationBudget({
    journey: journey(5), contract: contract(5), usesBackend: false,
  });
  assert.equal(budget.basis.stepCount, 5);
  assert.equal(budget.basis.usesBackend, false);
  assert.ok(budget.wallMs >= budget.appTimeoutMs + budget.journeyTimeoutMs + budget.cleanupHeadroomMs);
  assert.ok(budget.wallSeconds > 255,
    "the post-repair run must not retain the obsolete 240s container plus 15s runner cutoff");
});

test("browser allowance grows with validated journey structure", () => {
  const small = browserVerificationBudget({ journey: journey(2), contract: contract(2) });
  const large = browserVerificationBudget({ journey: journey(9), contract: contract(9) });
  assert.ok(large.journeyTimeoutMs > small.journeyTimeoutMs);
  assert.ok(large.wallSeconds > small.wallSeconds);
});

test("stateful smoke receives capability proof time without changing the journey contract", () => {
  const staticBudget = browserVerificationBudget({ journey: journey(4), contract: contract(4), usesBackend: false });
  const statefulBudget = browserVerificationBudget({ journey: journey(4), contract: contract(4), usesBackend: true });
  assert.ok(statefulBudget.appTimeoutMs > staticBudget.appTimeoutMs);
  assert.ok(statefulBudget.wallSeconds > staticBudget.wallSeconds);
});

test("static runtime skips auth and CRUD smoke while contracted backend runtime keeps it", () => {
  assert.equal(browserVerificationUsesBackend({ accounts: false, durableMutation: false }), false);
  assert.equal(browserVerificationUsesBackend({ accounts: true, durableMutation: false }), true);
  assert.equal(browserVerificationUsesBackend({ accounts: false, durableMutation: true }), true);
});

test("production wiring sends separate phase budgets and skips backend smoke for static contracts", async () => {
  const runtime = await readFile(new URL(
    "../../shell/server/lib/builderV2/runtimeComposition.mjs", import.meta.url,
  ), "utf8");
  const sandbox = await readFile(new URL("../../build-worker/sandbox.mjs", import.meta.url), "utf8");

  assert.doesNotMatch(runtime, /kind === "browser_verify" \? 240/);
  assert.match(runtime, /activeEnvelope\?\.runtimeRequirements[\s\S]*?contractRuntimeRequirements\(journeyContract\)/);
  assert.match(runtime, /usesBackend = browserVerificationUsesBackend\(runtimeRequirements\)/);
  assert.match(runtime, /payload: \{ previewUrl: previewResult\.url,[\s\S]*?usesBackend,[\s\S]*?appTimeoutMs:[\s\S]*?journeyTimeoutMs:/);
  assert.match(runtime, /wallSeconds: browserBudget\.wallSeconds/);
  assert.match(sandbox, /payload\.appTimeoutMs \|\| payload\.timeoutMs/);
  assert.match(sandbox, /payload\.journeyTimeoutMs \|\| payload\.timeoutMs/);
});
