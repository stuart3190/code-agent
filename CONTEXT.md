# Thrallo handoff

## Current milestone

Phase 2 is implemented and live. The Phase 1 vertical slice includes the control-plane data model, v1 API, worker, commercial
OpenAI/Anthropic tool loop, Daytona runner, GitHub App installation flow, durable run artifacts,
usage metering, stale-run recovery, retry, signed GitHub webhooks, approval-gated commit/push/PR
publishing, and the new web workspace. Phase 2 adds a private, idempotent webhook-delivery ledger,
atomic background claims, exponential retry, crash recovery, and authoritative synchronization of
GitHub installation and repository-access lifecycle events. The product is branded Thrallo and the public repository
is `https://github.com/stuart3190/code-agent`. The production repository-to-pull-request proof
completed on 2026-07-29 as PR #2, including Daytona execution, explicit publication approval,
GitHub branch push, pull-request creation, and passing GitHub Actions verification.

## Verification state

- `npm run verify` passes locally and in GitHub Actions.
- Dedicated Supabase project `Code Agent` (`zczgvcsokfafuyognvwx`) is active and healthy in
  organization `nuzfrbtaqkoemvdajzfh`, region `eu-west-1`.
- The six Code Agent migrations are applied remotely. All 12 tables have RLS. Browser roles have
  no webhook-ledger grants, owner-readable policies explicitly target authenticated users, and
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

Build incremental repository indexing and encrypted per-user BYOK, followed by managed provider
routing and operational telemetry.

User-owned setup and billing actions are tracked in `YOU_NEED_TO_DO.md`.

## Important boundaries

- Browser: publishable Supabase key only.
- Shell: auth verification and owner-scoped control-plane API.
- Worker: service role, model keys, GitHub installation tokens, Daytona credentials.
- Sandbox: receives only the minimum short-lived clone credential; no platform service role.
- Imported Buildr generation routes remain in the server temporarily for compatibility but are not
  linked from the Thrallo UI. Remove them as the standalone control plane absorbs shared needs.
