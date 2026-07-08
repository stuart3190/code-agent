# Buildr101 — full system context

> Paste-into-a-fresh-session summary of the entire app builder: what it is, every working part,
> where things run, the rules that keep it clean, and what's still open.
> Last updated **2026-07-07** (launch-audit session: Stripe live catalog created via MCP +
> STRIPE-LIVE.md runbook, legal pages + account deletion live, public /pricing, nightly Supabase
> backups — remaining audit items are Stuart-only dashboard steps). Prior 2026-07-06: design pass,
> 7 Lovable-parity features, production deploy, paywall ladder, welcome credits.
> Repo: `stuart3190/app-builder` (private, linear master, EPYC box
> `C:\Users\Administrator\app-builder`).

## What it is

**Buildr101** (https://buildr101.com — LIVE in production) is a Base44/Lovable-class AI app
builder: describe an app in plain English → a multi-turn agent builds a real React app → live
preview → iterate in plain English → publish to a public URL (or the customer's own domain).
Owner: Stuart (stuart3190@gmail.com). Business angle: freemium SaaS + done-for-you agency work
(build/host apps for small businesses). Stripe is TEST MODE — no real money moves yet.

## Production topology (deployed 2026-07-06; runbook = `baseline/DEPLOY.md`)

- **VPS** (OVH, `ubuntu@51.195.136.189`, key `~/.ssh/id_ed25519`) runs EVERYTHING:
  - `buildr-shell` (systemd): the shell server, Node, binds ONLY `10.83.7.1:8787` (docker
    proxy-net gateway — Caddy-only ingress, public port unreachable). Repo copy: `~/app-builder`.
  - `buildr-provisiond` (systemd): preview/publish provisioning, `127.0.0.1:8790`. Runs from
    `~/provisiond` (NOT the repo copy — sync changed files there + restart).
  - **Caddy** (docker `buildr-caddy`, binds `10.83.7.2`, certs via Cloudflare DNS-01 + on-demand):
    `buildr101.com` → shell (SSE-safe) · `www` → apex · `*.preview.buildr101.com` → preview
    containers · `*.app.buildr101.com` → static published sites from `/publish/<label>` ·
    catch-all `https://` → custom domains from `/publish/_domains/<host>` (on-demand TLS gated by
    the shell's `/api/domain-check`).
- **Local EPYC box = dev only** (shell on :8787, vite dev :5173, optional SSH tunnel + stripe
  listen). Local and prod share the same Supabase project + Stripe test account.
- **Deploy** = tar/scp/restart (exact commands in DEPLOY.md — tar MUST run from the repo root).
  Web dist rides the tarball.
- **Backups**: `buildr-backup.timer` (systemd, daily 04:17 UTC) runs `scripts/backup-supabase.mjs`
  → gzipped-JSON export of all platform tables + auth users into `~/backups/`, 14-day prune
  (DEPLOY.md §Backups). The Supabase free tier itself keeps NONE.
- **Reboot resilience**: the OVH VPS gets occasional host-level hard resets (2026-07-04 and
  2026-07-08 observed). provisiond now runs `ensureCaddy` at boot (server.mjs boot block,
  2026-07-08) because the Caddy container has no docker restart policy and its stale preview-net
  refs block a plain `docker start` — before this fix a reboot silently killed :443. Gotcha seen
  2026-07-08: a reboot can leave an orphaned provisiond on 127.0.0.1:8790 that EADDRINUSE-loops
  the systemd unit — find the pid via `ss -ltnp`, kill it, restart buildr-provisiond.
- Stripe PRODUCTION webhook `we_1TqIZvC6PoSrpLpG4HMGQBvD` → `buildr101.com/api/stripe/webhook`
  (proven live). DNS on Cloudflare, all records DNS-only/grey.

## The engine (src/) — the sacred core

- **`runTurn` seam**: `provider.runTurn({systemPrompt,messages,tools}) -> {text,toolCalls,usage}`.
  Engine (`src/engine/runAgent.mjs`) is provider-agnostic; NEVER touch the seam. Tool impls may be
  async (runAgent awaits them). Providers: **Codex** (ChatGPT-sub OAuth lane, free, gpt-5.5;
  creds `~/.codex/auth.json` — copied to the VPS) and **Anthropic** (BYOK). Router above the seam.
- **Prompts** (`src/prompts/builder.mjs`): BUILD / PLAN / EDIT (+apply_patch variant). Contains the
  aesthetic **Design block** (semantic tokens, one accent, type scale, compose from the component
  library via a ~500-token cheat-sheet, search_images rules, per-app-backend note).
- **Edit tool**: apply_patch (Codex V4A) with write_file fallback after 2 failures.
- **Scaffold** (`src/scaffolds/reactVite.mjs` + real files under `reactVite/`): Vite+React18+
  Tailwind, **shadcn-style tokens** (`:root`/`.dark` HSL) + **Manrope/Space Grotesk** (@fontsource,
  self-hosted), **14 shadcn/ui components** (.jsx under `components/ui/`) + lucide-react + `cn()`,
  **backend SDK** (`lib/backend/`: auth/db/storage over one generic `entities` table; appId
  namespace; per-app auth via authUrl; fail-soft when unconfigured), **devReporter**
  (`lib/devReporter.js`: dev-only bridge → runtime errors out, select-mode/visual-edits in/out,
  refreshed into every materialized preview by `withRuntimeEnv`).
- **Runtime env injection** (`shell/server/lib/runtimeEnv.mjs`): `.env`
  (VITE_SUPABASE_URL/ANON_KEY/APP_ID/AUTH_URL) added ONLY at materialization (build/preview/
  publish) — saved trees and export ZIPs stay clean. **Backend-as-parameter is a hard rule.**

## The shell (shell/)

- **Server** (`shell/server`, pure Node, no framework — reuses root node_modules): routes
  `generate` (SSE; plan/build/iterate; knowledge injection; search_images tool when
  PEXELS_API_KEY set; welcome grant), `preview`, `publish`/`unpublish` (site-name claims +
  paywall), `domains` (+ unauthenticated `domain-check` for Caddy), `projects/delete` (FULL infra
  cleanup via the shared `deleteProjectCascade`: domains, site + released name, preview container,
  per-app users/data, row — service role with explicit owner check), `account/delete` (GDPR-grade:
  cancels any Stripe sub IMMEDIATELY hard-fail, cascades every project, wipes ledger/customers/
  BYOK, deletes the auth user; typed-DELETE UI in Settings), `export` (ZIP, secret-gated), `billing`
  (checkout/balance/subscription/switch/cancel + welcome grant on balance reads),
  `stripeWebhook`, `settings` (BYOK). Env is read ONCE at start — any .env edit or code change
  ⇒ restart (`sudo systemctl restart buildr-shell`).
- **Web** (`shell/web`, Vite+React+Tailwind): dark ink + single amber accent, Manrope/Space
  Grotesk, layered-blocks logo. **Public pages** (routed pre-auth in main.jsx, no account needed):
  `/pricing` (live numbers from /api/config incl. welcomeCredits) + `/terms` `/privacy` `/refunds`
  (`src/legal/`); links in AuthGate + Settings footers; support contact support@buildr101.com.
  AuthGate = storefront split (proof screenshot + bullets) with
  signup-confirmation handling + forgot-password (+ ResetPassword screen on PASSWORD_RECOVERY).
  Dashboard: starter-prompt chips, live-site links, always-visible delete ✕ (confirm spells out
  consequences). **Builder**: prompt box (⌘Enter), plan-mode toggle, inline project RENAME
  (pencil), knowledge popover, select-element (visual edits), build TIMELINE (parsed from SSE log
  lines — `parseTimeline` must track log formats), error banner + **Fix it**, per-turn tree
  snapshots + **revert** (last 20), preview iframe, **Site ▾ menu** (live URL/Republish/Custom
  domain/Unpublish), publish dialog (site name), Download. BillingPanel: balance+tier, plans with
  Current-plan ✓/Upgrade/Downgrade/Cancel/Resume, top-up (no provider-modes section — internals
  stay hidden from end users). Collapses <1440px. **Settings**: Account (email + change password
  in place) + BYOK key.

## Billing (src/billing/) — costModel is the single source of truth

- `costModel.mjs`: 1 credit = 10k blended tokens ≈ £0.0398 true cost; model-weighted debits;
  tiers Starter £12/120cr · Pro £40/500cr · Studio £120/2000cr; top-up £0.12/cr; breakevens,
  rollover caps, per-tier hard ceilings. NEVER re-derive prices elsewhere.
- `ledger.mjs`: append-only `credit_ledger` (Σ delta = balance), grants/debits idempotent on
  (owner,ref,kind,bucket), entitlement in `customers` (tier). `stripe.mjs`: checkouts, PURE
  webhook handler (invoice.paid→bundle grant+entitlement · checkout.completed→topup ·
  subscription.deleted→clear tier), and lifecycle: `switchTier` (**farm-proof**: no invoice at
  switch; upgrade=create_prorations+entitlement NOW; downgrade=none+richer tier honored till
  renewal), `setCancelAtPeriodEnd`, `subscriptionStatus`.
- **Freemium ladder (enforced server-side via getEntitlement)**: free = build+preview · any paid
  tier = publish · Pro/Studio = custom domains. Publish gate fires BEFORE the slug claim.
  **Welcome credits**: every new account gets `costModel.WELCOME_CREDITS` (30) once — idempotent
  via ledger ref `welcome:<owner>`, topup bucket (never expires), granted on generate/server
  balance reads; tierless debits work (ceiling = Infinity without an entitlement).
  BYOK (encrypted key in `byok_keys`, AES-256-GCM via BYOK_ENC_KEY) = user-paid inference,
  no credit debit. **Scaling plan (Stuart)**: subscription revenue banks platform API-key credit;
  the managed lane flips from the personal ChatGPT-sub Codex lane to real API keys at scale
  (router/provider config change only). BYO-ChatGPT-OAuth for users was REJECTED (ToS/custody);
  BYO-OpenAI-API-key is approved as a future second BYOK provider.

## Supabase (project `qgemqjcyhuejrsvjxkbh` — shared by platform AND generated apps)

Tables (migrations/ has the SQL; the **MCP can apply DDL directly**): `entities` (generic app
data; owner-RLS + `app_id` namespace) · `projects` (tree/history/knowledge/published_url;
owner-RLS) · `credit_ledger` + `customers` (billing) · `byok_keys` (service-role only) ·
`app_users` (per-app end-user pools; service-role only) · `published_sites` (slug claims) ·
`custom_domains`. **Edge Function `app-auth`**: per-app signup/signin — real Supabase auth users
under synthetic emails (`u.<sha>@apps.buildr101.com`), real sessions/refresh tokens, same email
usable across apps; reset = 501 stub (needs an email provider). Buildr101 BUILDER accounts use
normal Supabase auth (shared pool).

## Testing (run on engine/billing changes; ship gate = green)

Offline: `npm run test:billing` (35) · `test:ledger` (19) · `harness/_applier|_context|_runagent|
_router-tests.mjs` · `test:export`. Live (Codex spend): `node harness/run.mjs` (3 archetypes) ·
`node shell/harness/prove-shell.mjs` (41 checks, full product loop — runs on the VPS too) ·
prove:billing / proveBackend / proveTenancy / prove-byok. Headless verify pattern: probe user +
service-role credit seed + fetch against :8787 or buildr101.com; screenshots via headless Edge
(`--screenshot`, blank-white 5851b = dev-server needs restart; cross-origin iframes don't tick
timers under virtual-time).

## Rules that keep it clean

1. runTurn/provider seam untouched; tools/prompts are caller-side.
2. Backend-as-parameter: never hardcode the Supabase project into trees/exports.
3. costModel = pricing truth; ledger is append-only; grants only ride real invoices.
4. Secret gate every commit (no keys staged, ever). Env custody: local `shell/.env`, VPS
   `~/app-builder/shell/.env` (+ `~/provisiond/.env`), raw keys in `~/Desktop/key.txt` — never
   in the repo.
5. One feature per commit, verified live before the gate; commit on Stuart's say-so.
6. Restart after ANY server/.env change (Node caches modules). Scaffold dep changes ⇒ delete
   `harness/.deps` + rebuild the VPS preview base image (`provisiond/base`, keep its package.json
   in sync). Never `pkill -f node` on the VPS — find the pid via `ss -ltnp`.

## Open items — LAUNCH AUDIT (Stripe is TEST mode; Stuart is deliberately pre-traffic)

**🔴 Before real users / launch day:**
- **Stripe test→live: ✅ DONE 2026-07-08 — LIVE AND PROVEN** (runbook `baseline/STRIPE-LIVE.md`
  has the full record). Pin removed from services.mjs, live sk_/whsec/price IDs in the VPS .env
  (test backup `shell/.env.pre-live-flip`), `assertPricesMatchModel` PASS on live, real £0.60
  top-up → webhook → 5cr grant → refunded + ledger-reversed. Dashboard rename/descriptor/public
  profile all Buildr101; support@buildr101.com set as Stripe support email. NOTE: stale test-mode
  `stripe_customer_id`s were nulled in `customers` (live checkout can't reuse a test cus_).
  Loose ends: subscription smoke (invoice.paid unproven on live), product description still the
  old SEO text, payout schedule manual.
- **Legal**: DONE 2026-07-07 (9e293be, deployed + verified live on buildr101.com). Public
  `/terms` `/privacy`
  `/refunds` (shell/web/src/legal/LegalPage.jsx, routed in main.jsx pre-auth; links in AuthGate
  footer + Settings) + **account deletion** (POST /api/account/delete: cancels Stripe sub
  IMMEDIATELY (hard-fail), loops deleteProjectCascade — extracted from projects.mjs — then wipes
  ledger/customers/byok + auth user; typed-DELETE danger zone in Settings).
  `shell/harness/prove-account-delete.mjs` 26/26 GREEN live. Support contact =
  support@buildr101.com — Cloudflare Email Routing forward set up 2026-07-08 (MX
  route1/2/3.mx.cloudflare.net + SPF verified live in DNS; spot-check = send it a test email).
- **Transactional email**: Resend/SES (Supabase mailer ≈3/hr — fatal at volume); unlocks app-auth
  password reset (stage 4). ~~Supabase Site URL dashboard step~~ DONE 2026-07-08 (Stuart set it to
  `https://buildr101.com` in the dashboard; spot-check = trigger forgot-password and confirm the
  emailed link points at buildr101.com, not localhost).

**🟡 Soon after:** ~~Supabase backups~~ DONE 2026-07-07 (`buildr-backup.timer` nightly JSON
export on the VPS — see DEPLOY.md §Backups) · ~~public pricing page~~ DONE 2026-07-07 (public
`/pricing`, live numbers from /api/config, linked from AuthGate footer) · uptime monitoring
(e.g. UptimeRobot — needs an account) · Codex quota ceiling on the managed lane (covered by the
scaling plan) · light abuse guards (app-auth signup rate limits, per-account project caps).

**Feature queue:** BYO-OpenAI-API-key provider · paid lane (dedicated Supabase project per client,
`baseline/PLAN-per-app-auth.md`) · visual edits v2 (source tagging) · plan-mode clarifying
questions · duplicate project · project search · mobile Builder layout · build-done notifications ·
published-site analytics · engine cost knobs (preview-h/credit instrumentation, search_replace A/B,
routing under --cache).

## Canonical docs in-repo

`baseline/DEPLOY.md` (production runbook) · `baseline/DECISION-hosting.md` ·
`baseline/PLAN-per-app-auth.md` (paid lane) · `baseline/PHASE-*.md` (history/evidence) ·
`baseline/PROVISIOND-PLAN.md` · migrations/*.sql (all applied live).
