# Resend — transactional email runbook

> Why: Supabase's built-in mailer sends ~3 emails/hour — fatal the day Buildr101 is promoted
> (signup confirmations silently stop). Resend replaces it for BUILDER-account email (via SMTP)
> and powers the app-auth end-user password-reset codes (via its HTTP API).
>
> Status 2026-07-15: **FULLY LIVE AND PROVEN.** All steps below are DONE (Stuart, same day):
> domain verified, Supabase custom SMTP live (Stuart received a builder-account recovery email),
> `RESEND_API_KEY` edge secret set, and the app-auth path proven with a REAL delivery —
> signup → reset → Resend email → Stuart relayed the 6-digit code → reset-confirm 200 with
> session → new password signs in. Probe account cleaned up after.
> Gotcha hit: the secret was first saved under the NAME `Resend` (the name field is the env var
> name — it must be exactly `RESEND_API_KEY`); diagnosed with a temporary env-probe function
> (names-only), now a dead 410 stub (the MCP can't delete functions).
> `shell/harness/prove-reset-guards.mjs` = 15 GREEN checks; NOTE: with the key live, each run's
> reset request now sends ONE real email to a nonexistent probe gmail — harmless one-off, but
> don't loop the harness (bounces nibble sender reputation).

## What's wired (code side, done)

- **app-auth Edge Function v2** (deployed live via the Supabase MCP): `reset` emails a 6-digit
  code through `https://api.resend.com/emails`; `reset-confirm` verifies it, sets the password,
  and signs the user in. Codes: hashed at rest (`app_password_resets`, deny-all RLS), 15-min
  expiry, dead after 5 wrong guesses, single-use, new request invalidates the old code,
  identical answers for known/unknown emails (no account enumeration).
- **Scaffold SDK**: `auth.resetPassword({ email })` + `auth.confirmReset({ email, code,
  newPassword })` in both lanes; the builder prompt now tells the agent to include a
  "Forgot password?" flow on sign-in screens. (New apps only — existing project trees carry the
  older SDK, which keeps working; reset just isn't in their surface.)
- **Env the function reads**: `RESEND_API_KEY` (required for reset) and `RESEND_FROM`
  (optional, default `Buildr101 <noreply@buildr101.com>`).

## Stuart's steps (in order)

1. **Resend account** — https://resend.com, sign up (stuart3190@gmail.com).
2. **Verify the domain** — Resend dashboard → Domains → Add `buildr101.com`. It lists DNS
   records (DKIM TXT/CNAMEs + optional Return-Path). Add them in **Cloudflare** (DNS-only/grey,
   like everything else). Wait for "Verified". NOTE: an SPF TXT for the apex already exists from
   Cloudflare Email Routing (the support@ forward) — if Resend asks for SPF on a *subdomain*
   (send.buildr101.com), that's separate and fine; if it wants the apex SPF edited, MERGE the
   mechanisms into ONE TXT record (two SPF records on one name = both invalid).
3. **API key** — Resend → API Keys → create (full access, or sending-only). Drop it in
   `~/Desktop/key.txt` per env-custody rules. Never in the repo.
4. **Edge Function secret** (the MCP has no secrets op — dashboard or CLI):
   Supabase dashboard → project `qgemqjcyhuejrsvjxkbh` → Edge Functions → Secrets →
   add `RESEND_API_KEY` = the key. New invocations pick it up — no redeploy needed.
5. **Builder-account SMTP** (signup confirmations / password recovery for buildr101.com
   accounts): Supabase dashboard → Authentication → Emails/SMTP Settings → enable custom SMTP:
   - Host `smtp.resend.com` · Port `465` · Username `resend` · Password = the same API key
   - Sender `noreply@buildr101.com` · Sender name `Buildr101`
   Then raise the email rate limit (Authentication → Rate Limits) from the ~3/hr default to
   something real (e.g. 100/hr — Resend free tier is 100/day / 3k/mo, upgrade when traffic says so).

## Verify (after the steps)

- `node shell/harness/prove-reset-guards.mjs` — the reset line should flip from
  `503 until RESEND_API_KEY is set` to `200 (RESEND KEY LIVE — code emailed)`.
- Manual: sign up a fresh buildr101.com account → the confirmation email should arrive from
  noreply@buildr101.com (Resend dashboard → Logs shows every send).
- Forgot-password on buildr101.com → link must point at https://buildr101.com (Site URL was set
  2026-07-08).

## Loose ends this unlocks / leaves

- Unlocks: app-auth password reset (was stage 4 of PLAN-per-app-auth) — done, above.
- Later: build-done notifications and any product email ride the same Resend account.
- Resend free tier = 100 emails/day; the dashboard shows usage — upgrade to Pro ($20/mo, 50k)
  when signups approach the ceiling.
