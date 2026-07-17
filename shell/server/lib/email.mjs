// Lifecycle email — welcome + credits-remaining nudge, sent via the Resend API. Fail-soft: no
// RESEND_API_KEY, no send (and never throws into the caller — a missing email must never break a
// balance read or a build). Idempotency via the email_log table: sendOnce(owner, kind, …) sends
// at most once per (owner, kind), so hooking it into an opportunistic path (ensureWelcomeGrant,
// called on every balance read) still yields exactly one email.

import { serviceClient } from "./supabase.mjs";
import { optionalEnv } from "./env.mjs";

const RESEND_URL = "https://api.resend.com/emails";
const FROM = () => optionalEnv("RESEND_FROM") || "Buildr101 <hello@buildr101.com>";
const APP_URL = () => (optionalEnv("APP_URL") || "https://buildr101.com").replace(/\/$/, "");

export function emailConfigured() {
  return !!optionalEnv("RESEND_API_KEY");
}

// Low-level send. Returns true on success, false on any failure / no key. Never throws.
export async function sendEmail({ to, subject, text }) {
  const key = optionalEnv("RESEND_API_KEY");
  if (!key || !to) return false;
  try {
    const res = await fetch(RESEND_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ from: FROM(), to: [to], subject, text }),
    });
    if (!res.ok) {
      console.warn(`[email] send failed ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
      return false;
    }
    return true;
  } catch (e) {
    console.warn(`[email] send error: ${String(e.message || e).slice(0, 160)}`);
    return false;
  }
}

// Send exactly once per (owner, kind). Records email_log only AFTER a successful send, so a
// transient failure retries on the next opportunity. `build(to)` returns { subject, text } or null.
export async function sendOnce({ ownerId, kind, build }) {
  if (!ownerId || !emailConfigured()) return "skip";
  const svc = serviceClient();
  const { data: already } = await svc.from("email_log").select("owner").eq("owner", ownerId).eq("kind", kind).maybeSingle();
  if (already) return "already";

  const { data: u } = await svc.auth.admin.getUserById(ownerId);
  const to = u?.user?.email;
  if (!to || to.includes("@apps.buildr101.com")) return "no-address"; // app end-users aren't builders

  const msg = build(to);
  if (!msg) return "skip";
  const ok = await sendEmail({ to, subject: msg.subject, text: msg.text });
  if (!ok) return "send-failed";
  await svc.from("email_log").upsert({ owner: ownerId, kind, sent_at: new Date().toISOString() });
  return "sent";
}

// ── templates ────────────────────────────────────────────────────────────────────────────────
export function welcomeEmail(credits) {
  const url = APP_URL();
  return {
    subject: `Welcome to Buildr101 — your ${credits} free credits are ready`,
    text:
`Welcome to Buildr101!

Your account is set up and ${credits} free build credits are waiting — no card needed.

Here's the fun part: just describe what you want in plain English and Buildr101 builds you a
real, working web app. A few ideas to start with:

  • "a website for my business with a contact form"
  • "a booking site with a calendar and reminders"
  • "a personal to-do app with lists and due dates"

Type one of those (or your own) and watch it build:
${url}

Every change is just another sentence — "make it darker", "add prices" — and one click puts your
app live on the web.

Any questions, just reply to this email or reach us at support@buildr101.com.

— The Buildr101 team`,
  };
}

export function nudgeEmail(credits) {
  const url = APP_URL();
  return {
    subject: `You've still got ${credits} free credits on Buildr101`,
    text:
`Hi again,

Just a nudge — you've still got ${credits} free build credits waiting on your Buildr101 account,
and they don't expire.

If you haven't built anything yet, it takes one sentence:

  • "a landing page for my side project"
  • "a simple CRM to track my leads"
  • "a menu site for a café with photos"

Pick one and see it built in a couple of minutes:
${url}

Stuck on what to make? Reply to this email — happy to help.

— The Buildr101 team`,
  };
}
