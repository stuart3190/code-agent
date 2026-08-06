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
| PR-03 Essential verdicts and cache | Pending | Audit evidence confirmed | None |
| PR-04 Atomic graph and shadow | Pending | Audit evidence confirmed; current shadow period invalid | None |
| PR-05 Immutable snapshots | Pending | Audit evidence confirmed | None |
| PR-06 App eligibility/reset | Pending | Audit evidence confirmed | None |
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
