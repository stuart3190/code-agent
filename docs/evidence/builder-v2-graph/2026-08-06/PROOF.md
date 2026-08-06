# Builder V2 atomic graph and full shadow proof

Scope: local/disposable implementation only. Production project `zczgvcsokfafuyognvwx`, its
migration ledger, production data, flags, services and shadow timestamp were not mutated.

## Migration

- File: `20260806221153_bv2_atomic_graph_and_full_shadow.sql`.
- Active local history: 62 unique versions: 60 authoritative production migrations plus pending
  `20260806210321` and `20260806221153`.
- Fresh reset from zero: passed without manual SQL.
- `supabase db lint --local --schema public --level error --fail-on error`: no schema errors.
- `supabase db diff --local --schema public`: empty before and after the temporary fault harness.
- Authoritative history validation: 60 authoritative, 62 active, two pending, zero duplicates.

## Real Postgres transaction proof

The proof ran against an isolated Supabase stack on loopback ports 55320-55327 with a temporary
host firewall guard. Row triggers raised inside the real RPC after revision insertion, halfway
through symbols, during references and during edges. Each call rolled back every parent/child row;
each retry reloaded cleanly. Temporary triggers, function, table, users, projects and rows were
removed, followed by a zero schema diff.

```json
{"ok":true,"failures":{"after_revision":"rolled_back","halfway_symbols":"rolled_back","refs":"rolled_back","edges":"rolled_back"},"retries":{"after_revision":"clean","halfway_symbols":"clean","refs":"clean","edges":"clean"},"concurrent":"one_revision","ownerIsolation":"two_physical_tenants_cross_read_and_browser_access_rejected","parity":{"paths":2,"symbols":3,"refs":2,"edges":1},"gc":"shadow_and_snapshot_pins_preserved"}
```

The stored production fixture `run17b6513f-tree.json` also round-tripped with exact memory/Supabase
path, symbol, reference, edge and derived-query parity.

## Deterministic proof matrix

| Requirement | Proof |
|---|---|
| Failure after revision creation | Real Postgres trigger; all rows rolled back |
| Failure halfway through symbols | Real row-trigger on second symbol; all rows rolled back |
| Failure during references | Real trigger; revision/symbol/ref rows rolled back |
| Failure during edges | Real trigger; complete transaction rolled back |
| Retry after each failure | All four reloaded with zero missing/integrity rows |
| Same revision twice | Second call wrote zero rows |
| Concurrent same revision | Advisory lock plus unique identity produced one revision |
| Two owners, identical code | Separate physical revisions and exact owner scoping |
| Cross-owner reads | Owner/project mismatch rejected; authenticated table/RPC access denied |
| Missing/extra symbol | Exact `symbols` drift evidence |
| Missing reference | Exact `references` drift evidence |
| Extra edge | Exact `dependency_edges` drift evidence |
| Wrong opaque state/hash | `wrong_opaque` / `wrong_content_hash` evidence |
| Missing/extra path | `missing_path` / `extra_path` evidence |
| Stale run | `stale_shadow_run` evidence beyond configured age |
| Complete reload parity | Stored production fixture clean across base data and graph answers |
| Safe garbage collection | Shadow- and snapshot-pinned revisions retained |

## Backup compatibility

The row backup format is unchanged. `CA_TABLES`, restore order and isolated-restore validation now
cover `bv2_shadow_runs`, `bv2_shadow_run_files`, `bv2_shadow_checks`, graph readiness/count columns,
and ownership/revision links. The existing pre-migration production backup remains valid for the
pre-migration state. A new production backup and isolated restore are mandatory after deployment
and before restarting the shadow week.

