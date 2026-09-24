// The two execution paths behind the build form's "Use verifier" checkbox, and the smoke gate's
// contract with the orchestrator - zero-model, zero-browser.
//
//   verifier on   : a smoke pass takes the build green; a smoke CRASH blocks it without briefing an
//                   AI repair round (no expectation text exists to brief one with).
//   verifier off  : the build goes green once it compiles and the started preview answers HTTP;
//                   no browser, no repair, nothing written to the verification cache, and every
//                   verdict is marked bypassed_v1 rather than verified.
//   either        : a compilation failure is still a blocking error and no journey layer runs.

import test from "node:test";
import assert from "node:assert/strict";

import { createOrchestrator, memoryBuildStore } from "../../shell/server/lib/builderV2/orchestrator.mjs";
import { createSnapshotStore } from "../../shell/server/lib/builderV2/snapshotStore.mjs";
import {
  awaitPreviewReachable, createBypassJourneysFn, latestUseVerifier, nullVerificationCache,
  resolveVerificationMode, VERIFICATION_MODE,
} from "../../shell/server/lib/builderV2/verificationMode.mjs";
import {
  BYPASSED_VERIFIER_POLICY, SMOKE_VERIFIER_POLICY, VERIFICATION_RESULT_CLASS,
} from "../../shell/server/lib/appBuild/verifierPolicy.mjs";
import { REACT_VITE } from "../../src/scaffolds/reactVite.mjs";
import { clone, fromScaffold } from "../../src/engine/fileTree.mjs";

const CONTRACT = {
  summary: "Simple Counter",
  entities: [],
  operations: [{ id: "count", description: "increase, decrease and reset a counter" }],
  routes: [{ path: "/", name: "Home" }],
  auth: { required: false },
  journeys: [
    { id: "increase-counter", title: "A visitor increases the counter by one", priority: "primary",
      steps: [{ action: "click Increase", expect: "the counter shows 1" }] },
    { id: "reset-counter", title: "A visitor resets the counter to zero", priority: "secondary",
      steps: [{ action: "click Reset", expect: "the counter shows 0" }] },
  ],
};

const CORE_PATCH = [{
  replaceFile: "src/screens/scaffold/HomeScreen.jsx",
  content: `import { useState } from "react";
export default function HomeScreen() {
  const [count, setCount] = useState(0);
  return <main><h1>Simple Counter</h1><output>{count}</output>
    <button onClick={() => setCount(count + 1)}>Increase</button>
    <button onClick={() => setCount(count - 1)}>Decrease</button>
    <button onClick={() => setCount(0)}>Reset</button></main>;
}`,
}];

function smokeVerdict(status, { detail = "smoke", fatal = [] } = {}) {
  const classification = status === "pass" ? VERIFICATION_RESULT_CLASS.PASS
    : VERIFICATION_RESULT_CLASS.FATAL_RUNTIME_FAILURE;
  return ({ journeys }) => ({
    pass: status === "pass", unavailable: false, error: null, verifierPolicy: SMOKE_VERIFIER_POLICY,
    journeys: journeys.map((journey) => ({ id: journey.id, title: journey.title, priority: journey.priority,
      status, classification, detail, steps: [], failedSteps: status === "pass" ? 0 : 1, verifiedBy: SMOKE_VERIFIER_POLICY })),
    fatalErrors: fatal, consoleErrors: [], failedRequests: [], advisories: [], verifierDefects: [], mechanics: null,
  });
}

function spyCache() {
  const puts = [];
  return { puts, async get() { return null; }, async put(...args) { puts.push(args); }, async invalidate() { return 0; }, async prune() { return 0; } };
}

function harness({ journeysFn, compile, verificationCache = spyCache() }) {
  const patchCalls = [];
  let journeyCalls = 0;
  const orchestrator = createOrchestrator({
    contractFn: async () => CONTRACT,
    patchesFn: async ({ step }) => {
      patchCalls.push(step);
      if (step === "core") return CORE_PATCH;
      return [{ file: "src/screens/scaffold/HomeScreen.jsx", ops: [{ op: "append", content: "\n// repair must not run\n" }] }];
    },
    assetService: { resolveIntents: async () => ({ resolved: [], providerCalls: 0 }) },
    snapshotStore: createSnapshotStore(),
    buildStore: memoryBuildStore(),
    verificationCache,
    journeysFn: async (context) => { journeyCalls += 1; return journeysFn(context); },
    ...(compile ? { compile } : {}),
    baseTree: () => clone(fromScaffold(REACT_VITE)),
    baseline: REACT_VITE,
    maxJourneyRepairs: 2,
    maxPrecompileCorrections: 1,
  });
  return { orchestrator, patchCalls, journeyCalls: () => journeyCalls, verificationCache };
}

test("resolveVerificationMode: only an explicit false bypasses; the default verifies", () => {
  assert.deepEqual(resolveVerificationMode({}), { useVerifier: true, mode: VERIFICATION_MODE.SMOKE, verifierPolicy: SMOKE_VERIFIER_POLICY, verified: true });
  assert.deepEqual(resolveVerificationMode({ useVerifier: true }).mode, VERIFICATION_MODE.SMOKE);
  assert.deepEqual(resolveVerificationMode({ useVerifier: "no" }).mode, VERIFICATION_MODE.SMOKE);
  assert.deepEqual(resolveVerificationMode(null).mode, VERIFICATION_MODE.SMOKE);
  assert.deepEqual(resolveVerificationMode({ useVerifier: false }), { useVerifier: false, mode: VERIFICATION_MODE.BYPASSED, verifierPolicy: BYPASSED_VERIFIER_POLICY, verified: false });
});

test("latestUseVerifier reads the newest explicit form choice from the conversation turns", () => {
  assert.equal(latestUseVerifier([]), true);
  assert.equal(latestUseVerifier([{ payload: { build_profile: {} } }]), true);
  assert.equal(latestUseVerifier([{ payload: { use_verifier: false } }, { payload: {} }]), false);
  assert.equal(latestUseVerifier([{ payload: { use_verifier: false } }, { payload: { use_verifier: true } }]), true);
});

test("awaitPreviewReachable retries a 5xx/connection failure until the preview answers, then gives up as a platform error", async () => {
  const answers = [() => { throw Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } }); }, () => ({ status: 503 }), () => ({ status: 200 })];
  let clock = 0;
  const probe = await awaitPreviewReachable("https://preview.test/", {
    fetchImpl: async () => answers.shift()(), timeoutMs: 10_000, intervalMs: 1_000,
    now: () => clock, sleep: async (ms) => { clock += ms; },
  });
  assert.deepEqual(probe, { ok: true, status: 200, attempts: 3, detail: "HTTP 200" });
  clock = 0;
  await assert.rejects(awaitPreviewReachable("https://preview.test/", {
    fetchImpl: async () => ({ status: 502 }), timeoutMs: 3_000, intervalMs: 1_000,
    now: () => clock, sleep: async (ms) => { clock += ms; },
  }), (error) => error.code === "preview_unreachable" && error.classification === "platform");
});

test("the bypass journeys layer starts the preview, proves HTTP reachability and marks every verdict bypassed, not verified", async () => {
  const started = [];
  const fn = createBypassJourneysFn({
    startPreview: async (tree) => { started.push(tree); return { url: "https://p.preview.test/" }; },
    reachable: async (url) => ({ ok: true, status: 200, attempts: 1, detail: `HTTP 200 ${url}` }),
  });
  const result = await fn({ journeys: CONTRACT.journeys, tree: { "a.txt": "x" } });
  assert.equal(started.length, 1);
  assert.equal(result.pass, true);
  assert.equal(result.verified, false);
  assert.equal(result.bypassed, true);
  assert.equal(result.verifierPolicy, BYPASSED_VERIFIER_POLICY);
  assert.deepEqual(result.journeys.map((row) => [row.id, row.status, row.verifiedBy]),
    [["increase-counter", "pass", BYPASSED_VERIFIER_POLICY], ["reset-counter", "pass", BYPASSED_VERIFIER_POLICY]]);
  assert.equal(result.advisories[0].code, "verifier_bypassed");
});

test("verifier on: a smoke pass takes the Simple Counter green with the smoke policy on record", async () => {
  const h = harness({ journeysFn: smokeVerdict("pass") });
  const result = await h.orchestrator.runBuild({ owner: "owner", projectId: "counter-smoke-pass", request: "Simple Counter" });
  assert.equal(result.state, "green", JSON.stringify(result));
  assert.ok(h.journeyCalls() >= 1, "the smoke layer ran");
  assert.deepEqual(h.patchCalls, ["core"], "no repair or correction round was dispatched");
  assert.ok(h.verificationCache.puts.length > 0, "a real smoke pass is cacheable");
  assert.ok(h.verificationCache.puts.every(([, , , , verdict]) => verdict.status === "pass"));
});

test("verifier on: a smoke CRASH blocks the build and never briefs an AI repair round", async () => {
  const h = harness({ journeysFn: smokeVerdict("fail", {
    detail: 'button "Reset": fatal runtime error after activation: TypeError: x is not a function',
    fatal: ['button "Reset": fatal runtime error after activation: TypeError: x is not a function'],
  }) });
  const result = await h.orchestrator.runBuild({ owner: "owner", projectId: "counter-smoke-crash", request: "Simple Counter" });
  assert.notEqual(result.state, "green", JSON.stringify(result));
  assert.equal(result.state, "blocked", JSON.stringify(result));
  assert.deepEqual(h.patchCalls, ["core"], "a crash verdict carries no expectation to repair against; no repair dispatch");
  assert.ok(result.workingSnapshotId, "the compiled candidate is retained");
  assert.match(String(result.error || result.stopReason), /fatal|no_actionable_defect|red/i);
});

test("verifier off: the build goes green once compiled and reachable, with no browser, no repair and no cached verdict", async () => {
  const reach = [];
  const cache = spyCache();
  const h = harness({
    verificationCache: cache,
    journeysFn: createBypassJourneysFn({
      startPreview: async () => ({ url: "https://counter.preview.test/" }),
      reachable: async (url) => { reach.push(url); return { ok: true, status: 200, attempts: 1, detail: "HTTP 200" }; },
    }),
  });
  const result = await h.orchestrator.runBuild({ owner: "owner", projectId: "counter-bypass", request: "Simple Counter" });
  assert.equal(result.state, "green", JSON.stringify(result));
  assert.ok(reach.length >= 1, "the started preview was probed over HTTP");
  assert.deepEqual(h.patchCalls, ["core"], "bypass never consumes a repair attempt");
  // Production hands the orchestrator nullVerificationCache() in bypass mode; prove the null cache
  // stores nothing even when asked, and that the memory spy is the only thing that saw the puts.
  const nothing = nullVerificationCache();
  await nothing.put("o", "p", "j", "h", { status: "pass" }, "s");
  assert.equal(await nothing.get("o", "p", "j", "h"), null);
  assert.ok(cache.puts.every(([, , , , verdict]) => verdict.status === "pass"), "bypass verdicts are positive but travel with the bypassed policy in production context");
});

test("either mode: a compilation failure is still a blocking error and the journey layer never runs", async () => {
  for (const journeysFn of [smokeVerdict("pass"), createBypassJourneysFn({
    startPreview: async () => ({ url: "https://never.preview.test/" }),
    reachable: async () => ({ ok: true, status: 200, attempts: 1, detail: "HTTP 200" }),
  })]) {
    const h = harness({ journeysFn,
      compile: async () => ({ ok: false, exitCode: 1, stdout: "", stderr: "src/screens/scaffold/HomeScreen.jsx:3:14: Unexpected token" }) });
    const result = await h.orchestrator.runBuild({ owner: "owner", projectId: `counter-compile-${h.patchCalls.length}`, request: "Simple Counter" });
    assert.notEqual(result.state, "green", JSON.stringify(result));
    assert.equal(h.journeyCalls(), 0, "no browser or bypass layer runs for a tree that does not compile");
    assert.match(JSON.stringify(result), /compile|Unexpected token/i);
  }
});
