# Additive privilege reconciliation

Migration `20260806210321_production_catalog_grants_reconciliation.sql` addresses the only
application-catalog drift found after replaying the authoritative production ledger.

It is additive history: none of the reconstructed 60 files changed. It explicitly removes
production's untracked browser-write grants, grants the server role what Builder V2 needs, retains
the original owner-readable control-plane surfaces, closes an unintended public helper function,
removes browser access from server-write sequences, and fixes default privileges for future tables,
sequences, and functions.

The complete post-migration catalog comparison has 350 production-only privilege rows: 326 object
grants and 24 default privileges. This is intentional desired-state drift while production remains
unchanged. There are zero local-only or changed application objects.

## Forward repair

Every statement is safe to repeat. If deployment is interrupted, rerun the migration transaction.
If a server path reports permission denied, verify that its table is intentionally server-only and
grant only the necessary privilege to `service_role`; do not broaden browser roles.

## Rollback

The mechanically exact rollback would restore known-unsafe `anon` and `authenticated` write grants
and is therefore not an acceptable production operation. The safe rollback is a forward repair:

1. Keep browser revocations in place.
2. Re-grant `ALL` on the affected server-only table to `service_role`.
3. For the eight owner-readable control-plane tables or `deployments`, re-grant only `SELECT` to
   `authenticated` if required.
4. Leave Builder V2 rollout and managed settlement paused while access is verified.

No production migration or ledger entry was created during local proof.
Production application requires separate approval and a post-apply ACL/catalog verification.
