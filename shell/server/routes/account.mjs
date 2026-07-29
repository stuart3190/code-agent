// POST /api/account/delete { confirm: true } — delete the signed-in account and EVERYTHING it
// owns. GDPR-grade cleanup, ordered so a mid-way failure can't strand a paying ghost:
//   1. cancel any active Stripe subscription IMMEDIATELY (abort on failure — never leave a
//      subscription billing an account we're about to erase),
//   2. every project via the same cascade project-delete uses (published sites + name claims,
//      custom domains, preview containers, per-app end users + entities, rows),
//   3. billing rows (credit_ledger, customers) and the encrypted BYOK key,
//   4. the auth user itself.
// Payment records themselves live at Stripe (retained by them for legal/tax purposes).

import { serviceClient } from "../lib/supabase.mjs";
import { deleteProjectCascade } from "./projects.mjs";
import { billing, stripe, haveStripeEnv } from "../lib/services.mjs";
import { clearKey } from "../lib/byokStore.mjs";

const send = (res, code, obj) => {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
};

export async function handleAccountDelete(req, res, body, owner) {
  if (body?.confirm !== true) {
    return send(res, 400, { error: "confirm: true is required — account deletion is permanent." });
  }
  try {
    const svc = serviceClient();
    const summary = { subscriptionCancelled: false, projects: 0, ledgerRows: false, byok: false };

    // 1. Stripe first, and hard-fail: an active subscription MUST die before the account does.
    if (haveStripeEnv()) {
      let sub = null;
      try {
        sub = await billing().activeSubscription(owner.id);
      } catch {
        sub = null; // no customer mapping / no billing rows — nothing to cancel
      }
      if (sub) {
        await stripe().subscriptions.cancel(sub.id); // immediate, not period-end
        summary.subscriptionCancelled = true;
      }
    }

    // 2. Every project, full infra cascade each (ownership is implied: selected BY owner).
    const { data: projects, error: pErr } = await svc.from("projects").select("id").eq("owner", owner.id);
    if (pErr) throw new Error(pErr.message);
    for (const p of projects || []) {
      await deleteProjectCascade(svc, p.id);
      summary.projects++;
    }

    // 3. Billing rows + BYOK key. The ledger is append-only in LIFE; erasure on account death is
    // the one sanctioned removal (the financial record of real payments stays at Stripe).
    await svc.from("credit_ledger").delete().eq("owner", owner.id);
    await svc.from("customers").delete().eq("owner", owner.id);
    summary.ledgerRows = true;
    await clearKey(owner.id).catch(() => {}); // absent table/row is fine
    summary.byok = true;

    // 4. The login itself — after this the bearer token this request rode in on is dead.
    const { error: uErr } = await svc.auth.admin.deleteUser(owner.id);
    if (uErr) throw new Error(uErr.message);

    send(res, 200, { deleted: true, ...summary });
  } catch (e) {
    console.error(`[account-delete] ${e?.stack || e}`);
    send(res, 500, { error: "The account could not be deleted. Please contact support." });
  }
}
