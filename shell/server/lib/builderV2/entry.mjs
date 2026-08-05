// The app_build_v2 shadow entry (finish plan WP-8; master plan Part 15).
//
// Eligibility is triple-gated and FAILS CLOSED: the THRALLO_BV2_KILL environment switch
// beats everything, then bv2.enabled must be on, then the owner must be enrolled in
// bv2.owners (true = everyone, or an explicit allowlist). Any flag-storage unhappiness
// means "not eligible" — Builder v1 is never affected by v2's infrastructure.
//
// Until WP-9 wires the model lanes behind its spend gate, an ELIGIBLE build still
// declines here (loudly, with the reason) and v1 builds exactly as before — so this
// deploys with zero behaviour change and the whole dispatch seam is already live.

import { killSwitchActive, flagOn, flagOnFor } from "./featureFlags.mjs";

export async function v2BuildEligible(owner, options = {}) {
  try {
    if (killSwitchActive(options.env || process.env)) return { eligible: false, reason: "THRALLO_BV2_KILL is set" };
    if (!(await flagOn("bv2.enabled", options))) return { eligible: false, reason: "bv2.enabled is off" };
    if (!(await flagOnFor("bv2.owners", owner, options))) return { eligible: false, reason: "owner is not enrolled in bv2.owners" };
    return { eligible: true, reason: "kill switch clear, bv2.enabled on, owner enrolled" };
  } catch (error) {
    return { eligible: false, reason: `flag read failed (fails closed): ${error.message}` };
  }
}

/**
 * Run one build through the v2 orchestrator. WP-9 provides the model seams; declining
 * with handled:false means the caller proceeds with Builder v1 unchanged.
 */
export async function startAppBuildV2() {
  return { handled: false, reason: "builder v2 model lanes are not wired yet (WP-9 spend gate)" };
}
