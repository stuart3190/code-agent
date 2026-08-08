# Package 10E infrastructure recovery evidence

Date: 2026-08-08  
Verdict: **FAIL — C8 stale-CAS RPC reproduces PostgREST 504**

## Credential containment

- Exposed credential: new-format Supabase secret key, id
  `a2dae86d-2da2-49db-8869-44c363765323` (value never recorded here).
- Replacement key id: `3cedf3a4-f6f8-43a1-8d04-d821836cc286`.
- Old authentication after revocation: HTTP 401.
- Replacement authentication before/after revocation: HTTP 200 / 200.
- Updated stores only: shell `.env`, build-worker environment file.
- Removed unsafe plaintext copies: 4.
- Full streamed large-log matches: 0.
- Containment evidence SHA-256:
  `16a9834085b93212979e5f5a1a09edc52e123469090d87f33a24b6fb0c0b4914`.

## Data API diagnosis and recovery

Before recovery, Postgres was below capacity (21/60 connections) with no blocking locks or
long-running application query. The managed PostgREST pool held ten idle/aborted transactions.
Stopping shell/worker did not clear them; terminating only nine stale PostgREST backends restored
the API. No connection limit, database setting, schema, migration, row, Caddy, or provisiond state
was changed.

Sustained proof after rotation/restart:

- Window: `2026-08-08T16:02:22.217Z` through `2026-08-08T16:03:32.334Z`.
- Cycles / requests: 30 / 150.
- Errors / pool timeouts: 0 / 0.
- Latency ms: min 47.17, p50 67.23, p95 99.93, max 218.61.
- End-state: 22/60 connections, 11 PostgREST connections, no lock waiters, no long-running work.
- Latest 100 API events after the window: 97 x 200, 1 x 204, 2 expected 403, zero 504.

## Canary attempts

Attempt 1 stopped before C8 because the disposable bulk deployment fixture omitted
`triggered_by_kind`; cleanup and customer parity passed. The fixture now sets the authoritative
`user` provenance explicitly.

Attempt 2 reached completion, but the stale-CAS request took about 125 seconds. The runner had
accepted any error for that negative proof, so the result was not accepted.

Attempt 3 required the exact SQLSTATE `40001` stale-version error. It passed lifecycle, diagnostics,
contract, knowledge, graph/index, retrieval, patch, snapshot promotion, snapshot preview/export/QA,
worker completion/recovery, cancellation, safe pre-dispatch restart, and
`provider_replay_unsafe`. It then failed closed because the stale activation call returned a 504
without code `40001`.

Supabase historical edge-log evidence for attempt 3:

| Timestamp UTC | Endpoint | HTTP |
|---|---|---:|
| 2026-08-08T16:11:07.180Z | `request_publish_activation` | 200 |
| 2026-08-08T16:11:07.665Z | `request_publish_activation` | 504 |

The authoritative C8 function raises reserved serialization SQLSTATE `40001` for a business CAS
conflict. That negative path is the deterministic trigger and must be forward-repaired before the
canary can pass.

## Cleanup and invariant proof

Final fixed-ID residue was zero across Auth, projects, build jobs, V2 builds/reservations,
snapshots/blobs, worker work, releases/intents, sites, and deployments. Production counts remained:

- projects 11
- build jobs 31
- published sites 1
- deployments 5
- AI requests 188
- usage records 284
- migration ledger 67
- active V2 composition jobs 0

The canary emitted the same pre/post canonical SHA-256 for all eight customer datasets. Flags
`bv2.enabled` and `bv2.owners` remain absent/off, managed settlement remains paused, and customer
worker/atomic-publish dispatch remains disabled. Shell, worker, provisiond, app, and public site
were healthy at stop. Caddy configuration SHA-256 remains
`8d3b0a269e0310a559cd50cf960b9683efa306a02f5521ab6296c7158d2d2098`.

## Required next approval

Approve one additive C8 forward repair that changes only stale-CAS business error signaling away
from SQLSTATE `40001`, proves immediate deterministic conflict through PostgREST, runs the full C8
state-machine regression suite, applies only that migration, and repeats this exact Package 10E
canary. Do not progress to later V2-only packages first.

