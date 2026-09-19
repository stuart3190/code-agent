# Package 13 provider/billing closure

Status: **PASS** on 2026-08-08. This package made no migration, model/provider request,
Stripe transaction, customer-routing change, Caddy/provisiond change, or managed-settlement
change.

## Deployed identity

- Git commit: `3c0164ddfe5fdbc26ec199f09267342addfbd358`
- Source archive SHA-256: `a77524086552b36282cd5f0a4acd01360b237c410671adf58de29d94cf5bc66b`
- Shell artifact SHA-256: `b421e5a702834468fab1dde37952b010fb075edde5adc10ed1441b63f913c89a`
- Worker artifact SHA-256: `d5fc90fd2fedfeebec3b3d369ad340f9cb5001dade1508e0f8927130a875b83d`
- Web artifact SHA-256: `6651bbb24f2910af1b8e263ccc82174afc964acff970810b785db504ac43cf70`
- Migration ledger: 70 rows, SHA-256
  `2770a05c7c9dc703ca4b507a6fec36980591e35be01ff28492f8f98661ebae54`
- Deployment identity SHA-256:
  `702b1f7c033f72cc43178fb26f7b63b678b150151cb2d548a0bd9357483e5a62`
- Read-only deployed manifest SHA-256:
  `15c2a051e8138399c9e318fc6d52d3b26b18ac9422d16203abefa16a213d77bf`
- Secret-free rollback archive:
  `/home/ubuntu/thrallo-app-rollbacks/pre-package13-a702cf1-20260808T2129Z.tar`
  (`ec6c9e652e0e8ff9ddc894ce615d2809f188c1646e8a56dd4a46acb5dac0901c`).

The application-only deployment restarted `thrallo-shell` and `thrallo-build-worker`. It did
not invoke or modify Caddy or provisiond.

## Deterministic proof

- Canonical catalogue, selector, router, lane, reservation and provider-outcome tests: green.
- Full repository suite: 1,344 total; 1,327 passed, 17 intentional skips, 0 failed.
- Web build: green. The pre-existing 574.63 KiB main-chunk warning remains.
- Secret scan: 1,126 files, zero findings.
- Real Playwright model-selector proof: green.
- Full browser run: 114/118 passed. The four failures are the same `/api/domain-check` expectation
  in four Chromium configurations while local provisiond was intentionally not started; no
  Package 13 selector/provider assertion failed.

The standalone `test:capability-runtime` command remains a release-harness issue: it refers to two
pre-reconstruction active-migration paths that now exist only in the immutable migration archive.
The full repository suite is green, but that standalone harness must be reconciled before the final
release pipeline is declared entirely green.

## Provider and billing contract

`modelCatalogue.mjs` is the single authority for provider, exact model, lane, reasoning profile,
billing policy and capability restrictions. Builder selection persists `lane:provider:model`
(optionally `#mode`). Manual choice is exact and cannot silently fall back to Auto, another
provider, or managed credentials.

Every V2 dispatch follows reservation -> dispatch evidence -> usage capture -> idempotent
reconciliation -> settle/release. Per-step and build ceilings fail before dispatch. Only explicit
pre-dispatch/rejected outcomes are replay-safe; any ambiguous post-dispatch outcome is
`provider_replay_unsafe`. Cached input is priced once with the provider multiplier, and reasoning
tokens remain diagnostic output-token detail rather than a second debit.

BYOK never reads or debits managed availability. Connected Codex allowance remains distinct from
BYOK and managed. Managed reservations are allowed to prove accounting, but actual managed
settlement remains paused.

## Production zero-model canary

Evidence:
`/home/ubuntu/thrallo-deploy-evidence/package13-20260808T2136Z/canary.jsonl`, SHA-256
`560c00e67d94c5a593ff4730a8dfb3b9253c7ea49e85ba9b44ec75a24ff0cea6`.

The fixed-owner canary proved:

1. BYOK Anthropic selection was pinned, reserved and cancelled before dispatch; it released with
   no provider call and no managed debit.
2. Connected Codex identity was pinned; synthetic usage settlement was idempotent and produced no
   managed debit.
3. Managed OpenAI identity reserved atomically and released while settlement remained paused; it
   made no provider call and no debit.
4. All three persisted reservations retained exact provider/model/lane identity.
5. Cleanup removed the disposable Auth identity, projects, builds and reservations.

The first canary attempt failed before reservation because the proof build had an empty provider
policy. It was retained as failed evidence, cleaned exactly, and fixed by pinning the same real
provider/lane policy required by production. No provider request occurred in either attempt.

Customer canonical hashes for projects (11), build jobs (31), published sites (1), deployments
(5), custom domains (0), AI requests (188), usage records (284), and subscriptions (2) were
identical before and after. Final production residue is zero V2 builds, zero reservations, zero
active V2 jobs, zero enabled `bv2.enabled` rows and zero non-empty `bv2.owners` rows.

## Safety and next gate

Shell, worker and `app.thrallo.com` are healthy. Builder V1 remains the customer default; customer
worker and atomic-publish routing are off; `THRALLO_MANAGED_SETTLEMENT_PAUSED=1` remains set.

The legacy Supabase service-role key was not rotated. The separately approval-gated, function-by-
function transition is documented in `docs/LEGACY-SERVICE-KEY-MIGRATION.md`.

The next authoritative package is Package 14: the minimum live generation, edit, repair, provider-
failure and booking qualification matrix. It requires explicit approval because it is the first
package that spends provider credits.
