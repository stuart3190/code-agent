# Thrallo handoff

## Current milestone

Phase 5 is implemented and live. The Phase 1 vertical slice includes the control-plane data model, v1 API, worker, commercial
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
symbol-map context injection before agent execution.

## Verification state

- `npm run verify` passes locally and in GitHub Actions.
- Dedicated Supabase project `Code Agent` (`zczgvcsokfafuyognvwx`) is active and healthy in
  organization `nuzfrbtaqkoemvdajzfh`, region `eu-west-1`.
- The ten Code Agent migrations are applied remotely. The repository index and intelligence tables have restrictive
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
  implemented with encrypted-at-rest source metadata and service-only graph tables.
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

Add Gemini, managed cost/latency routing, and provider evaluation, followed by subscription
controls and operational telemetry.

User-owned setup and billing actions are tracked in `YOU_NEED_TO_DO.md`.

## Important boundaries

- Browser: publishable Supabase key only.
- Shell: auth verification and owner-scoped control-plane API.
- Worker: service role, model keys, GitHub installation tokens, Daytona credentials.
- Sandbox: receives only the minimum short-lived clone credential and, for a Codex-selected run,
  a private temporary Codex auth file that is deleted before the workspace is preserved or discarded;
  it never receives the platform service role or encryption key.
- Imported Buildr generation routes remain in the server temporarily for compatibility but are not
  linked from the Thrallo UI. Remove them as the standalone control plane absorbs shared needs.
