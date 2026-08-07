# C8 disposable proof

No production database, ledger, service, publish root, flag, Caddy process, shadow timer, model, or
Stripe API was changed.

- Migration: `20260807072455_atomic_immutable_releases.sql`
- SHA-256: `2ec3060ea38960f300dca36630cd256dd16c8eadeda0920d045c202af819fb1b`
- Fresh disposable Supabase reset: all 64 active migrations applied in order.
- Migration list: 64 local = 64 disposable applied; duplicate versions: zero.
- Database lint: no schema errors.
- Schema diff: no changes found.
- Postgres proof: registration retry/id conflict, CAS, one-active invariant, single reconciler lease,
  immutable columns, rollback, unpublish, owner/browser isolation, concurrent intent race and
  cascade cleanup all passed.
- Final Linux C8 matrix: 23/23 passed, including health failure, crash windows, idempotent
  reconciliation, lost-commit acknowledgement recovery, post-switch health rollback, concurrent
  publish, stale pointer, no-build rollback, publish/unpublish race, stable domain/subdomain
  identity, byte immutability, corruption/missing artifact, GC, runtime identity and worker
  fail-closed behavior.
- Final full Code Agent regression: 1,248 tests; 1,231 passed, 17 Windows-only C8 filesystem cases
  skipped, zero failures. The focused matrix passed all 23 cases on Linux and 6 applicable cases
  on Windows.
- Web production build: passed.
- Backup validation: passed.

The first Linux attempt found and fixed permission ordering: staging must be renamed while private,
then made read-only and re-hashed in its final location. This evidence records the corrected run,
not the initial failure.
