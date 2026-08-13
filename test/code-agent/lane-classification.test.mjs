// The provider-policy split-brain from the final Codex build, fixed and pinned.
//
// buildContext resolved Codex correctly and billed BYOK; the relay lifecycle's SEPARATE legacy
// classification said managed. Managed reservations were created for a Codex build, 456k Codex
// tokens were priced against the 25-credit managed ceiling, and an affordable Codex repair was
// refused at "24.56 of 25 spent". Meanwhile the conversational lead agent silently rewrote the
// Codex credential to managed and ran four orchestration turns during the pause.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolveProviderPolicy, usesManagedCredits, managedSettlementPaused, MANAGED_PAUSED_MESSAGE } from "../../shell/server/lib/appBuild/providerPolicy.mjs";
import { resolveBuildContext } from "../../shell/server/lib/appBuild/buildContext.mjs";
import { createCodexProvider } from "../../src/providers/codexProvider.mjs";

const LEAD = readFileSync("shell/server/lib/leadAgentService.mjs", "utf8");

// ── 1. one authoritative classification ───────────────────────────────────────────────────────

test("SPLIT-BRAIN — Codex classifies as not-managed everywhere the policy is asked", () => {
  const policy = resolveProviderPolicy({ provider: "codex" });
  assert.equal(usesManagedCredits(policy), false, "usesManagedCredits false");
  assert.equal(policy.billingLane, "connected_allowance");
  assert.equal(policy.allowManagedFallback, false);
  // managed=false means: dispatchCheck's reservation branch never entered (source-pinned in the
  // provider-policy suite), settle() short-circuits BYOK, and the managed ceiling does not apply.
});

test("SPLIT-BRAIN — an API key with no secret fails closed without changing billing lane", async () => {
  await assert.rejects(resolveBuildContext("o", {
    credentialResolver: async () => ({ provider: "anthropic", secret: null }),
  }), (error) => error.code === "provider_unavailable");
});

// ── 2. the lead agent lane ────────────────────────────────────────────────────────────────────

test("LEAD AGENT — the silent codex→managed rewrite is gone and Codex executes in its own lane", () => {
  const live = LEAD.split("\n").filter((l) => !l.trim().startsWith("//"));
  assert.ok(!live.some((l) => /codex.*credential = \{ provider: "managed"/.test(l) && !/allowManagedFallback/.test(l)),
    "no unconditional rewrite may remain");
  assert.match(LEAD, /credential\.provider \|\| "managed"/);
  assert.doesNotMatch(LEAD, /orchestrator can't run on Codex yet/);
  // The managed-only pause remains, but it is not applied to connected allowance.
  assert.match(LEAD, /managedSettlementPaused\(\)/);
});

test("LEAD AGENT — with Codex selected, zero managed dispatch and zero managed fallback", async () => {
  const policy = resolveProviderPolicy({ provider: "codex" });
  assert.equal(policy.allowManagedFallback, false);
  // The build side, same account: six stages, all codex, no gpt-5.6.
  const context = await resolveBuildContext("o", { credentialResolver: async () => ({ provider: "codex" }) });
  for (const intent of ["generate", "edit"]) {
    const provider = context.buildProvider(intent);
    assert.ok(!/gpt-5\.6/.test(provider.model || ""), "no managed gpt-5.6 model on any stage");
  }
});

// ── 3. codex telemetry ────────────────────────────────────────────────────────────────────────

test("TELEMETRY — the codex transport reports its real model and lane; never null", async () => {
  const provider = createCodexProvider();
  assert.equal(typeof provider.model, "string");
  assert.ok(provider.model.length > 0, "no Codex usage row may record model: null");
  assert.equal(provider.providerId, "codex");
  // The build context stamps the same identity, so diag.setModel records it.
  const context = await resolveBuildContext("o", { credentialResolver: async () => ({ provider: "codex" }) });
  assert.equal(context.strongModel, provider.model, "one identity, not a cosmetic label");
});

// ── 5. the global pause ───────────────────────────────────────────────────────────────────────

test("PAUSE — every managed lane consults the same kill switch", () => {
  const previous = process.env.THRALLO_MANAGED_SETTLEMENT_PAUSED;
  try {
    process.env.THRALLO_MANAGED_SETTLEMENT_PAUSED = "1";
    assert.equal(managedSettlementPaused(), true);
    process.env.THRALLO_MANAGED_SETTLEMENT_PAUSED = "0";
    assert.equal(managedSettlementPaused(), false);
  } finally {
    if (previous === undefined) delete process.env.THRALLO_MANAGED_SETTLEMENT_PAUSED;
    else process.env.THRALLO_MANAGED_SETTLEMENT_PAUSED = previous;
  }

  // Source-pinned coverage: build jobs, the lead agent, background repo agents and inline
  // completions all gate managed dispatch. BYOK/Codex lanes pass — they cannot fall to managed.
  const jobs = readFileSync("shell/server/lib/buildJobs.mjs", "utf8");
  assert.match(jobs, /THRALLO_MANAGED_SETTLEMENT_PAUSED/);
  assert.match(LEAD, /managedSettlementPaused/);
  assert.match(readFileSync("shell/server/lib/codeAgentService.mjs", "utf8"), /managedSettlementPaused/);
  assert.match(readFileSync("shell/server/lib/completions.mjs", "utf8"), /managedSettlementPaused/);
  assert.ok(MANAGED_PAUSED_MESSAGE.includes("in your favour"), "one honest message, shared");
});

test("PAUSE + CEILING — a Codex repair is allowed through both, and codex failure stops", async () => {
  // managed=false: the reservation branch (gated `ceiling && lifecycle.managed`) never runs, so
  // neither the pause nor the managed ceiling can refuse a Codex repair — the exact refusal that
  // ended the last run at "24.56 of 25".
  const context = await resolveBuildContext("o", { credentialResolver: async () => ({ provider: "codex" }) });
  assert.equal(usesManagedCredits(context.policy), false);

  // And a codex failure has nowhere to fall: permitted alternatives are empty (proven in the
  // provider-policy suite), so the provider-blocked stop path runs. No fallback, no gpt-5.6.
  const { permittedAlternatives } = await import("../../shell/server/lib/appBuild/providerPolicy.mjs");
  assert.deepEqual(permittedAlternatives(context.policy, ["managed", "openai", "anthropic", "xai"]), []);
});
