# Package 10E-F — C8 stale-CAS repair and Package 10E completion

Status: **PASS**  
Production project: `zczgvcsokfafuyognvwx`  
Completed: 2026-08-08

## Repair

- Migration: `20260808164259_c8_nonretryable_stale_cas.sql`
- Local/source SHA-256: `3c5d0787efef399df308b653b5269beaff4ddd89cde59df60966ea7a7c4744c7`
- Stored production statement identity SHA-256:
  `aed0b1c1fc37ca0756610ff674d650c380737307486ded632f4813367e9b6015`
- Production ledger: 67 -> 68; target present once; pending migrations zero; no repair/revert.
- Repair commits: `1ca9d6754f12cc8608593dc010b6ac65e5bd7469`,
  `9edbbece37edba5eafc3660cad43c2ed185a164f`, and
  `2357e60efbe542a12577e8f75b75274c5d5ddeb0`.

The five C8 functions with expected business/precondition conflicts now use PostgREST application
SQLSTATE `PT412` (HTTP 412). None uses reserved transaction class `40*` for those conditions.
Known `publish_activation_one_pending_per_site` races are translated to the same application
conflict only when PostgreSQL reports that exact constraint; unrelated uniqueness, genuine
serialization (`40001`) and deadlock (`40P01`) failures remain distinct.

The shell caller maps `PT412` to `stale_publish_cas` and separately classifies ownership (`42501`),
validation (`22023`), pool failure (`PGRST003`), retryable database failures (`40*`) and other
database failures without message matching.

## Disposable proof

- Network-isolated Supabase reset: all 68 migrations applied from zero.
- External probes during reset: zero successful connections.
- DB lint: no public-schema errors.
- Migra schema diff: zero bytes / no schema changes.
- Migration history: 60 authoritative + 8 append-only overlays = 68, zero pending/duplicates.
- Relevant Linux tests: 72/72 green when database-dependent and pure suites run in their intended
  isolated environments.
- Complete C8 database matrix: green for activation A/B, repeated stale activation, concurrent
  activation, rollback/stale rollback, unpublish/republish, rollback after unpublish,
  reconciliation, lost acknowledgement, duplicate completion, publish/unpublish and
  rollback/unpublish races, cross-owner rejection, one-live invariant, monotonic CAS and
  no-rebuild rollback.
- Repeated disposable stale proof: 40/40 `PT412`; p50 4.25 ms, p95 6.96 ms, max 12.60 ms;
  PostgREST sessions 2 -> 2; zero aborted sessions after completion.

## Production Data API proof

Window: `2026-08-08T17:17:31.441Z`–`2026-08-08T17:17:47.763Z`.

- 80/80 deliberately stale requests returned HTTP 412 / `PT412`.
- Two healthy activation requests returned HTTP 200 before/after the conflict loop.
- Zero HTTP 504, `PGRST003`, unexpected 5xx or retry amplification.
- Latency: p50 66.38 ms, p95 87.26 ms, max 101.56 ms.
- Sixteen interleaved healthy site lookups succeeded.
- Pool returned to the same three idle PostgREST workers; no persistent idle-in-transaction or
  aborted session remained. The management SQL wrapper itself is visible transiently as the
  fourth session while an inspection query executes and is not accumulated state.
- Disposable stress owner/project/releases/deployments/Auth identity were removed.

After the complete composition/worker canary legitimately expanded the idle PostgREST pool to
five workers, an immediate before/after stability rerun proved no further growth (five -> five),
zero persistent idle-in-transaction/aborted sessions, and another 80/80 `PT412` responses (p50
62.89 ms, p95 77.62 ms, max 90.55 ms). This separates bounded pool scaling under the broader
canary from a repeated-conflict leak.

## Complete Package 10E canary

Window: `2026-08-08T17:20:17.322Z`–`2026-08-08T17:20:34.009Z`.

Green stages: lifecycle, diagnostics, contract, project knowledge, atomic graph/index, retrieval,
patches, snapshot/promotion, snapshot-authoritative preview/export/QA, worker execution and durable
recovery, cancellation, `restart_before_provider`, `provider_replay_unsafe`, C8 activation A/B,
stale CAS, rollback without rebuild, unpublish/republish, legacy-tree adoption, trace completeness,
cleanup and customer parity.

Cleanup returned Auth, proof owners/projects, V2 builds/reservations, worker jobs/results/events,
snapshots/blobs, releases/intents and deployments to zero. All eight customer dataset hashes were
identical before and after. Model/provider calls, credits, Stripe transactions, customer mutations,
filesystem activation, provisiond and Caddy operations were all zero.

## Runtime and ingress safety

- `thrallo-shell`, `thrallo-build-worker`, and `thrallo-provisiond`: active.
- `app.thrallo.com`, `thrallo.com`, and `buildr101.com`: HTTP 200.
- Provisiond active timestamp remained `2026-08-08T13:19:54Z`.
- Caddy configuration SHA-256 remained
  `8d3b0a269e0310a559cd50cf960b9683efa306a02f5521ab6296c7158d2d2098`.
- Builder V1 remains default; `bv2.enabled` is absent/false; `bv2.owners` absent/empty; customer
  worker dispatch and atomic publishing remain off; managed settlement remains paused.

## Legacy service-role key assessment

The exposed legacy JWT service-role value was not printed, rotated, deactivated or redeployed in
this package. Production has one active Edge Function: `app-auth` version 7. Its deployed source
reads the platform-provided `SUPABASE_SERVICE_ROLE_KEY`, so it is the only confirmed active legacy
consumer. Four additional local functions (`app-actions`, `app-runtime`, `app-payments`, and
`app-analytics`) contain the same legacy lookup but are not deployed to this project. Shell and
worker use a new-format `sb_secret_` credential under the historical environment variable name;
manual backup/proof utilities inherit that new value and are not legacy-key consumers.

Safe follow-up sequence:

1. Confirm `SUPABASE_SECRET_KEYS` exists in the Edge Function environment and select a named key.
2. Change `app-auth` to parse that JSON map, use the named secret for its admin client, and preserve
   the current publishable caller contract.
3. Because new secret keys are not JWTs, explicitly design/test the function's gateway auth before
   changing `verify_jwt`; deploy a parallel/scoped version and exercise signup/signin/reset races,
   origin eligibility and abuse controls.
4. Promote the proven function, monitor, then deactivate the legacy keys only after a complete
   repository/webhook/CI/desktop inventory. Deactivation is reversible in the Supabase dashboard.
5. Roll back by reactivating the legacy keys and redeploying the recorded version-7 artifact if the
   new-key canary fails.

Rotation requires an Edge Function code change and redeployment; it is not safe as a secret-only
swap. It remains separately approval-gated.
