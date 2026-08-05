// EXECUTION tests for lifecycle lane classification — the tests the source-pins were not.
//
// For six days appBuildService.mjs called usesManagedCredits() without importing it. The
// ReferenceError was swallowed by a broad catch, every lifecycle silently classified managed,
// byokJobCeiling() returned null, and the in-job Codex ceiling never armed — one build ran to
// 32.65 credits against a 25-credit policy. The source-pin suite asserted the TEXT of the
// classification line and never executed it. These tests RUN createLifecycle end to end against
// the real credential store (memory mode), so a missing import, a broken policy dependency, or a
// reintroduced silent default fails here with the real error visible.

import { test } from "node:test";
import assert from "node:assert/strict";

process.env.PLATFORM_ENC_KEY = "11".repeat(32);
process.env.CODE_AGENT_STORE = "memory";
process.env.THRALLO_BUILD_CREDIT_CEILING = "25";

const { connectApiKey, connectCodexAuth, selectAiProvider, aiCredentialStore } = await import("../../shell/server/lib/aiCredentialStore.mjs");
const { createLifecycle, byokJobCeiling } = await import("../../shell/server/lib/appBuild/appBuildService.mjs");
const { managedUsageGuard } = await import("../../shell/server/lib/buildJobs.mjs");
const { creditsForUsage } = await import("../../src/billing/costModel.mjs");

// A minimal supabase-shaped client: every chain resolves to empty rows.
function fakeClient() {
  const result = Promise.resolve({ data: [], error: null });
  const chain = new Proxy(() => chain, { get: (t, prop) => (prop === "then" ? result.then.bind(result) : () => chain) });
  return { from: () => chain };
}

const DIAG = { id: "00000000-0000-4000-8000-00000000d1a9", totals: { cost: 0 }, contract: null, step: () => {}, finish: () => {} };

function lifecycleFor(owner) {
  return createLifecycle({
    owner, projectId: "00000000-0000-4000-8000-000000000010",
    diag: DIAG, originalInput: { mode: "build", prompt: "probe" }, mode: "build",
    client: fakeClient(),
  });
}

test("EXECUTION — a Codex owner classifies managed=false and the 25-credit in-job ceiling ARMS", async () => {
  const owner = "10000000-0000-4000-8000-000000000001";
  await connectCodexAuth(owner, JSON.stringify({ tokens: { access_token: "t", refresh_token: "r", account_id: "a" } }), {});
  const lifecycle = await lifecycleFor(owner);
  assert.equal(lifecycle.managed, false, "Codex must never classify managed");
  assert.equal(lifecycle.activeProvider, "codex");
  assert.equal(byokJobCeiling(lifecycle), 25, "the build ceiling reaches the job — the guard arms");
});

test("EXECUTION — a managed owner classifies managed=true and uses the managed guard path", async () => {
  const lifecycle = await lifecycleFor("10000000-0000-4000-8000-000000000002"); // no credentials at all
  assert.equal(lifecycle.managed, true);
  assert.equal(byokJobCeiling(lifecycle), null, "managed lanes keep their own allowance guard");
});

test("EXECUTION — an API key with a valid secret classifies managed=false; without one, per policy", async () => {
  const owner = "10000000-0000-4000-8000-000000000003";
  await connectApiKey(owner, "openai", `sk-proj-${"a".repeat(40)}`, { fetchImpl: async () => ({ ok: true }) });
  const withSecret = await lifecycleFor(owner);
  assert.equal(withSecret.managed, false, "a usable API key is the BYOK lane");
  assert.equal(byokJobCeiling(withSecret), 25);

  // Break the stored secret: the credential exists but decrypts to nothing usable. The effective
  // lane mirrors buildContext — no usable secret resolves to managed, by POLICY, and loudly at
  // the fetch layer (activeAiCredential's own error handling), never via a swallowed exception.
  const store = aiCredentialStore();
  const current = await store.getCredential(owner, "openai");
  await store.setCredential(owner, { ...current, secret_encrypted: "corrupted" });
  const withoutSecret = await lifecycleFor(owner);
  assert.equal(withoutSecret.managed, true, "no usable secret resolves to the managed lane per policy");
});

test("EXECUTION — a broken classification dependency FAILS VISIBLY instead of defaulting", async () => {
  // The old code wrapped classification in `catch { /* managed defaults */ }`; the missing-import
  // ReferenceError vanished there. Classification now runs outside any swallowing catch, so this
  // suite ITSELF is the tripwire: if usesManagedCredits (or any policy dependency) breaks again,
  // the Codex test above throws the real error instead of quietly passing with managed=true.
  // Pinned structurally: createLifecycle's classification is not inside a try that discards.
  const { readFileSync } = await import("node:fs");
  const source = readFileSync("shell/server/lib/appBuild/appBuildService.mjs", "utf8");
  const body = source.slice(source.indexOf("export async function createLifecycle"), source.indexOf("function alternativesFor"));
  assert.ok(!/catch\s*\{\s*\/\*[^}]*managed defaults/.test(body), "the silent classification catch is gone");
  assert.match(body, /usesManagedCredits\(resolveProviderPolicy/);
  assert.match(source, /import \{[^}]*usesManagedCredits[^}]*\} from "\.\/providerPolicy\.mjs"/, "and the import EXISTS");
});

test("REPLAY — the 32.65-credit turn sequence stops at the guard before the ceiling cannot fit", async () => {
  // The run's 28 recorded turns (input, cached, output+reasoning), verbatim from its job log.
  const TURNS = [
    [960, 0, 1240], [1505, 0, 4468],
    [9110, 0, 2380], [11204, 0, 1365], [12603, 8704, 4745], [17339, 10752, 2420], [19496, 16896, 95],
    [10078, 0, 341], [16646, 0, 3803], [19540, 15872, 1108], [19639, 18944, 104],
    [12199, 2560, 179], [16864, 11776, 968], [17214, 15872, 7730], [24327, 16896, 1506],
    [24979, 2560, 532], [25047, 11776, 267], [23251, 11776, 395], [26895, 11776, 1996],
    [21514, 2560, 121], [25713, 2560, 4502], [26019, 20992, 314], [34923, 25088, 1271],
    [33533, 20992, 930], [34755, 33280, 538], [35440, 20992, 128],
    [20950, 2560, 451], [21143, 19968, 57],
  ];
  const tracked = { rows: [], add(u) { this.rows.push(u); }, summary() {
    return this.rows.reduce((a, u) => ({ input: a.input + u.input, output: a.output + u.output, cached: a.cached + u.cached, reasoning: 0, total: a.total + (u.total || 0) }), { input: 0, output: 0, cached: 0, reasoning: 0, total: 0 });
  } };
  const guard = managedUsageGuard(25, "gpt-5.5", tracked);

  let stoppedAt = null;
  for (const [index, [input, cached, output]] of TURNS.entries()) {
    try {
      await guard({ input, cached, output, reasoning: 0, total: input + output });
    } catch (error) {
      stoppedAt = { index: index + 1, error };
      break;
    }
  }
  assert.ok(stoppedAt, "the guard fires");
  assert.equal(stoppedAt.index, 21, "the stop lands at supporting turn 2, where the run crossed 25");
  const spent = creditsForUsage({ usage: tracked.summary(), model: "gpt-5.5" });
  assert.ok(spent <= 25.2, `metered spend at the stop: ${spent.toFixed(2)} (the run really reached 33.22)`);
  assert.equal(tracked.rows.length, 21, "turns 22-28 — 12.1 further credits — never start");
});
