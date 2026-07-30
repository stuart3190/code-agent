# Thrallo handoff

## Current milestone

Phase 16 is implemented and live. Phase 12's automatic PR reviews are active: the GitHub App
subscribes to `["pull_request", "push"]`, verified from the live installation. The Phase 1 vertical slice includes the control-plane data model, v1 API, worker, commercial
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

Phase 17: SDK/plugin surface or dunning polish. The remaining pre-launch work is Stuart-owned
(Stripe products, marketplace publisher, business identity); the engineering roadmap's big
items are now desktop packaging, SDK, enterprise controls, and mobile.

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
