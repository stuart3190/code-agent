// Rollout guard rails (finish plan WP-16 / V2-26) — built and drill-tested BEFORE any
// owner defaults to v2, so the safety net exists the day the flag flips.
//
// Two tripwires, both reading ONLY bv2_builds (ground truth the orchestrator already
// writes; no new bookkeeping to drift):
//   per-owner: 2 consecutive failed/blocked v2 builds → that owner leaves bv2.owners
//              (their next build is v1) + an incident line.
//   global:    >20% of v2 builds failed/blocked over the last 6h (min 5 builds) →
//              bv2.enabled goes off for everyone + an incident line.
// Both act through the SAME flags the kill switch beats; nothing here can strand a
// customer on a broken lane.

import { serviceClient } from "../supabase.mjs";
import { flagValue, setFlag } from "./featureFlags.mjs";

const BAD_STATES = ["failed", "blocked"];
const GLOBAL_WINDOW_MS = 6 * 3600e3;
const GLOBAL_MIN_BUILDS = 5;
const GLOBAL_MAX_FAILURE_RATE = 0.2;

/**
 * Run after every v2 build settles. Returns { action, detail } — "none",
 * "owner_reverted" or "global_off" — and applies the flag change itself.
 */
export async function autoRollbackCheck({
  owner, client = serviceClient(), now = () => new Date(), flagOptions = undefined,
  log = (line) => console.log(`[bv2-rollout] ${line}`),
} = {}) {
  // ── per-owner: two consecutive bad builds ──────────────────────────────────────────────
  const { data: recent } = await client.from("bv2_builds")
    .select("state").eq("owner", owner)
    .order("started_at", { ascending: false }).limit(2);
  const flagWriteOptions = { ...(flagOptions?.client ? { client: flagOptions.client } : {}), updatedBy: "auto-rollback" };
  const consecutiveBad = (recent || []).length === 2 && recent.every((b) => BAD_STATES.includes(b.state));
  if (consecutiveBad) {
    const owners = await flagValue("bv2.owners", flagOptions);
    if (Array.isArray(owners) && owners.includes(owner)) {
      await setFlag("bv2.owners", owners.filter((o) => o !== owner), flagWriteOptions);
      log(`INCIDENT owner_reverted: ${owner} — 2 consecutive ${recent.map((b) => b.state).join("+")} builds; owner now builds on v1`);
      return { action: "owner_reverted", detail: recent.map((b) => b.state) };
    }
  }

  // ── global: failure rate over the window ───────────────────────────────────────────────
  const since = new Date(now().getTime() - GLOBAL_WINDOW_MS).toISOString();
  const { data: window } = await client.from("bv2_builds")
    .select("state").gte("started_at", since);
  const total = (window || []).length;
  if (total >= GLOBAL_MIN_BUILDS) {
    const bad = window.filter((b) => BAD_STATES.includes(b.state)).length;
    if (bad / total > GLOBAL_MAX_FAILURE_RATE) {
      if (await flagValue("bv2.enabled", flagOptions)) {
        await setFlag("bv2.enabled", false, flagWriteOptions);
        log(`INCIDENT global_off: ${bad}/${total} v2 builds failed in 6h (> ${GLOBAL_MAX_FAILURE_RATE * 100}%) — bv2.enabled is OFF`);
        return { action: "global_off", detail: { bad, total } };
      }
    }
  }
  return { action: "none" };
}
