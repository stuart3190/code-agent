# C8 atomic unpublish forward repair

Production migration `20260807174720_c8_atomic_unpublish_deployment_retirement.sql` replaces only
`complete_publish_activation(uuid)`. Its source SHA-256 is
`0a87cc0054a38c012466889d3479c42f8982b96fe81413276902f118afab5d69`.

The production-proven root cause was a stale `live` deployment after unpublish. A rollback can use
an `activation_deployment_id` different from the retained release's immutable `deployment_id`, so
retirement must select the one live deployment by owner and canonical deployment scope. The full
matrix also proved that the same lookup is required when replacing a rollback-activated release.
The unique `deployments_one_live_per_app` index was preserved.

Proof completed on 2026-08-07:

- Full 65-migration disposable reset: pass; no duplicate/failed migration.
- Local database lint: no schema errors; schema diff: no changes.
- Linux C8 application/filesystem matrix: 24/24 pass.
- Disposable database matrix: registration/idempotency, publish, rollback, unpublish, republish,
  scoped deployment retirement, immutable release identity, stale CAS, owner isolation, one
  reconciler lease, publish/unpublish and rollback/unpublish races all pass.
- Fault triggers after deployment retirement and before intent completion proved complete
  transaction rollback and safe retry.
- Linked dry-run proposed only the repair migration.
- Production ledger advanced from 64 to 65 exactly once. The installed function hash is
  `721ca5324b55b9f97a6728fd1db382c01a27fab125c935ba2904a123209b3b46`.
- Production disposable-owner matrix passed, including the original rollback deployment sequence,
  idempotent completion, stale writes, retry/reconciliation, both CAS races and a controlled outer
  transaction failure after completion logic but before commit.
- Cleanup removed every disposable user, project, site, release, intent and deployment. Customer
  publishing hashes and counts returned byte-for-byte to the pre-proof baseline.
- Linked lint remained clean; security/performance advisor totals remained at the prior 41/78.

Safety state after proof: Builder V1 remains the default; V2 flags have no enabled/owner rows;
managed settlement is paused; worker and atomic publishing flags are off; worker is inactive;
Caddy hash is unchanged; no code was deployed and shadowing was not restarted.

