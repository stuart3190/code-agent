// One-time welcome grant — the free trial every new account gets (costModel.WELCOME_CREDITS).
// Idempotent by construction: the ledger's (owner, ref, kind, bucket) unique index means the
// stable ref `welcome:<owner>` can only ever land once; every later call no-ops at the DB.
// Bucket "topup" so the gift rolls over freely and never touches the tier bundle/rollover
// machinery. Called opportunistically (balance reads, generate) — cheap either way.

import { WELCOME_CREDITS } from "../../../src/billing/costModel.mjs";
import { ledger } from "./services.mjs";
import { sendOnce, welcomeEmail } from "./email.mjs";

export async function ensureWelcomeGrant(ownerId) {
  if (!ownerId || !(WELCOME_CREDITS > 0)) return;
  try {
    await ledger().grant({
      owner: ownerId,
      credits: WELCOME_CREDITS,
      bucket: "topup",
      kind: "grant",
      cycle: "welcome",
      ref: `welcome:${ownerId}`,
    });
  } catch {
    /* never block the caller on the gift */
  }
  // Welcome email — idempotent via email_log, fail-soft, only for real builder accounts.
  try {
    await sendOnce({ ownerId, kind: "welcome", build: () => welcomeEmail(WELCOME_CREDITS) });
  } catch { /* never block the caller on the email */ }
}
