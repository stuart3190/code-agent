// Read the LIVE credit balance client-side, under the user's own session, through the PROVEN ledger
// SDK (src/billing/ledger.mjs) + costModel. This is the honest Phase 3.1 path: RLS `select_own` means
// createLedger(userClient).getBalance(owner) returns ONLY the caller's rows — the UI can't see another
// tenant's ledger. No pricing is re-derived; getBalance is Σ delta over the user's rows.

import { createLedger } from "../../../../src/billing/ledger.mjs";
import { creditsForTurn } from "../../../../src/billing/costModel.mjs";
import { client } from "./backend.js";

export async function readBalance(ownerId) {
  const led = createLedger(client());
  // Balance and entitlement in one read: the tier drives the Plans panel state
  // (Current plan ✓ / switch guard) and the tier tag on the balance meter.
  const [balance, ent] = await Promise.all([
    led.getBalance(ownerId),
    led.getEntitlement(ownerId).catch(() => null),
  ]);
  return { ...balance, tier: ent?.tier ?? null };
}

export { creditsForTurn };
