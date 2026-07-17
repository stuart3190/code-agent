# Buildr101 — full system context

> Paste-into-a-fresh-session summary of the entire app builder: what it is, every working part,
> where things run, the rules that keep it clean, and what's still open.
> Last updated **2026-07-16** (LAUNCH DAY: checklist closed — Resend fully live, abuse guards,
> platform admins, landing page, photography fix, billing proven both directions, Codex OAuth
> keep-alive — and PROMOTION STARTED: Meta ad live at £5/day + autonomous multi-platform social
> poster with generated card art; see §Marketing below). Prior 2026-07-08: Stripe LIVE + proven.
> 2026-07-07: launch audit. 2026-07-06: design pass, 7 Lovable-parity features, prod deploy.
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
  **Photography regression fixed 2026-07-16**: production builds had stopped using real photos
  (Pexels quota showed search_images ~never called — the old IMAGES_PROMPT_BLOCK was a soft
  "consider it" note the design pass drowned out). Fix: IMAGES_PROMPT_BLOCK (shell/server/lib/
  images.mjs) now makes photography REQUIRED-by-default for consumer-facing apps (first tool
  call = search_images; photo-less business hero = "a DEFECT"), + a Photography line inside the
  Design block itself, + a pushier tool description. Guard: `node harness/_images-probe.mjs`
  (one live Codex build; asserts ≥1 search call, ≥3 pexels URLs, 0 invented hosts, builds) —
  PASS on first run; the resulting Iron & Oak barber build (full-bleed photo hero) became the
  landing showcase (assets/showcase-barber2.jpg, replacing the photo-less Fade District png).
- **Edit tool**: apply_patch (Codex V4A) with write_file fallback after 2 failures.
- **Scaffold** (`src/scaffolds/reactVite.mjs` + real files under `reactVite/`): Vite+React18+
  Tailwind, **shadcn-style tokens** (`:root`/`.dark` HSL) + **Manrope/Space Grotesk** (@fontsource,
  self-hosted), **14 shadcn/ui components** (.jsx under `components/ui/`) + lucide-react + `cn()`,
  **backend SDK** (`lib/backend/`: auth/db/storage over one generic `entities` table; appId
  namespace; per-app auth via authUrl; fail-soft when unconfigured), **devReporter**
  (`lib/devReporter.js`: dev-only bridge → runtime errors out, select-mode/visual-edits in/out,
  refreshed into every materialized preview by `withRuntimeEnv`).
- **App identity — generated name + icon** (2026-07-17, `shell/server/lib/appIdentity.mjs` +
  `iconGlyphs.mjs`): on first publish, ONE Codex call (free, cached in `projects.app_name/app_icon`)
  turns the app's first build prompt into a real display **name** ("Barber Booking") and picks an
  **icon glyph** from a curated ~36 lucide-SVG allow-list (scissors, coffee, dumbbell…). renderIcons
  draws the glyph white on the app's brand-colour gradient — a designed app icon, not a letter.
  Used by BOTH the PWA manifest/install icon AND the Android launcher (android.mjs reads the same
  cached identity). Fail-soft (any error → fallback name + `sparkles`); publish `name` (explicit
  site name) still wins for the manifest. SVG paths (not emoji) so alpine-chrome renders reliably
  with no font dependency. Proven 8/8 `shell/harness/prove-appidentity.mjs`. Existing apps upgrade
  on next republish (migration `migrations/app_identity.sql`).
- **PWA — every published app is installable** (2026-07-16, `shell/server/lib/pwa.mjs`):
  `withPwaAssets(tree, {appName})` adds `public/manifest.webmanifest` + `public/sw.js` (Vite copies
  public/* into dist) + injects the manifest link / theme-color / apple-touch-icon / title / SW
  registration into index.html; `renderIcons({appName,tree,distDir})` writes per-app letter-tile
  PNGs (192/512/apple-touch) into the built dist via headless Chrome (zenika/alpine-chrome docker
  on the VPS, Edge headless on win32) — theme/bg/letter colours parsed from the tree's index.css
  `:root` tokens (--primary/--background HSL→hex). **PUBLISH-ONLY** (called in publish.mjs's
  materialization only) so previews stay service-worker-free; SW is network-first on navigations
  (a republish is never stale). GOTCHAS baked in: trees are UTF-8 only → binary icons rendered
  into dist AFTER the build, NOT injected into the tree; a manifest/sw only reach dist if under
  `public/`. Proven live 18/18 `shell/harness/prove-pwa.mjs` + offline `harness/_pwa-drycheck.mjs`.
  **Rename bug fixed same commit**: claimSlug's upsert-on-slug-then-delete inserted a 2nd row for
  the same project → 500 on every published-site RENAME (unique project_id index); now updates the
  existing row's slug in place. Existing sites gain PWA on next republish (no migration).
- **Android export — "Download Android app"** (2026-07-17): Site ▾ menu action on a PUBLISHED app
  wraps its PWA into a signed **APK + AAB (TWA via Bubblewrap)** and downloads a zip (apk, aab,
  keystore, password, README with Play steps — customer uploads under their OWN $25 Play account).
  Runs entirely in the **`buildr-android` Docker image** (JDK17 + Android SDK 34 + @bubblewrap/cli,
  gradle primed against `/android-prime.webmanifest`; ~2.2GB, built on the VPS from `android/` —
  `docker build -t buildr-android:latest android/`). Route `POST /api/android`
  (`shell/server/routes/android.mjs`) → `shell/server/lib/android.mjs` `buildAndroid`: per-project
  signing keystore encrypted at rest (`android_keystores`, deny-all RLS, mirrors byokStore but
  base64s the binary; migration `migrations/android_keystores.sql`), docker run, zip via
  `createStoredZip`. **assetlinks coupling**: the publish core (`materializeAndPublish`, factored
  out of publish.mjs) injects `public/.well-known/assetlinks.json` into EVERY publish once a
  project has a key — so a plain republish never breaks the installed app's full-screen
  verification (Caddy serves dotfiles; provisiond replaces the whole dir so it MUST ride the tree).
  Proven 13/13 live `shell/harness/prove-android.mjs` (real ~90s build → signed apk+aab, assetlinks
  fingerprint match, key reuse, republish survival). GOTCHAS baked in: Bubblewrap 1.24 SDK check
  wants `${sdk}/tools` (symlink to cmdline-tools/latest); non-interactive path =
  `bubblewrap update --skipVersionUpgrade && build` (NOT `build` alone → interactive version
  prompt); container runs as root → `chmod a+rwX /work` on EXIT so the shell can clean up;
  execFileSync needs `maxBuffer` bumped (gradle is chatty). Shell serveStatic content-type map
  also gained png/jpg/webmanifest/etc. (was octet-stream — bit the OG/promo images too). iOS still NO.
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
  **Platform admins** (2026-07-16, `lib/admin.mjs`): `ADMIN_EMAILS` in shell/.env (currently
  stuart3190@gmail.com + support@buildr101.com) pass the publish + custom-domain tier gates with
  no subscription — matched against the VERIFIED token email, not a DB flag (webhooks own
  customers.tier and would fight one). Credits still meter normally. Proven live: no-tier
  non-admin → 402 upgrade_required; no-tier admin email → past the gate. Stuart refunded his
  £12 Starter smoke sub same day (refund + immediate cancel via live key on the VPS, webhook
  cleared tier, −120 ledger reversal row) — admin gate is how his account publishes now.
- **Web** (`shell/web`, Vite+React+Tailwind): dark ink + single amber accent, Manrope/Space
  Grotesk, layered-blocks logo. **Public pages** (routed pre-auth in main.jsx, no account needed):
  `/pricing` (live numbers from /api/config incl. welcomeCredits) + `/terms` `/privacy` `/refunds`
  (`src/legal/`); links in AuthGate + Settings footers; support contact support@buildr101.com.
  **Landing page** (2026-07-15, `src/landing/Landing.jsx` — the logged-out experience, replaced
  the bare AuthGate split): sticky nav, hero (headline + trust chips + embedded AuthCard), the
  signature **build console** (types the barber-shop prompt, streams build-log lines, browser
  frame resolves into the real fadedistrict screenshot; reduced-motion shows the finished state),
  how-it-works, feature grid, live pricing strip from /api/config, CTA band, footer.
  `auth/AuthGate.jsx` now = `AuthCard` (mode lifted; all original signup/signin/forgot logic
  verbatim) + `Logo` + a standalone default export. Screenshot gotcha discovered: headless Edge
  on Windows CLAMPS window width to ~492px (innerWidth probe proves it) — "broken mobile"
  screenshots at 390px were an artifact all along; verify mobile at 492 (still < sm) or via an
  iframe harness (which stalls on cross-origin session checks — prefer 492). Window height also
  caps ~2400px. Signup-confirmation handling + forgot-password (+ ResetPassword screen on
  PASSWORD_RECOVERY) all unchanged.
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
usable across apps; v2 (2026-07-15) adds the full password-reset code flow (Resend) + signup
rate limits — tables `app_password_resets` + `app_auth_events` (both deny-all RLS). Buildr101
BUILDER accounts use normal Supabase auth (shared pool).

## Testing (run on engine/billing changes; ship gate = green)

Offline: `npm run test:billing` (35) · `test:ledger` (19) · `harness/_applier|_context|_runagent|
_router-tests.mjs` · `test:export`. Live (Codex spend): `node harness/run.mjs` (3 archetypes) ·
`node shell/harness/prove-shell.mjs` (41 checks, full product loop — runs on the VPS too) ·
prove:billing / proveBackend / proveTenancy / prove-byok / prove-reset-guards (15 checks:
reset code flow + abuse guards against the DEPLOYED function + live DB, no email needed). Headless verify pattern: probe user +
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
  Loose ends: ~~subscription smoke~~ PROVEN LIVE 2026-07-16 (Stuart subscribed Starter for real:
  invoice.paid → +120 bundle grant, tier + cycle set, actively dogfooding on it — kept, not
  refunded); ~~product descriptions~~ DONE 2026-07-16 (all 4 set via the live key — they were
EMPTY; the "old SEO text" was a stray still-active FinTech product from a prior venture, now
archived); payout schedule manual.
- **Legal**: DONE 2026-07-07 (9e293be, deployed + verified live on buildr101.com). Public
  `/terms` `/privacy`
  `/refunds` (shell/web/src/legal/LegalPage.jsx, routed in main.jsx pre-auth; links in AuthGate
  footer + Settings) + **account deletion** (POST /api/account/delete: cancels Stripe sub
  IMMEDIATELY (hard-fail), loops deleteProjectCascade — extracted from projects.mjs — then wipes
  ledger/customers/byok + auth user; typed-DELETE danger zone in Settings).
  `shell/harness/prove-account-delete.mjs` 26/26 GREEN live. Support contact =
  support@buildr101.com — Cloudflare Email Routing forward set up 2026-07-08 (MX
  route1/2/3.mx.cloudflare.net + SPF verified live in DNS; spot-check = send it a test email).
- **Transactional email**: ✅ FULLY LIVE 2026-07-15 (runbook `baseline/RESEND.md`) — app-auth v2
  deployed with the full reset flow: `reset` emails a 6-digit code via the Resend API,
  `reset-confirm` verifies + sets password + signs in; codes hashed in `app_password_resets`
  (15-min TTL, 5-attempt cap, single-use, no account enumeration); SDK `auth.resetPassword` /
  `auth.confirmReset` + builder-prompt "Forgot password?" guidance; proven 15/15 by
  `shell/harness/prove-reset-guards.mjs` AND by a real delivery (Stuart relayed the emailed
  code → confirm 200). Stuart's dashboard steps all DONE same day: Resend domain verified,
  `RESEND_API_KEY` edge secret (gotcha: secret NAME must be exactly that — it was first saved
  as `Resend`), Supabase custom SMTP via smtp.resend.com (kills the ≈3/hr mailer risk).
  Resend free tier = 100 emails/day — upgrade when signups approach it.
  ~~Supabase Site URL dashboard step~~ DONE 2026-07-08.

**🟡 Soon after:** ~~Supabase backups~~ DONE 2026-07-07 (`buildr-backup.timer` nightly JSON
export on the VPS — see DEPLOY.md §Backups) · ~~public pricing page~~ DONE 2026-07-07 (public
`/pricing`, live numbers from /api/config, linked from AuthGate footer) · ~~uptime monitoring~~
DONE 2026-07-16 (UptimeRobot → /api/health, probes verified in the Caddy logs) ·
Codex quota ceiling on the managed lane (covered by the
scaling plan) · ~~light abuse guards~~ DONE 2026-07-15 (app-auth signup limits: 10/h per IP +
30/h per app, DB-backed via `app_auth_events`; reset limits 5/h per target + 20/h per IP;
project cap = BEFORE INSERT trigger `enforce_project_cap` on `projects` — 10 free / 100 paid —
because creation is a client-side owner-RLS insert, the DB is the only unbypassable gate;
migration `migrations/password_resets_abuse_guards.sql` applied live via MCP).

**Feature queue:** **PWA ✅ DONE 2026-07-16** (always-on, publish-only; see shell/pwa note above).
**ANDROID — NEXT SESSION (plan-mode first), scope = "Download Android app" button by the Publish
button; Buildr101 emits the signed artifact, the customer does the Play upload with their own $25
account (Google template-app policy forbids bulk-publishing from one account).** Mechanism = TWA
(Trusted Web Activity) wrapping the already-published PWA, built with @bubblewrap/cli on the VPS
Linux toolchain (JDK 17 + Android cmdline-tools/build-tools — a real install, no Mac). THE
COUPLING to walk in knowing: a TWA only runs full-screen (no browser URL bar) if the app's origin
serves `/.well-known/assetlinks.json` containing the SHA-256 fingerprint of the APK's signing key
— so the flow is generate keystore → build+sign → write assetlinks.json with THAT fingerprint into
the published app's origin (public/.well-known/, same injection seam as the PWA) → the app must be
(re)published so x.app.buildr101.com serves it. Deliver TWO artifacts: signed .apk (sideload/test
now) + .aab (Play upload). Key custody decision needed (Buildr101-generated keystore handed to the
user in the download vs Play App Signing upload-key). iOS DECIDED NO (Stuart's call — done
iOS before, "a nightmare"; per-publisher $99 accounts + guideline 4.2.6 kills central publishing;
revisit only on loud paying demand) · AI support chat (needs abuse-guarding + real user questions first) ·
booking→owner-email connector (unlocks the night-notifications ad creative) · Umami self-hosted
analytics · connector gallery (browse/enable integrations per project — start with
secretless embeds, then form→owner-email via Resend, Stripe Payment Links; Stuart parked it
2026-07-16, low priority) · BYO-OpenAI-API-key provider · paid lane (dedicated Supabase project per client,
`baseline/PLAN-per-app-auth.md`) · visual edits v2 (source tagging) · plan-mode clarifying
questions · duplicate project · project search · mobile Builder layout · build-done notifications ·
published-site analytics · engine cost knobs (preview-h/credit instrumentation, search_replace A/B,
routing under --cache).

## Lifecycle email (LIVE 2026-07-17)

- **Welcome email** (`shell/server/lib/email.mjs` `sendOnce` + `welcomeEmail`): sent once per new
  builder account, hooked into `ensureWelcomeGrant` (fires when the 30 free credits land) — reminds
  them of the credits + gives starter-prompt nudges + the builder link. Idempotent via `email_log`
  (owner,kind PK, deny-all RLS); fail-soft (no RESEND_API_KEY → no send, never blocks a build).
- **Credits-remaining nudge** (`scripts/email-nudge.mjs` + `buildr-email-nudge.timer`, daily
  15:20 UTC): 24-72h after signup, for accounts that got the welcome, haven't been nudged, and
  still have credits (balance>0) — one nudge with their remaining credit count. `--dry-run` lists
  targets without sending.
- Both send via the **Resend API** (RESEND_API_KEY + RESEND_FROM now in the shell/.env, separate
  from the Supabase edge secret; from = hello@buildr101.com on the verified domain). App end-users
  (`@apps.buildr101.com`) are excluded — builder accounts only. Proven live: real welcome delivery
  to stuart3190@gmail.com + idempotency ('already' path) + nudge dry-run (0 eligible yet).

## Marketing (LIVE since 2026-07-16 — promotion running)

- **Meta ad**: campaign `52681395849417` "Buildr101 — Launch — Signups" (OUTCOME_LEADS, CBO
  £5/day) → ad set `52681395863217` (UK broad + Advantage+, OFFSITE_CONVERSIONS on pixel /
  CompleteRegistration) → ad `52681402780217` "Showcase v2 — app idea angle" ACTIVE ("ever had
  an app idea", NOT "your business needs a website" — Stuart's call: app builder for normal
  people, not website-maker). v1 website-angle ad `52681396007017` PAUSED in reserve for A/B.
  Runs from the AGED Zataus ad account `176865839039062` (payment history = ban-risk shield;
  the visible identity is the Buildr101 PAGE `1229354346925125`, in the Zataus BM
  `3452733855009273`). Creative hosted at /promo/ad-showcase-1.png. Judge nothing before
  48-72h; edits reset learning.
- **Pixel** `1369829255105802` ("Buildr101" dataset, created INSIDE the Zataus BM — pixel and
  ad account must share a business; a personal-scope pixel can't connect). Hostname-guarded in
  shell/web/index.html; CompleteRegistration fires in AuthCard on signup. GOTCHA: /me/accounts
  is EMPTY for business-owned pages — fetch the page token via GET /{page-id}?fields=access_token
  with a long-lived user token instead.
- **Social poster** (`marketing/social-poster.mjs` + `buildr-social.timer`, 3 slots/day +
  jitter + midday coin-flip = 2-3 posts/day): one Codex-generated post per run with per-platform
  variants; adapters self-enable on env creds — Facebook LIVE (FB_PAGE_ID/FB_PAGE_TOKEN via Meta
  app "Buildr101 Tools" 1066640842409652), Instagram piggybacks via the page's "always share to
  Instagram" (image posts only; direct API adapter ready if native captions wanted — needs a
  token regen with instagram_basic+instagram_content_publish), X and LinkedIn adapters written,
  awaiting creds (X refresh token rotates — persisted in state like the Codex lesson). Most
  posts get FRESH card art (model designs eyebrow/headline/sub; zenika/alpine-chrome docker on
  the VPS renders 1080² into dist/promo/gen/ — public URL, survives deploys). PROOF posts keep
  the real Iron & Oak screenshot (honesty bar: "untouched" must stay true). History + X refresh
  token in ~/.buildr-social-state.json on the VPS. Claims discipline hard-coded in the prompt.
- **Assets**: FB page profile/cover + 5 ad creatives on the Desktop (buildr101-fb-*,
  buildr101-ad-*); promo images served under /promo/; OG/twitter-card meta live on the site.
  Copy kit: `baseline/PROMO-KIT.md`. Night-notifications creative is HELD until a
  booking→owner-email feature exists (its imagery implies notifications we don't send yet).
- **Watch under traffic**: ChatGPT-sub Codex quota (the capacity ceiling — plan upgrade +
  usage credits at scale), Resend 100/day free cap, welcome-credit conversion (Stuart's own
  builds ran 60-100cr vs 30 welcome — the free-tier calibration number).

## Canonical docs in-repo

`baseline/DEPLOY.md` (production runbook) · `baseline/RESEND.md` (email runbook + Stuart's
remaining dashboard steps) · `baseline/DECISION-hosting.md` ·
`baseline/PLAN-per-app-auth.md` (paid lane) · `baseline/PHASE-*.md` (history/evidence) ·
`baseline/PROVISIOND-PLAN.md` · migrations/*.sql (all applied live).
