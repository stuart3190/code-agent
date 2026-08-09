# Desktop account and entitlement server boundary

Repository inspection during D3 confirmed that the current portal reads owner-scoped account data
from `GET /api/v1/settings`, billing and allowance data from `GET /api/v1/billing`, and usage records
from `GET /api/v1/usage`. The existing portal performs subscription, budget, cancellation and
billing-portal mutations through separate POST operations. D3 does not import, call or remount any
of those mutations.

The stable desktop adapter therefore requires an injected D1 transport and an explicit
origin-relative GET/HEAD route map. It has no default origin, default paths, production fallback or
mutation methods. Normalizers remain host supplied because the production desktop contract is not
yet frozen.

The following production contracts remain unresolved:

- public desktop-safe account identity and active-device summary fields;
- normalized entitlement states, resource grants and unknown-limit representation;
- whether trial, suspension and recovery-only states are emitted by the authoritative service;
- cloud-desktop and native-managed-service entitlement semantics;
- usage units for agents, browser tests, persistent storage and interactive workspace compute;
- freshness, cache lifetime, period reset and hard-limit enforcement metadata;
- subscription recovery and suspended-workspace recovery portal destinations;
- authorization of future cloud launch eligibility without provisioning a workspace.

Until those contracts are separately approved, deterministic fixtures are authoritative only for
desktop behavior tests. Unknown or stale entitlements fail closed for managed and cloud actions.
