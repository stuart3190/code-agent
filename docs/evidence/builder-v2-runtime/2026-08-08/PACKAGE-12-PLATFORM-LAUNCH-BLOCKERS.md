# Package 12 — platform launch blockers

Date: 2026-08-08  
Branch: `remediation/builder-v2-production`  
Result: **PASS (12A-12G)**

## Safety boundary

Builder V1 remained the customer default. `bv2.enabled` stayed absent/false, `bv2.owners` stayed
absent/empty, customer worker and atomic publish dispatch stayed off, and
`THRALLO_MANAGED_SETTLEMENT_PAUSED=1` remained set. No model/provider request, Stripe transaction,
Caddy change or provisiond operation occurred. Production proofs used disposable owners/projects.

## Changes

| Subpackage | Result | Confirmed defect and repair |
|---|---|---|
| 12A permanent erasure | PASS | Project deletion did not cover every runtime/storage/filesystem store. Added manifest-CAS, owner-scoped and idempotent project/account erasure, service-only RPCs, safe exclusive-blob deletion, shared-object retention and append-only content-free audit evidence. |
| 12B shared rate limiting | PASS | Security limits used a process-local `Map`. Added a service-only atomic Postgres fixed-window bucket, trusted-proxy parsing, account/token plus network identities and explicit fail policy per route class. |
| 12C authenticated logs | PASS | Native `EventSource` could not send bearer auth. Replaced it with authenticated `fetch`/`ReadableStream`, cursor reconnect, expiry/error classification and abort cleanup. |
| 12D analytics CORS | PASS | Global CORS could reject the public collector before its handler. Collector dispatch now precedes global CORS and enforces exact registered origin/app identity, POST, safelisted content type, 32 KiB and shared limits. |
| 12E provenance | PASS | A deployed tree could not prove its source/artifact identity. Added validated immutable deployment manifests, admin-only read endpoint and release artifact verifier. |
| 12F CI/release | PASS | Release validation omitted several security/database/artifact gates. Added pinned fast and non-production release workflows with scans, browser/database/worker/backup/provenance/smoke gates. |
| 12G DR/SLO | PASS | Manual restore evidence lacked recurring health and operator automation. Added encrypted off-host interface, scheduled isolated drill interface, five-minute health checks, realistic RPO/RTO/SLOs and recovery/alert runbooks. |

## Commits

- `b4f8b39` — erasure, shared request boundary, browser logs and analytics implementation.
- `3099f72` — backup coverage for Package 12 runtime tables.
- `bee774d` — immutable provenance, release CI and DR gates.
- `a1573fd` — account-erasure production proof.
- `d73d747`, `a702cf1`, `bb9683e` — restore compatibility across historical catalogs, Package 12
  tables and generated append-only identities.
- `2edee35` — bounded erasure parity proof.
- `6da2ec4` — two-instance shared-rate-limit proof.
- `c518317`, `959e074` — production HTTP/browser canary and correct live-stream cursor semantics.
- `04b1df5`, `2bd5be6` — DR evidence anchors and executable scheduled drill.
- `d3d19af` — append-only production migration evidence through row 70.

## Migrations

| Order | Migration | Local SQL SHA-256 | Result |
|---:|---|---|---|
| 69 | `20260808180841_platform_erasure_audit` | `31c8f602719792b374d5719c342d5be85b23910cc128c59e4aa56242b185c77a` | applied once |
| 70 | `20260808180845_shared_atomic_rate_limits` | `f4b3ba804e3ebf553528bb1d48a525b3ce8bc30f24df240205c4bf5d93e7125b` | applied once |

The linked ledger is 70, pending is zero, and no migration repair/revert occurred. Browser roles
cannot access the audit/limiter tables or service RPCs. Package 12 tables produced no new database
advisor warning; RLS-with-no-policy and unused-index informational notices are intentional for
service-only/new structures. Existing advisor warnings predate this package.

## Production proofs

### Erasure and parity

Disposable project and account deletion proved database/Auth/Storage/filesystem erasure,
exclusive-blob removal, shared-asset preservation, cross-owner rejection and idempotent replay.
The bounded parity set for every table the RPC can mutate was byte-canonical before/after. Audit
jobs `f45600ea-1882-4a7b-96b8-6d1b9323c85a` and
`4044b6b2-d0ac-49fe-9306-4c523d3c6eaa` retain only content-free proof metadata. Production ends
with four audit jobs / 19 events and no test owner/project/Auth identity.

Customer state remained 11 projects, 31 build jobs, one published site, five deployments and zero
custom domains. Pre/post customer hashes remained:

- projects `0cb073f5830643af5ea789cfecd7d5253ac8366471fd99bec0a81dc80df3b51b`
- build jobs `0c29aeb361775b7ab3118c27327d9fec0604a16dff6184a27bd00ccdd887a700`
- published sites `92ea8296717af577a980c433d8d633f384c212d0d9a7dda2513a050b61ec1d3a`
- deployments `c7f9a7a876643e030564dd96ca2bc987a2948cebb0ff6530f19e35b05adc6679`
- custom domains (empty) `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`

### Shared limits and HTTP boundaries

Two independent shell processes shared one production bucket: only the first 120 allowed requests
succeeded, restarting a process did not reset it, and 122 authenticated actor/network attempts were
accounted without collapsing different authenticated actors behind one network. Both scoped shell
processes were removed.

The production HTTP canary proved authenticated fetch streaming, no bearer query value, Thrallo and
registered custom origins, and rejection of unregistered/malformed app ids, wrong content type and
oversized bodies. The final real Chromium E2E passed against the non-stubbed SSE handler.

### Provenance and operations

The running application identity is:

- Git `a702cf136fd1e25215b66561440795172995d591`
- source `e7538e815bd912ea734a44ec1fc00b086364647cff53ee2b39da2968f9583e29`
- web `c9afafc50c4329dff0d559e80405fe25bba2279cff1ccd5d039f80721bf7a44e`
- shell `afd347a71d78fb920f06e9f18b68202a833a8f5f3d481059c38c953f60a8050e`
- worker `865f952a29d1d6613003b312bbfa65f5e5787630cd48e7e30e67e76bcd52fba9`
- migration ledger `2770a05c7c9dc703ca4b507a6fec36980591e35be01ff28492f8f98661ebae54`
- manifest identity `7692155a5231978f7fb698e3406b59b59de8bb2991634e6f0f064c0b6a4b1753`

The manifest is mode `0444`; unauthenticated operator API access returns 401 and all artifact hashes
verify. Shell health and `app.thrallo.com` return 200. Worker and provisiond were not restarted.
Caddy remained `8d3b0a269e0310a559cd50cf960b9683efa306a02f5521ab6296c7158d2d2098`.

DR health passed backup age, restore age, queue age, worker heartbeat, reconciliation backlog,
build/verification failures, PostgREST health, identity match and storage growth. The five-minute
health timer is active. Off-host and monthly restore timers are installed but disabled pending an
operator-supplied encrypted remote and independent probe command; this avoids pretending a paid
external target exists.

## Backup and isolated restore

- Backup: `/home/ubuntu/thrallo-backups/thrallo-2026-08-08T194910`
- Window: `2026-08-08T19:49:10.349Z`–`19:49:47.442Z`
- Manifest SHA-256: `88e436df7de0322869143cfda6c3b1ef2109721a49ae9a2f5c0c64439a2098e1`
- Catalog: 86 tables; 85 canonical backed application tables
- Restored application rows: 36,705
- Auth / Storage / filesystem: 19 / 2 / 170 files plus 51 directory records
- Backup payload: 263 files, 32,799,141 compressed bytes
- Evidence: `/home/ubuntu/thrallo-restore-evidence/package12-post-migration-final-20260808T1955Z`
- Evidence index SHA-256: `b9ded5d9f50fde3e6bfb91690b7054fef2e081e14d0673f5696ad351c8cc8d87`
- Restore window: `2026-08-08T19:56:25.854Z`–`19:56:48.611Z`
- Independent external monitoring: 212 attempts, zero connections, covering the entire data-bearing
  window through cleanup.

All hashes/counts, runtime links, generated columns, owner isolation, Storage and filesystem modes
passed. Disposable containers, volumes and restored filesystem were destroyed and all ports closed.

## Regression results

- code-agent: 1,318 passed, 17 intentional skips, zero failed (1,335 total)
- V2 qualification: 159 passed, 17 intentional skips, zero failed (176 total)
- focused backup: 32/32
- authenticated Chromium stream: 1/1
- secret scan: 1,125 files, zero findings
- root/web production dependency audits: zero vulnerabilities
- production web build: PASS; existing 574.54 KiB main-chunk warning remains

## Rollback and forward repair

The database changes are additive. Do not delete their ledger entries. If application rollback is
required, deploy the retained pre-Package-12 application archive while leaving the service-only
tables dormant; forward-repair callers before removing any audit data. The rate table is ephemeral
and may be pruned only by its bounded retention operation. Erasure audit evidence is append-only and
must not be rewritten. The application rollback archive is
`/home/ubuntu/thrallo-app-rollbacks/pre-package12-a702cf1-20260808T1933Z.tar.gz`.

## Operational note

A malformed evidence-permission command affected only local remediation evidence permissions; it
did not touch production services, customer data, Supabase, Caddy or provisiond. The root evidence
directory was restored and the event is recorded in
`docs/incidents/2026-08-08-package12-evidence-permissions.md`.

## Remaining boundary

Package 12 is complete. External backup credentials/probe configuration remains an explicit
operator setup item, not a silently claimed configured provider. The next authorised-plan package
is Package 13: provider/billing closure and executable model catalogue, beginning with zero-model
synthetic proofs. It does not unpause managed settlement or authorise model spend.
