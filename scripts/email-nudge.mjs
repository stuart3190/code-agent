// Credits-remaining nudge — a day or two after signup, remind builders they still have free
// credits waiting. Runs on the VPS via buildr-email-nudge.timer (daily). Targets accounts that:
//   * are 24-72h old (past the first-session window, before they've forgotten us),
//   * already got the welcome email (so we don't email brand-new/unconfirmed accounts),
//   * have NOT had a nudge yet (idempotent via email_log),
//   * still have credits left (balance > 0 — the ones worth pulling back).
// Fail-soft: no RESEND_API_KEY -> clean exit. Sends at most one nudge per user, ever.
//
//   node scripts/email-nudge.mjs [--dry-run]

import { loadEnv } from "../shell/server/lib/env.mjs";
import { serviceClient } from "../shell/server/lib/supabase.mjs";
import { createLedger } from "../src/billing/ledger.mjs";
import { emailConfigured, sendEmail, nudgeEmail } from "../shell/server/lib/email.mjs";

loadEnv();
const DRY = process.argv.includes("--dry-run");
const ledger = createLedger(serviceClient());

if (!emailConfigured() && !DRY) {
  console.log("[nudge] RESEND_API_KEY not set — nothing to do.");
  process.exit(0);
}

const svc = serviceClient();
const now = Date.now();
const within = (iso, minH, maxH) => {
  const age = (now - new Date(iso).getTime()) / 3600e3;
  return age >= minH && age <= maxH;
};

// Who's already had a welcome / a nudge.
const { data: logs } = await svc.from("email_log").select("owner, kind");
const welcomed = new Set((logs || []).filter((l) => l.kind === "welcome").map((l) => l.owner));
const nudged = new Set((logs || []).filter((l) => l.kind === "nudge").map((l) => l.owner));

// Builder accounts in the 24-72h window (auth.admin lists real emails; app end-users excluded).
let sent = 0, considered = 0, page = 1, more = true;
while (more) {
  const { data, error } = await svc.auth.admin.listUsers({ page, perPage: 200 });
  if (error) { console.error(`[nudge] listUsers: ${error.message}`); break; }
  const users = data?.users || [];
  more = users.length === 200;
  page++;

  for (const u of users) {
    if (!u.email || u.email.includes("@apps.buildr101.com")) continue;
    if (!within(u.created_at, 24, 72)) continue;
    if (!welcomed.has(u.id) || nudged.has(u.id)) continue;
    considered++;

    let balance = 0;
    try { balance = (await ledger.getBalance(u.id)).total || 0; } catch {}
    if (balance <= 0) continue; // fully spent = engaged; nothing to nudge back to

    const credits = Math.round(balance);
    console.log(`[nudge] ${DRY ? "would send" : "sending"} to ${u.email} (${credits} cr)`);
    if (DRY) continue;

    const { subject, text } = nudgeEmail(credits);
    if (await sendEmail({ to: u.email, subject, text })) {
      await svc.from("email_log").upsert({ owner: u.id, kind: "nudge", sent_at: new Date().toISOString() });
      sent++;
    }
  }
}

console.log(`[nudge] done — considered ${considered}, ${DRY ? "would send" : "sent"} ${sent}.`);
process.exit(0);
