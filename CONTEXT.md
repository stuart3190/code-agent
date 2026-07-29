# Code Agent handoff

## Current milestone

Phase 1 vertical slice is implemented locally: control-plane data model, v1 API, worker, commercial
OpenAI/Anthropic tool loop, Daytona runner, GitHub App installation flow, durable run artifacts,
usage metering, stale-run recovery, retry, signed GitHub webhooks, approval-gated commit/push/PR
publishing, and the new web workspace. The remote repository exists but this work has not been
pushed.

## Verification state

- `npm run verify` passes.
- Dedicated Supabase project `Code Agent` (`zczgvcsokfafuyognvwx`) is active and healthy in
  organization `nuzfrbtaqkoemvdajzfh`, region `eu-west-1`.
- The four Code Agent migrations are applied remotely. All 11 tables have RLS, Security Advisor
  is clean, and Performance Advisor reports no missing foreign-key indexes. Unused-index info
  notices are expected until the empty project receives traffic.
- The project URL and publishable key are configured in the ignored local environment files.
- The ignored local environment now has verified Supabase, Daytona (`eu` target), and OpenAI
  credentials. Paid inference is verified against `gpt-5.6-sol`; reasoning effort is explicitly
  configurable and currently set to `medium`.
- Never reuse Buildr101 production Supabase, Stripe, or provider secrets for this product.

## Next implementation slice

Add a durable, idempotent webhook-delivery ledger and synchronize GitHub installation lifecycle
events. Then add incremental repository indexing and encrypted per-user BYOK to the normalized
model gateway.

User-owned setup and billing actions are tracked in `YOU_NEED_TO_DO.md`.

## Important boundaries

- Browser: publishable Supabase key only.
- Shell: auth verification and owner-scoped control-plane API.
- Worker: service role, model keys, GitHub installation tokens, Daytona credentials.
- Sandbox: receives only the minimum short-lived clone credential; no platform service role.
- Imported Buildr generation routes remain in the server temporarily for compatibility but are not
  linked from the Code Agent UI. Remove them as the standalone control plane absorbs shared needs.
