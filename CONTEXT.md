# Thrallo handoff

## Current milestone

**The v2 pivot is approved and underway.** `docs/PRINCIPLES.md` (12 principles +
implementation emphases + platform architecture) is the source of truth for every
implementation decision; the roadmap lives in `Desktop\Thrallo_V2_Roadmap.md`. Phases run
with a Stuart approval gate at the end of each.

THE CONSOLE MERGE (2026-07-31, Stuart's final consolidation directive, PR #55, deployed):
**there is now exactly one Thrallo application** — /console is deleted (old bookmarks land
home) and every former console capability lives natively in the conversation-first app,
redesigned around user goals rather than ported: the Settings sheet is the one settings
experience with drill-ins for what must live there (AI connection incl. BYOK keys + the
Codex device flow + smart routing + provider health/comparison; API tokens; Downloads —
secrets never enter the conversation); summonable token-styled views in
`shell/web/src/manage/` (RepositoriesView — GitHub App connect, index progress/reindex,
per-repo drill-in where old per-agent policies became repository policies, open PRs whose
[Review] sends a sentence, per-repo automations, code/symbol search; UsageView — meters,
spend guards, plan switch/portal, records; OpsView — admin telemetry; RunOverlay — live
timeline, artifacts, full approval machine); and the `open_view` capability makes
conversation the entry point ("Show me my repositories" → the view opens instantly, Lead
narrates one line — LIVE-PROVEN in production). The agents CRUD workspace, dashboards, and
manual run launching were dissolved, not ported. Net −800 LOC. The desktop ships this same
unified bundle. Verify 197/197 + 8/8; every surface screenshot-reviewed.

Phase 24 (v2) — Buildr101 retirement + cleanup — is in progress (2026-07-31), with
everything not gated on Stuart complete: **workspace context** (Stuart's final principle)
is live end-to-end — the desktop extension streams active file/selection/diagnostics to the
conversation panel (debounced bridge in `editor/vscode/extension.js`), the composer shows a
dismissible context chip, `postUserMessage` accepts a sanitized bounded `workspaceContext`
(`sanitizeWorkspaceContext` in leadAgentService), the model turn carries it as a marked
suffix while the visible thread stays the user's words with a "⌁ shared file" line.
**Retirement step 3 done**: final validated Supabase export of qgemqjcyhuejrsvjxkbh stored
off-box (`C:\Users\Administrator\buildr101-final-export-2026-07-31.tar.gz`, 33 tables, 109
auth users). **Repo cleanup done**: the legacy Buildr HTTP surface (71 handlers across 29
route modules — generate/builds/billing/templates/connectors/runtime/android/qa/owner
console/…) is unmounted from `shell/server/index.mjs` (route FILES remain where Thrallo
imports pieces, e.g. `slugify` from routes/publish.mjs); the orphaned Buildr web UI is
deleted (builder/, legal/, TopBar, BillingPanel, SettingsPanel, lib/api.js + friends —
verified importer-free first). `/console` is KEPT deliberately: AI connection, API tokens,
repos, reviews, automations management still live there until conversational parity.
Deployed 2026-07-31 and live-verified: Thrallo surfaces all 200, buildr101.com and
focusflow.app.thrallo.com unaffected, legacy `/api/generate` properly 404. LIVE
context proof: a production message carrying workspaceContext (file/selection/diagnostic)
got a Lead Agent reply that named the file, quoted the selection, and explained the
warning — nothing pasted by the user. Remaining steps are Stuart-gated (YOU_NEED_TO_DO.md
§Phase 24): stop the Meta ad, audit/cancel Stripe subs → then freeze, reboot test, stop
buildr-* services, retire monitoring/email. **Desktop packaging waits for this phase to
complete (Stuart's instruction).**

Phase 23 (v2) — Thrallo Desktop adopts the conversation surface — is built and
smoke-proven (2026-07-31): the desktop's primary view is the SAME built web bundle as
app.thrallo.com, hosted by the builtin extension in a webview running in desktop mode
(`editor/vscode/lib/conversationPanel.js` — asset-URI rewrite, strict CSP with a nonce for
the injected bootstrap, `window.__THRALLO_DESKTOP__` = {server, PAT}); it auto-opens on
startup in the Thrallo fork only, shows a one-action connect prompt without a token, and
re-renders on reveal after connecting. Desktop-mode seams in the web bundle are inert on
the web (accessToken → injected PAT, apiBase prefix, synthesized session). CORS now allows
VS Code webview origins (bearer-only API — verified live with a preflight). Build plumbing:
`syncBuiltin`+`syncWebApp` run before every dev/compile/package and always travel together
(the prepare marker hashes the COMMITTED tree — uncommitted extension work never reached
the builtin otherwise; the builtin copy wipes media/app). Desktop smoke has a STRICT sixth
check (the Begin screen must render inside the webview; connect-prompt-only fails) — dev
build passed 6/6 against live production. Three real defects found via that loop: CSP
blocking the inline bootstrap (nonce), stale builtin, wiped bundle. PRs #51/#52, verify
194/194 + 8/8 + smoke 6/6. **NO PACKAGING — awaiting Stuart's Phase 23 desktop review;
then Phase 24 (Buildr101 retirement, strict ops order).**

Phase 22 (v2) — publish, domains, notifications, automations as conversation — is live and
proven (2026-07-30/31): `appBuild/appPublishService.mjs` (lean conversational publish:
unique slug collision-checked against the shared publish root, real production build, ship
to Thrallo provisiond, `published_sites` record) + `connectDomain` (custom_domains row +
provisiond symlink; ask gate approves the domain immediately, A-record instructions
returned). `notifications/`: dependency-free web push (RFC 8291 aes128gcm + RFC 8292 VAPID
ES256 — proven by receiver-side decryption in tests), Resend email adapter dormant until
`THRALLO_RESEND_KEY`, `notifyOwnerIfAway` skips channels while anyone streams the
conversation; wired to preview_ready/build-failure/question_asked/publish. Capabilities
`publish` / `configure_domain` / `create_automation` registered (registry only). Ask gate +
`ops/Caddyfile.unified` extended for `*.app.thrallo.com` (on-demand certs) + Thrallo custom
domains. Shell renders `published` receipts; settings sheet has the single notifications
row; `public/sw.js`. Migration `app_publish_platform` applied; backups extended. LIVE
PROOF: "Publish this, please." in the FocusFlow conversation → Publisher choreography
(Building → Uploading → Going live) → **https://focusflow.app.thrallo.com/ HTTP 200, LE
cert minted on demand**; "Every week, check…" → Lead Agent created a real scheduled_task
automation via create_automation (deleted after proof so it never spends unattended);
notifications config live (webpush on, VAPID keys in prod env; email off pending Resend
key). OPS NOTE: `docker restart buildr-caddy` can fail on a reaped preview network — the
fix IS the P19 design: restart `thrallo-provisiond`, whose boot ensureCaddy rm-f's and
re-raises the front byte-identically (proven live; ~30s outage). PRs #49/#50, verify
191/191 + 8/8. **Awaiting Stuart's Phase 22 review before Phase 23 (desktop conversation
surface) and Phase 24 (Buildr101 retirement).**

Phase 21 (v2) — the conversation-first production UI — is live at https://app.thrallo.com/
(the console is preserved at /console during the transition; /design keeps the wireframes):
`shell/web/src/chat/` — ChatShell (Begin → thread → living rail with preview dominance →
settings sheet → ⌘K palette; mobile team strip + full-screen preview sheet),
`conversationState.js` (pure reducer: thread/roster/rail derive from
ca_conversation_events replay + live SSE `after`-resume — tested against the real Phase-19
production stream), escaped-first markdown, canonical tokens (light default + dark).
Permanent UI is exactly the four; the rail's Publish action just posts a sentence to the
Lead Agent. Real defect fixed en route: CSP `frame-src` still only allowed buildr101
domains — Thrallo preview iframes would have been blocked (httpSecurity.mjs). Playwright
converse→team→preview flows run at desktop+mobile with a stubbed API + seeded session
(e2e/chat-shell.spec.mjs; skips without local auth env; test:ui includes it). PR #47,
main `a471518`, verify 186/186 + 8/8. **Awaiting Stuart's production UI review — the
Phase 21 gate — before Phase 22 (publish/automations/notifications as conversation).**

Phase 20 (v2) — design system + wireframes — is implemented and live at
https://app.thrallo.com/design/ (static, unlinked, noindex): `docs/DESIGN.md` is the
experience brief (permanent UI = exactly conversation + living agent rail + preview +
settings sheet; the rail is ONE surface with three states empty→team→team+preview; preview
is the hero; approvals/questions are in-thread cards; ⌘K hides the power; explicit removals
listed), canonical tokens at `shell/web/src/theme/tokens.css` (light default + dark, violet
accent + specialist hues, Space Grotesk/Manrope — NOT imported by App.jsx yet), and a
self-contained clickable prototype at `shell/web/public/design/` (four scenes incl. an
auto-choreographed Build→Preview replay of the real Phase-19 event vocabulary, mobile
frames, settings sheet, palette, publish flow, dark toggle; token parity + self-containment
guarded by test). PR #44, main `2141c82`, verify 179/179. **Awaiting Stuart's wireframe
approval — the Phase 20 gate — before Phase 21 builds the production UI.**

Phase 19 (v2) — app builds on Thrallo infrastructure — is implemented and live-proven
(2026-07-30): the Buildr generation pipeline runs entirely on Thrallo. `projects` +
`build_jobs` live in Thrallo's own Supabase (service-role only); the legacy credit ledger is
replaced by `appBuild/budgetLedger.mjs` (Thrallo budgets behind the legacy ledger interface,
spend recorded as standalone usage rows `kind: app_build`); `appBuild/openaiEngineProvider.mjs`
gives the engine its `runTurn` contract over the OpenAI Responses API (managed key), with
`buildContext.mjs` resolving BYOK (Anthropic via routing provider / owner's OpenAI key) per
owner. The engine is exposed ONLY through the Capability Registry as `app_build`
(`appBuildService.mjs` relays build phases as the staged Planner/Designer/Builder/Tester/
Publisher team and fires `preview_ready` unprompted). Preview infra: a second, Thrallo-owned
provisiond instance (`ops/thrallo-provisiond.service`, port 8791, own token, suffix
`preview.thrallo.com`), the shared Caddy front re-homed to the Thrallo-owned
`ops/Caddyfile.unified` (adds `*.preview.thrallo.com` on-demand TLS; deployed byte-identical
to /home/ubuntu/provisiond/Caddyfile.tls AND /home/ubuntu/code-agent/provisiond/Caddyfile.tls —
replace IN PLACE, the bind mount is by inode, and `admin off` means `docker restart
buildr-caddy` to apply), and the ask gate re-homed onto Thrallo's shell
(`routes/previewDomainCheck.mjs` + provisiond `/exists`: preview labels validated against
real containers so strangers can't mint certs; everything else passes through to the frozen
Buildr101 gate so customer domains keep renewing). Live proof: conversation "Build me a
pomodoro timer" → Lead Agent discovered `app_build` via the registry → 27-file FocusFlow app
generated (tree/design persisted server-side) → Let's Encrypt cert minted on demand →
https://pa12f1def1d17432b8d6facc8d785ea37.preview.thrallo.com/ served HTTP 200 → usage row
(gpt-5.6-sol, 48,493 in / 6,771 out, managed) recorded against Thrallo budgets. Buildr101
production (Supabase qgemqjcyhuejrsvjxkbh, its provisiond :8790, Stripe) untouched. PR #42
merged from main `99ef131`; migration `app_build_platform` applied; verify 177/177. NOTE:
previews use per-label on-demand certs (the Cloudflare token only covers the buildr101.com
zone) — Let's Encrypt caps ~50 new certs/week per registered domain; fine now, revisit with a
thrallo.com DNS token (wildcard DNS-01) before launch scale. **Awaiting Stuart's Phase 19
review before Phase 20 (design system + wireframes, Stuart gate).**

Phase 18 (v2) — the conversation platform — is implemented and live: Capability Registry
(the Lead Agent's tools are generated from it; extension proven by test), the durable Lead
Agent loop with specialist lifecycle events over resumable conversation SSE, the three-layer
Memory System (encrypted owner profile, named products, episodic memories), run
dispatch/relay, budget metering, stale-thinking recovery, and a temporary chat pane in the
existing console. Live production proof on 2026-07-30: a real conversation invoked
get_status (accurate live run states and budget numbers) and remember (product persisted to
ca_products/ca_memories), replying in plain English. One live-verification fix (#40):
strict tool schemas need all-properties-required with nullable optionals. Deployed from main
`bd5280a`; migration `conversation_platform` applied (6 service-only encrypted tables).
Phase 18 was approved and Phase 19 built on it directly.

Prior state: Phase 17's Code - OSS Thrallo Desktop reached its first verified Windows
milestone (dev + packaged builds 5/5 smoke-verified). Phase 12's automatic PR reviews are
active: the GitHub App subscribes to `["pull_request", "push"]`. The Phase 1 vertical slice includes the control-plane data model, v1 API, worker, commercial
OpenAI/Anthropic tool loop, Daytona runner, GitHub App installation flow, durable run artifacts,
usage metering, stale-run recovery, retry, signed GitHub webhooks, approval-gated commit/push/PR
publishing, and the new web workspace. Phase 2 adds a private, idempotent webhook-delivery ledger,
atomic background claims, exponential retry, crash recovery, and authoritative synchronization of
GitHub installation and repository-access lifecycle events. The product is branded Thrallo and the public repository
is `https://github.com/stuart3190/code-agent`. The production repository-to-pull-request proof
completed on 2026-07-29 as PR #2, including Daytona execution, explicit publication approval,
GitHub branch push, pull-request creation, and passing GitHub Actions verification. Phase 3 adds
encrypted per-user Codex device sign-in, OpenAI and Anthropic BYOK, managed-provider selection,
and isolated Codex subscription execution. Phase 4 adds bounded incremental repository scanning,
AES-GCM encrypted paths and source excerpts, scoped HMAC exact-code lookup, 1536-dimension OpenAI
embeddings, database-side hybrid ranking, owner-authenticated code search, and relevant context
injection before agent execution. Phase 5 adds encrypted language-aware definitions and signatures,
imports/calls/references/inheritance relationships, file dependency graphs, definition/reference
search, live indexing progress, durable manual refreshes, GitHub default-branch push refreshes, and
symbol-map context injection before agent execution. Phase 6 adds Gemini Interactions API support,
quality/balanced/fast/economy/manual model profiles, task-aware routing, retryable-error fallback,
provider latency and reliability health, encrypted provider evaluations, Gemini BYOK, and routing
and comparison controls in Settings. Phase 7 adds Free/Starter/Pro subscription plans, monthly
managed usage budgets (runs and sandbox compute for every run, managed tokens for managed-key
runs) enforced at run creation, worker claim, and mid-run, personal spend guards, billing-source
usage tagging, dormant `THRALLO_STRIPE_*` checkout/portal/webhook wiring that stays disabled
until pricing is approved, the Usage & billing workspace view, and the `ADMIN_EMAILS`-gated
`/api/v1/ops/telemetry` Operations view. Phase 8 adds per-agent publish policies
(require-approval or auto-publish with protected-path globs that force approval), sandbox
preservation on failure with linked resume runs that re-attach the same workspace and branch
(clean-baseline fallback on expiry), and private Supabase Storage artifact offloading with an
authenticated content route. Phase 9 adds per-agent sandbox network policies (offline blocks
egress after checkout, restored only for publishing; relaxed with a warning for Codex runs),
restricted command policies in the tool loop (in-sandbox publication always refused),
per-owner concurrent and hourly run admission caps, past-due metering at free-plan limits,
and a retention sweeper pruning run timelines and artifact content after
`CODE_AGENT_RETENTION_DAYS`. Phase 10 adds hashed personal access tokens (session-managed,
never operator-capable) authenticating the v1 API for editor clients, token management in
Settings, a real Downloads view, and the zero-dependency `editor/vscode` extension with an
agents view, run launching, live timeline streaming, diff review, approve/decline
publication, and resume. Phase 11 adds repository-aware pull-request review agents: PR head
checkout in the sandbox, a read-only review toolset that can still run tests, structured
findings (verdict/severity/line anchors), review artifacts, a Reviews workspace view listing
open PRs, and approval-gated posting of the GitHub review with conservatively mapped verdicts
and inline comments. Phase 12 adds automations: webhook-triggered reviews of new pull
requests (draft filtering, explicit autoPost opt-out of the approval gate) and scheduled
maintenance runs every 1–168 hours via an optimistically claimed sweeper, all passing the
same budget and rate-limit admission with run provenance and recorded skips. Phase 13 adds
the `thrallo` CLI: token login with 0600 config, run/review launching with streamed timelines
and interactive (or `--yes`) approval, plus repos/agents/usage/status/resume/cancel, built on
the shared zero-dependency API client. Phase 14 adds disaster recovery: nightly validated
backups of every control-plane table, auth users, and the artifact bucket under
`thrallo-backup.timer`, a migration-drift-guarded table list, a confirm-gated FK-ordered
restore script, and the `docs/DISASTER-RECOVERY.md` runbook (offline kit: `shell/.env` with
`PLATFORM_ENC_KEY` plus a copied backup run — a Stuart action). Phase 15 makes the VS Code
extension marketplace-ready — generated PNG icon, license, changelog, gallery metadata, a
proven `thrallo-0.2.0.vsix` package build — and adds inline run status: a live status-bar
indicator during runs and per-agent latest-run states with themed icons in the Agents view.
Marketplace publication is a documented Stuart action. Phase 16 adds opt-in inline code
completion: `POST /api/v1/completions` (fill-in-the-middle on the fastest configured tier,
enriched with encrypted-index excerpts, budget-gated for managed calls, standalone-metered,
per-owner rate-limited, Codex falling back to managed) and the extension's debounced
cancellable provider behind `thrallo.completions.enabled` (repository auto-detected when one
is connected), shipped as `thrallo-0.3.0.vsix`.

## Verification state

- `npm run verify` passes locally and in GitHub Actions.
- Dedicated Supabase project `Code Agent` (`zczgvcsokfafuyognvwx`) is active and healthy in
  organization `nuzfrbtaqkoemvdajzfh`, region `eu-west-1`.
- The eleven Code Agent migrations are applied remotely. The repository index, intelligence, routing telemetry,
  and encrypted evaluation tables have restrictive
  RLS and no browser grants; hybrid search is executable only by the service role. All control-plane
  tables have RLS. Browser roles have
  no webhook-ledger or AI-credential grants, owner-readable policies reject anonymous identities, and
  Performance Advisor reports no missing foreign-key indexes. Unused-index info notices are
  expected until the young project receives traffic.
- The project URL and publishable key are configured in the ignored local environment files.
- The ignored local environment now has verified Supabase, Daytona (`eu` target), and OpenAI
  credentials. Paid inference is verified against `gpt-5.6-sol`; reasoning effort is explicitly
  configurable and currently set to `medium`.
- Production target: the existing Buildr101 VPS, isolated as `/home/ubuntu/code-agent`, systemd
  service `thrallo-shell`, private port `8788`, and public origin `https://app.thrallo.com`.
- Production service and Caddy routes were installed on 2026-07-29. Internal `/api/health` and
  `/api/v1/capabilities` are green, and Buildr101 remained healthy after the proxy reload.
- Phase 3 was deployed from main commit `8539b2f` on 2026-07-29. Production reports encrypted credential
  storage, Codex device login, and BYOK as enabled. A real app-server device flow and the complete
  authenticated start/cancel HTTP route both returned `auth.openai.com` and cleaned up successfully.
- Phase 4 repository indexing is deployed on 2026-07-30. A paid
  `text-embedding-3-small` call returned one 1536-dimension vector, the database hybrid-search
  transaction returned the expected match, and the production repository index/search route is
  verified against `stuart3190/code-agent`.
- Phase 5 repository intelligence is deployed on 2026-07-30. Definitions, relationships, dependency
  graph routes, manual refresh queue, progress reporting, and agent symbol-map retrieval are
  implemented with encrypted-at-rest source metadata and service-only graph tables. Production
  indexed main commit `2788881` into 353 files, 572 context chunks, 1,925 definitions, 33,441
  relationships, and 849 dependency edges; exact definition lookup and forward/reverse file
  dependencies were decrypted successfully through the server-only retrieval layer.
- Phase 6 smart model routing is deployed from main commit `6d78771` on 2026-07-30. Production
  advertises the OpenAI Sol/Terra/Luna tiers, current Claude and Gemini catalogs, managed OpenAI
  availability, and optional BYOK for OpenAI, Anthropic, and Gemini. The full local verification
  suite passed with 63 Code Agent tests and four desktop/mobile Playwright checks. Supabase
  verification confirmed RLS enabled, no anon/authenticated table access, and service-role access
  for routing attempts and encrypted evaluation records.
- Phase 7 subscriptions, budgets, and telemetry are deployed from main commit `2fca243` on
  2026-07-30. The `subscriptions_budgets_telemetry` migration is applied remotely with RLS
  enabled, zero browser grants, a restrictive deny policy, the partial Stripe-customer unique
  index, the `billing_source` usage column, and the run-state telemetry index; the security
  advisor reports only the pre-existing leaked-password notice. Production capabilities
  advertise the three plans (free approved, paid pending pricing), budgets, and operational
  telemetry; `/api/v1/billing/webhook` answers 501 while dormant and the billing and ops routes
  require authentication. `ADMIN_EMAILS` is set to Stuart's account so the Operations view is
  visible to him. Local verification passed with 84 Code Agent tests and four Playwright checks,
  and Buildr101 stayed healthy after the restart.
- Phase 8 publish policies, sandbox resume, and object-storage artifacts are deployed from main
  commit `9364b8f` on 2026-07-30. The `approval_policies_resume_artifacts` migration is applied
  remotely and verified: the policy and resume columns exist, the private `thrallo-artifacts`
  bucket exists with storage RLS enabled and zero browser policies. Production capabilities
  advertise approval policies, auto-publish, protected paths, resume, and artifact storage; the
  full local verification passed with 97 Code Agent tests and four Playwright checks, and
  Buildr101 stayed healthy after the restart.
- Phase 9 egress/command policies, rate controls, and retention are deployed from main commit
  `7ddef64` on 2026-07-30. The `egress_command_policies_retention` migration is applied
  remotely and verified (policy columns, `pruned_at`, partial retention index). Production
  capabilities advertise network policies, command policies, rate limits, and 90-day
  retention; the full local verification passed with 105 Code Agent tests and four Playwright
  checks, and Buildr101 stayed healthy after the restart.
- Phase 10 API tokens and the VS Code extension are deployed from main commit `72a840a` on
  2026-07-30. The `api_tokens` migration is applied remotely; production capabilities
  advertise API tokens and the extension, the token routes require authentication, and
  Buildr101 stayed healthy after the restart. The full local verification passed with 114
  Code Agent tests and four Playwright checks.
- Phase 11 review agents are deployed from main commit `7c15810` on 2026-07-30. The
  `review_runs` migration is applied remotely; production capabilities advertise pull-request
  review and approval-gated posting, and Buildr101 stayed healthy after the restart. The full
  local verification passed with 122 Code Agent tests and four Playwright checks.
- Phase 12 automations are deployed from main commit `0d1203f` on 2026-07-30. The
  `automations` migration is applied remotely; production capabilities advertise
  pull-request-review automations, scheduled tasks, and autoPost; the automations routes
  require authentication; Buildr101 stayed healthy after the restart. The full local
  verification passed with 130 Code Agent tests and four Playwright checks. Automatic PR
  reviews activate once the GitHub App subscribes to the Pull request event (Stuart action).
- Phase 13's CLI is deployed from main commit `c1f6b3f` on 2026-07-30 (no migration). The
  shell restarted healthy, `node cli/thrallo.mjs help` works on the production checkout, and
  Buildr101 stayed healthy. The full local verification passed with 136 Code Agent tests and
  four Playwright checks.
- Phase 14 disaster recovery is deployed from main commit `ee861b8` on 2026-07-30 (no
  migration). `thrallo-backup.timer` is installed and active on the VPS, the first real
  production backup succeeded and self-validated (25 files, every ca_ table plus auth users
  and the artifact bucket, ~14 MB gzipped), and the dry-run restore re-validated the run end
  to end. The full local verification passed with 140 Code Agent tests and four Playwright
  checks, and Buildr101 stayed healthy. The offline DR kit (shell/.env + a copied backup run)
  is a pending Stuart action in YOU_NEED_TO_DO.md.
- Phase 15's marketplace-ready extension is deployed from main commit `99dca33` on 2026-07-30
  (no migration; web Downloads copy updated). The `thrallo-0.2.0.vsix` package build is
  proven, the shell restarted healthy, and Buildr101 stayed healthy. The full local
  verification passed with 141 Code Agent tests and four Playwright checks. Marketplace
  publication (publisher account + vsce publish) is a documented Stuart action.
- Phase 16's inline completion is deployed from main commit `ad2129f` on 2026-07-30 (no
  migration). Production capabilities advertise `editor.inlineCompletion`, the completions
  route requires authentication, the shell restarted healthy, and Buildr101 stayed healthy.
  The full local verification passed with 148 Code Agent tests and four Playwright checks.
- The first production dogfood session completed on 2026-07-30: a CLI-launched run (PAT auth)
  executed via the Codex subscription, opened PR #35 adding the CLI `version` command, passed
  CI, triggered the pull-request-review automation via the live webhook (the reviewer ran the
  CLI tests itself, 8/8), had its review approved and posted to GitHub, and merged. Three
  rough edges surfaced and were fixed and deployed from main commit `fc0e50d`: the CLI's
  Windows exit crash (process.exitCode), prompt-sliced pull-request titles (synthesizeTitle),
  and publication copy shown for review-run approvals in the Agents workspace. The
  `claude-dogfood` API token and the repository's pr_review automation remain active.
- Thrallo Desktop reached its first verified milestone on 2026-07-30, on Windows, against the
  pinned Code - OSS 1.131.0 commit `3a03d6f7`: toolchain installed (MSVC 14.44 + Spectre
  libs + Python 3.12), `npm ci` and full compile clean, and the dev build's `Thrallo.exe`
  passed a 5/5 Playwright-driven smoke test — branded window, real local folder, file edit
  persisted to disk, integrated terminal executed a command, and the built-in Thrallo
  extension signed into production with an API token and listed live agents with run states
  in the THRALLO: AGENTS view (screenshots under desktop/out/smoke, gitignored). The
  packaged unsigned win32 build also completed and passed the same 5/5 smoke test as
  "Thrallo Desktop" (`desktop/VSCode-win32-x64/Thrallo.exe`, archived to
  `desktop/out/thrallo-win32-x64.zip`, 263.8 MB); getting there surfaced and fixed four real
  packaging constraints, one found by Thrallo's own automated review of this PR (no
  vscode-*-archive gulp task; quality=stable requires proprietary win32ContextMenu config;
  signtool needed on PATH for signature STRIPPING only; the upstream copilot builtin removed
  plus a guarded tolerance patch). VERIFIED: everything above, on Windows. CONFIGURED BUT
  UNVERIFIED: darwin/linux targets — macOS stays "Coming soon" in all public copy until
  Stuart approves. Nothing is signed, notarised, or store-published, and no paid accounts
  were created. No installer beyond the archive exists yet (Inno Setup integration is future
  work).
- Cloudflare DNS and automatic TLS are live. `https://thrallo.com` and `https://www.thrallo.com`
  redirect to `https://app.thrallo.com`; the public SPA, health endpoint, and capabilities endpoint
  all pass externally.
- The private `Thrallo Code Agent` GitHub App is installed on `stuart3190/code-agent`. App
  authentication, short-lived installation tokens, signed webhook delivery, repository discovery,
  branch push, and pull-request publishing are verified in production.
- Phase 2 production proof completed on 2026-07-29 using a real `installation.created` redelivery.
  Delivery `b715b380-8b85-11f1-8dbe-4622a495bc7e` was stored once, processed in one attempt,
  refreshed installation `149918583`, and confirmed one accessible repository. A second
  redelivery kept the ledger at one row and one processing attempt.
- The first live run exposed and fixed Daytona writable-workdir, untracked-file diff, and
  post-refresh run-restoration defects. The fixes are tracked in PR #1 and deployed.
- Never reuse Buildr101 production Supabase, Stripe, or provider secrets for this product.

## Next implementation slice

Phase 24 completion: Stuart's steps 1-2 (Meta ad, Stripe audit — YOU_NEED_TO_DO.md), then
my steps 4-7 (freeze, reboot test, stop buildr-* services, retire monitoring/email), then
desktop packaging. Deeper src/ pruning of buildr-only modules is deferred until after the
services stop (some legacy prove-harnesses still exercise them). Roadmap substitutions
require asking Stuart first.

User-owned setup and billing actions are tracked in `YOU_NEED_TO_DO.md`. Flipping paid plans
live is Stuart-owned: approve prices, create the dedicated Thrallo Stripe products and webhook,
and set the `THRALLO_STRIPE_*` environment.

## Important boundaries

- Browser: publishable Supabase key only.
- Shell: auth verification and owner-scoped control-plane API.
- Worker: service role, model keys, GitHub installation tokens, Daytona credentials.
- Sandbox: receives only the minimum short-lived clone credential and, for a Codex-selected run,
  a private temporary Codex auth file that is deleted before the workspace is preserved or discarded;
  it never receives the platform service role or encryption key.
- Imported Buildr generation routes remain in the server temporarily for compatibility but are not
  linked from the Thrallo UI. Remove them as the standalone control plane absorbs shared needs.
