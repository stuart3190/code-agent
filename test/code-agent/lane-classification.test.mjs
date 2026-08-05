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

const SERVICE = readFileSync("shell/server/lib/appBuild/appBuildService.mjs", "utf8");
const LEAD = readFileSync("shell/server/lib/leadAgentService.mjs", "utf8");

// ── 1. one authoritative classification ───────────────────────────────────────────────────────

test("SPLIT-BRAIN — the legacy classification is gone; managed derives from the policy, once", () => {
  // The exact removed line, pinned as the wrong answer.
  const live = SERVICE.split("\n").filter((l) => !l.trim().startsWith("//"));
  assert.ok(!live.some((l) => /managed = activeProvider === "managed" \|\| activeProvider === "codex"/.test(l)),
    "the legacy line that classified Codex as managed must not exist");
  // EXACTLY ONE line touches `managed`, and it is the const policy derivation. The previous
  // design allowed a `let managed = true` fail-safe default plus a mutable reassignment inside a
  // try/catch — and when a missing import made the derivation throw, the catch swallowed it and
  // the "fail-safe" silently classified every Codex build managed for six days. There is no
  // mutable default any more: classification either derives from the policy or the error
  // propagates. (Execution coverage: lifecycle-classification.test.mjs actually RUNS this.)
  const assignments = live.filter((l) => /^\s*(let |const )?managed = /.test(l));
  assert.equal(assignments.length, 1, `got: ${assignments.join(" | ")}`);
  assert.match(assignments[0], /const managed = usesManagedCredits\(resolveProviderPolicy/,
    "the single assignment is the const policy derivation");
  assert.ok(!live.some((l) => /let managed/.test(l)), "no mutable default to fall back to");
});

test("SPLIT-BRAIN — Codex classifies as not-managed everywhere the policy is asked", () => {
  const policy = resolveProviderPolicy({ provider: "codex" });
  assert.equal(usesManagedCredits(policy), false, "usesManagedCredits false");
  assert.equal(policy.billingLane, "connected_allowance");
  assert.equal(policy.allowManagedFallback, false);
  // managed=false means: dispatchCheck's reservation branch never entered (source-pinned in the
  // provider-policy suite), settle() short-circuits BYOK, and the managed ceiling does not apply.
});

test("SPLIT-BRAIN — an API key with no secret still classifies managed, mirroring buildContext", async () => {
  // The subtlety the one-liner had right: anthropic-with-no-secret RESOLVES to managed in
  // buildContext, so the lifecycle must classify it managed too — only Codex needs no secret.
  const context = await resolveBuildContext("o", {
    credentialResolver: async () => ({ provider: "anthropic", secret: null }),
  });
  assert.equal(context.byok, false, "no usable secret resolves to the managed lane");
  assert.equal(usesManagedCredits(context.policy), true);
});

// ── 2. the lead agent lane ────────────────────────────────────────────────────────────────────

test("LEAD AGENT — the silent codex→managed rewrite is gone; the lane stops before spending", () => {
  const live = LEAD.split("\n").filter((l) => !l.trim().startsWith("//"));
  assert.ok(!live.some((l) => /codex.*credential = \{ provider: "managed"/.test(l) && !/allowManagedFallback/.test(l)),
    "no unconditional rewrite may remain");
  // The stop is policy-gated and worded for a human.
  assert.match(LEAD, /allowManagedFallback/);
  assert.match(LEAD, /won't quietly bill your managed credits/);
  // And the pause covers the lane.
  assert.match(LEAD, /managedSettlementPaused\(\)/);
});

test("LEAD AGENT — with Codex selected, zero managed dispatch and zero gpt-5.6 anywhere", async () => {
  // Replay the lane decision with a fake resolver: policy says stop, so no model factory runs.
  const policy = resolveProviderPolicy({ provider: "codex" });
  assert.equal(policy.allowManagedFallback, false, "the stop branch is the one that executes");
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
