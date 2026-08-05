// Provider routing is a billing-lane decision, decided once and enforced everywhere.
//
// The defect: the owner's active connection was Codex, and resolveBuildContext's own header said
// "a Codex-subscription selection falls back to managed for builds". Seven managed gpt-5.6 calls
// spent the owner's managed credits on a build they had routed elsewhere.

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveBuildContext } from "../../shell/server/lib/appBuild/buildContext.mjs";
import {
  resolveProviderPolicy, permittedAlternatives, usesManagedCredits, preflightSummary, BILLING_LANES,
} from "../../shell/server/lib/appBuild/providerPolicy.mjs";
import { planEndAction } from "../../shell/server/lib/appBuild/appBuildService.mjs";

const codexResolver = async () => ({ provider: "codex", secret: null });

// Every model-powered stage dispatches through buildProvider(intent) from ONE resolved context per
// job — so proving the context proves the stages. The intents each stage actually passes:
const STAGE_INTENTS = [
  ["contract", "generate"], ["design", "generate"],
  ["foundation", "generate"], ["data/backend", "edit"], ["primary journey", "edit"],
  ["supporting screens", "edit"], ["polish", "edit"],
  ["build repair", "edit"], ["verification repair", "edit"],
];

test("TRACE — with Codex active, every stage resolves to Codex on the connected allowance", async () => {
  const context = await resolveBuildContext("owner-1", { credentialResolver: codexResolver });

  assert.equal(context.providerLabel, "codex");
  assert.equal(context.byok, true, "byok:true means no managed reservation and no managed debit");
  assert.equal(context.policy.primaryProvider, "codex");
  assert.equal(context.policy.billingLane, BILLING_LANES.connectedAllowance);
  assert.equal(context.policy.allowManagedFallback, false);
  assert.deepEqual(context.policy.allowedFallbackProviders, []);
  assert.ok(context.policy.resolvedAt, "resolved_at is stamped");
  assert.equal(context.policy.selectedBy, "active_connection");

  for (const [stage, intent] of STAGE_INTENTS) {
    const provider = context.buildProvider(intent);
    // The Codex transport, not an OpenAI-managed model. Its runTurn hits the ChatGPT backend.
    assert.equal(typeof provider.runTurn, "function", `${stage}: a real provider`);
    assert.ok(!/gpt-5\.6-(sol|terra)/.test(provider.model || ""),
      `${stage} must not resolve to a managed gpt-5.6 model`);
  }
  // And managed credits are structurally out of reach for this lane.
  assert.equal(usesManagedCredits(context.policy), false);
});

test("TRACE — the managed lane is only ever chosen when the connection IS managed", async () => {
  const managed = await resolveBuildContext("owner-1", {
    credentialResolver: async () => ({ provider: "managed", secret: null }),
  });
  assert.equal(managed.byok, false);
  assert.equal(managed.policy.billingLane, BILLING_LANES.managed);
  assert.equal(managed.policy.allowManagedFallback, true, "managed may fall back to itself");
});

test("FALLBACK — a Codex build cannot be steered onto managed via preferProvider", async () => {
  // This is the exact mid-build path that used to switch lanes.
  const context = await resolveBuildContext("owner-1", {
    credentialResolver: codexResolver, preferProvider: "managed",
  });
  assert.equal(context.providerLabel, "codex", "the preference is refused; the lane holds");
  assert.equal(context.byok, true);
});

test("FALLBACK — permittedAlternatives yields nothing for Codex, so a failure STOPS", () => {
  const policy = resolveProviderPolicy({ provider: "codex" });
  assert.deepEqual(permittedAlternatives(policy, ["managed", "anthropic", "xai"]), [],
    "no hidden fallback path exists");

  // And the planner's provider-blocked branch with zero alternatives is a plain stop that keeps
  // progress — not a switch, not a retry on another lane.
  const action = planEndAction(
    { status: "failed", error: "provider quota exceeded: rate limited" },
    { attempt: 1, alternatives: [], autoFallback: true },
  );
  assert.equal(action.kind, "request_user_input", "the build stops and says why");
  assert.match(action.message, /no other provider is connected/i);
});

test("RETRIES — a retry re-resolves under the same active connection, preserving the policy", async () => {
  // Retries and repair jobs call resolveBuildContext again with providerOverride (null unless a
  // permitted switch happened). With Codex active and no permitted alternatives, every re-resolve
  // lands on Codex — including background repair agents, which share this exact entry point.
  for (const preferProvider of [null, undefined, "codex"]) {
    const context = await resolveBuildContext("owner-1", {
      credentialResolver: codexResolver, preferProvider,
    });
    assert.equal(context.providerLabel, "codex");
    assert.equal(context.policy.allowManagedFallback, false);
  }
});

test("RESERVATIONS — a non-managed lane creates none and debits nothing", async () => {
  // dispatchCheck's reservation branch is gated on lifecycle.managed; byok:true lanes never enter
  // it. Pinned at the source level so a refactor cannot quietly widen it.
  const { readFileSync } = await import("node:fs");
  const service = readFileSync("shell/server/lib/appBuild/appBuildService.mjs", "utf8");
  assert.match(service, /if \(ceiling && lifecycle\.managed && lifecycle\.reservations\)/,
    "the managed reservation branch requires the managed lane");
  // BYOK settle path never debits managed credits: settle() short-circuits on byok.
  const jobs = readFileSync("shell/server/lib/buildJobs.mjs", "utf8");
  assert.match(jobs, /if \(byok\) \{\s*\n?\s*serverLog\(job, `billing: BYOK/,
    "the BYOK settle path bills the owner's provider, not managed credits");
});

test("PREFLIGHT — the summary states the lane before any live spend", () => {
  const summary = preflightSummary(resolveProviderPolicy({ provider: "codex" }));
  assert.match(summary, /Provider: Codex/);
  assert.match(summary, /Billing lane: connected allowance/);
  assert.match(summary, /Managed fallback: disabled/);
  assert.match(summary, /Managed credits at risk: 0/);
});
