# Builder V2 production remediation

This is the live implementation ledger for the approved Builder V2 production remediation
programme. It records what the repository and production evidence prove; an unchecked item is not
silently treated as complete.

## Safety baseline

- Audited/current `origin/main`: `92e4c9fe5c864799eee228f304849064bacb0190`.
- Implementation branch: `remediation/builder-v2-production`.
- Customer Builder V2 rollout remains paused. Builder V1 remains the customer default.
- `THRALLO_MANAGED_SETTLEMENT_PAUSED=1` is a mandatory release invariant.
- `THRALLO_BV2_KILL=1`, `bv2.enabled=false`, and an empty `bv2.owners` allowlist are mandatory
  until the internal-pilot gate is explicitly approved.
- No model-powered proof, provider spend, Stripe action, production mutation, or migration is
  authorised by repository work alone.
- The shadow period that began on 2026-08-06 is diagnostic history, not valid rollout evidence.
  Its clock restarts only after atomic graph persistence and complete drift validation are live.

Run the network-free local evidence capture with:

```text
npm run audit:remediation-baseline
```

The optional flag read is deliberately double-gated and remains read-only:

```text
THRALLO_BASELINE_READ_APPROVED=1 node ops/capture-remediation-baseline.mjs --live-read
```

Never paste the resulting service environment or credentials into this document. The report emits
only interpreted booleans/counts for rollout controls and never emits owner ids or raw environment
values.

## PR ledger

| PR | State | Evidence | Production action |
|---|---|---|---|
| PR-01 Freeze and current-state baseline | Local implementation complete | Current main matched; local capture, 5 focused tests, full code-agent suite, web build, and 118 browser tests pass | Live read awaiting explicit approval |
| PR-02 Reproducible Supabase history | Pending | Duplicate versions `20260801200000` and `20260801220000` are detected by PR-01 | No history repair or migration run |
| PR-03 Essential verdicts and cache | Local implementation complete | C2/C3 focused proofs, all 107 Builder V2 tests, and all 1,172 code-agent tests pass | None; deploy only after normal review |
| PR-04 Atomic graph and shadow | Pending | Audit evidence confirmed; current shadow period invalid | None |
| PR-05 Immutable snapshots | Local implementation complete | Stored-byte corruption, materialisation, concurrent promotion, memory/Supabase parity, and Builder V2 regressions pass | None; deploy only after normal review |
| PR-06 App eligibility/reset | Local implementation complete | UUID registry, origin policy, HMAC, atomic reset-claim, Deno check, and all 1,179 code-agent tests pass | Edge deploy and secret require explicit approval |
| PR-07 Assets | Pending | Audit evidence confirmed/partially confirmed | None |
| PR-08 Diagnostics/erasure | Pending | Audit evidence confirmed/partially confirmed | None |
| PR-09 Shared limits | Pending | Audit evidence confirmed | None |
| PR-10 Durable build leases | Pending | Audit evidence confirmed | None |
| PR-11 Build worker | Pending | Audit evidence confirmed | None |
| PR-12 Atomic deployment | Pending | Audit evidence confirmed | None |
| PR-13 Cost/retrieval | Pending | Audit evidence confirmed | None |
| PR-14 V2 composition | Pending | Placeholder confirmed | None |
| PR-15 Operational surfaces | Pending | Audit evidence confirmed | None |
| PR-16 Release pipeline | Pending | Audit evidence confirmed | None |
| PR-17 DR/SLO/final proof | Pending | Existing DR base partially confirmed | None |

## Evidence still requiring approved production read access

- Deployed commit and immutable artifact identifiers.
- Active release pointers and retained V1 rollback artifact.
- Redacted live values of settlement pause, V2 kill, enabled, owner allowlist count, and shadow.
- Remote migration-history mapping and actual schema checksum.
- Running service and worker versions.
- Latest complete backup timestamp and validated age.

PR-02 must not guess any of these values. In particular, duplicate local migration filenames must
not be renamed or repaired remotely until the real `supabase_migrations.schema_migrations` history
and corresponding live objects have been compared.

## Implemented correctness units

- `a5be84a` keeps unattributed essential failures blocking, records
  `journey_ownership_missing` separately, and supplies repair with deterministic bounded fallback
  context. The production orchestrator now uses the attribution result instead of bypassing it.
- Differential cache identity now includes the journey definition, full contract, verifier
  version, owner contents, transitive dependency contents, capability versions, generated
  backend/runtime contents and explicit environment/config versions. Zero-owner journeys are
  never cached. Every reuse carries its original verdict/evidence snapshot and a reason.
- Cache rows expire after 30 days by default; project/journey invalidation and retention pruning
  are explicit operations in both the memory and Supabase adapters. The existing
  `owners_hash` column stores the composite content-addressed key, so this safety fix adds no
  migration before PR-02 repairs migration history.
- Snapshot creation and materialisation now hash the bytes read back from storage, manifests are
  immutable, and ready finalisation is a conditional building-to-ready transition. Promotion
  byte-verifies the target immediately before activation and uses compare-and-set pointer updates;
  concurrent promotions cannot silently overwrite one another. Corrupt snapshots are marked
  `corrupt` and cannot become green, preview or published.
- Generated-app auth now accepts only a real `projects.id` UUID and an origin matching that
  project's active preview, live published site or verified custom domain. Reset codes use HMAC
  with the dedicated `APP_AUTH_RESET_PEPPER` Edge Function secret. Attempt consumption is a
  compare-and-set; a correct code is marked used before the password mutation, so parallel reset
  confirmations have one winner. The Edge Function must not be deployed until the pepper has
  been created and a rollback deployment is retained.
