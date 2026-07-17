// Lifecycle email — welcome + credits-remaining nudge, sent via the Resend API. Fail-soft: no
// RESEND_API_KEY, no send (and never throws into the caller — a missing email must never break a
// balance read or a build). Idempotency via the email_log table: sendOnce(owner, kind, …) sends
// at most once per (owner, kind), so hooking it into an opportunistic path (ensureWelcomeGrant,
// called on every balance read) still yields exactly one email.

import { serviceClient } from "./supabase.mjs";
import { optionalEnv } from "./env.mjs";

const RESEND_URL = "https://api.resend.com/emails";
const FROM = () => optionalEnv("RESEND_FROM") || "Buildr101 <hello@buildr101.com>";
// The public builder URL for email links — NOT the internal APP_URL (a dev fallback = localhost).
const APP_URL = () => (optionalEnv("PUBLIC_URL") || "https://buildr101.com").replace(/\/$/, "");

export function emailConfigured() {
  return !!optionalEnv("RESEND_API_KEY");
}

// Low-level send. Returns true on success, false on any failure / no key. Never throws.
export async function sendEmail({ to, subject, text, html }) {
  const key = optionalEnv("RESEND_API_KEY");
  if (!key || !to) return false;
  try {
    const res = await fetch(RESEND_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ from: FROM(), to: [to], subject, text, ...(html ? { html } : {}) }),
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
  const ok = await sendEmail({ to, subject: msg.subject, text: msg.text, html: msg.html });
  if (!ok) return "send-failed";
  await svc.from("email_log").upsert({ owner: ownerId, kind, sent_at: new Date().toISOString() });
  return "sent";
}

// ── branded HTML shell ───────────────────────────────────────────────────────────────────────
// Table-based, inline-styled, ~600px — the pattern email clients actually render. Dark ink + one
// amber accent + the layered-blocks logo, matching the product. A bulletproof (table) CTA button.
function shell({ preheader, heading, intro, prompts, ctaText, ctaUrl, outro }) {
  const url = APP_URL();
  const promptRows = (prompts || []).map((p) =>
    `<tr><td style="padding:6px 0;color:#cbd5e1;font-size:15px;line-height:1.5;">
      <span style="color:#f5a623;">&bull;</span>&nbsp;&nbsp;&ldquo;${p}&rdquo;</td></tr>`).join("");
  return `<!doctype html><html><body style="margin:0;padding:0;background:#0a0c0f;">
  <span style="display:none;max-height:0;overflow:hidden;opacity:0;">${preheader || ""}</span>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0a0c0f;padding:32px 16px;">
   <tr><td align="center">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#0f1216;border:1px solid #232a35;border-radius:16px;overflow:hidden;">
      <tr><td style="padding:28px 36px 8px 36px;">
        <img src="${url}/promo/email-logo.png" width="150" alt="Buildr101" style="display:block;border:0;height:auto;" />
      </td></tr>
      <tr><td style="padding:16px 36px 0 36px;">
        <h1 style="margin:0;font-family:'Segoe UI',system-ui,Arial,sans-serif;font-size:26px;line-height:1.25;color:#f1f5f9;font-weight:700;letter-spacing:-0.01em;">${heading}</h1>
      </td></tr>
      <tr><td style="padding:14px 36px 0 36px;font-family:'Segoe UI',system-ui,Arial,sans-serif;font-size:16px;line-height:1.6;color:#94a3b8;">${intro}</td></tr>
      ${promptRows ? `<tr><td style="padding:18px 36px 4px 36px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#14181d;border:1px solid #232a35;border-radius:12px;">
          <tr><td style="padding:16px 20px;">${`<table role="presentation" cellpadding="0" cellspacing="0">${promptRows}</table>`}</td></tr>
        </table></td></tr>` : ""}
      <tr><td style="padding:26px 36px 6px 36px;">
        <table role="presentation" cellpadding="0" cellspacing="0"><tr>
          <td align="center" bgcolor="#f5a623" style="border-radius:10px;">
            <a href="${ctaUrl || url}" style="display:inline-block;padding:14px 34px;font-family:'Segoe UI',system-ui,Arial,sans-serif;font-size:16px;font-weight:700;color:#0a0c0f;text-decoration:none;border-radius:10px;">${ctaText} &rarr;</a>
          </td></tr></table>
      </td></tr>
      ${outro ? `<tr><td style="padding:18px 36px 0 36px;font-family:'Segoe UI',system-ui,Arial,sans-serif;font-size:15px;line-height:1.6;color:#94a3b8;">${outro}</td></tr>` : ""}
      <tr><td style="padding:28px 36px 30px 36px;border-top:1px solid #232a35;margin-top:12px;">
        <p style="margin:18px 0 0 0;font-family:'Segoe UI',system-ui,Arial,sans-serif;font-size:13px;line-height:1.6;color:#64748b;">
          Questions? Just reply, or email <a href="mailto:support@buildr101.com" style="color:#f7b955;text-decoration:none;">support@buildr101.com</a>.<br/>
          <a href="${url}" style="color:#64748b;text-decoration:none;">buildr101.com</a> &nbsp;&middot;&nbsp; Describe an app. Watch it build.
        </p>
      </td></tr>
    </table>
   </td></tr>
  </table></body></html>`;
}

// ── templates ────────────────────────────────────────────────────────────────────────────────
export function welcomeEmail(credits) {
  const url = APP_URL();
  const prompts = [
    "a website for my business with a contact form",
    "a booking site with a calendar and reminders",
    "a personal to-do app with lists and due dates",
  ];
  return {
    subject: `Welcome to Buildr101 — your ${credits} free credits are ready`,
    text:
`Welcome to Buildr101!

Your account is set up and ${credits} free build credits are waiting — no card needed.

Just describe what you want in plain English and Buildr101 builds you a real, working web app.
A few ideas to start with:

  • "${prompts[0]}"
  • "${prompts[1]}"
  • "${prompts[2]}"

Type one of those (or your own) and watch it build:
${url}

Every change is just another sentence — "make it darker", "add prices" — and one click puts your
app live on the web.

Questions? Reply to this email or reach us at support@buildr101.com.

— The Buildr101 team`,
    html: shell({
      preheader: `Your ${credits} free build credits are ready — no card needed.`,
      heading: `Your ${credits} free credits are ready.`,
      intro: `Welcome to Buildr101. Just describe what you want in plain English and it builds you a real, working web app &mdash; design, accounts, the lot. A few ideas to start with:`,
      prompts,
      ctaText: "Start building",
      ctaUrl: url,
      outro: `Every change is just another sentence &mdash; &ldquo;make it darker&rdquo;, &ldquo;add prices&rdquo; &mdash; and one click puts your app live on the web.`,
    }),
  };
}

export function nudgeEmail(credits) {
  const url = APP_URL();
  const prompts = [
    "a landing page for my side project",
    "a simple CRM to track my leads",
    "a menu site for a café with photos",
  ];
  return {
    subject: `You've still got ${credits} free credits on Buildr101`,
    text:
`Hi again,

Just a nudge — you've still got ${credits} free build credits waiting on your Buildr101 account,
and they don't expire.

If you haven't built anything yet, it takes one sentence:

  • "${prompts[0]}"
  • "${prompts[1]}"
  • "${prompts[2]}"

Pick one and see it built in a couple of minutes:
${url}

Stuck on what to make? Reply to this email — happy to help.

— The Buildr101 team`,
    html: shell({
      preheader: `You've still got ${credits} free build credits — they don't expire.`,
      heading: `You've still got ${credits} free credits.`,
      intro: `Just a nudge &mdash; your free build credits are waiting and they don&rsquo;t expire. If you haven&rsquo;t built anything yet, it takes one sentence:`,
      prompts,
      ctaText: "Build something",
      ctaUrl: url,
      outro: `Stuck on what to make? Reply to this email &mdash; happy to help.`,
    }),
  };
}
