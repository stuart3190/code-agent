# Builder V2 runtime database proof — 2026-08-08

## Scope and safety

This proof covered only the two unapplied migrations:

- `20260807213500_bv2_runtime_model_reservations.sql`
- `20260807221000_bv2_runtime_composition.sql`

No production SQL write, migration application, code deployment, model/provider call, Stripe
transaction, feature-flag change, settlement change, Caddy change or service restart occurred.
Production remained on its authoritative 65-row ledger with Builder V1 active.

The disposable target was the existing Postgres 17 Supabase proof stack on VPS loopback ports
`55320-55327`. The persistent IPv4/IPv6 `DOCKER-USER` isolation guard was active before startup.

## Defect found and repaired locally

The initial reset failed because legacy `build_jobs.project_id` is `text` while V2 build and
diagnostic project IDs are `uuid`; PostgreSQL correctly rejected the proposed composite foreign
keys. Production read-only evidence confirmed all 31 current `build_jobs.project_id` values are
valid UUID strings, but changing the V1 column type would create unnecessary compatibility and lock
risk.

The still-unapplied runtime migration now adds generated `project_id_text` compatibility columns to
the V2 parent tables and references those from the unchanged V1 text column. Exact owner/project
foreign keys and targeted `ON DELETE SET NULL` behavior remain enforced. No historical or applied
migration was edited.

Migration SHA-256 values after the repair:

- `20260807213500`: `71162D0BE0C66C687EA28530B2DFD95B5E9C25DDD317B570122B333FE8E1B5B4`
- `20260807221000`: `94FBF975EF034CECAFE88E9927B6D5AA74DBCCB54D098B45387D57120D636016`

## Disposable proof

- Fresh reset: PASS, all 67 migrations applied in order without manual intervention.
- Duplicate versions: zero.
- DB lint (`public`, error level): PASS, no schema errors.
- Schema diff after reset and after proof cleanup: PASS, no changes found.
- Catalog: 83 public tables, 34 public functions, 47 policies, 309 indexes and one trigger.
- Proof cleanup: zero proof users, projects, reservations and diagnostic rows remained.

Database-level runtime proof:

| Proof | Result |
|---|---|
| reservation replay | same durable row |
| conflicting call-key identity | rejected |
| concurrent per-build ceiling | exactly one winner |
| concurrent owner-wide managed availability | exactly one winner |
| settlement replay | one usage row, no double charge |
| repeated provider request telemetry | rejected across reservations |
| browser table/RPC access | rejected |
| cross-owner settlement | rejected |
| cross-project build/diagnostic links | rejected by FK |
| crash before V2 build creation | `restart_before_provider` |
| crash after V2 build but before reservation | abandoned build failed and restart allowed |
| crash with any reservation evidence | `provider_replay_unsafe` |
| durable public completion | `recovered` without replay |

The proof is permanent in `ops/prove-bv2-runtime-postgres.mjs` and runs in migration-validation CI.

## Linked production dry-run

- Connected project: `zczgvcsokfafuyognvwx`.
- Authoritative remote ledger: 65 unique rows through `20260807174720`.
- Local ledger: 67 unique files.
- Dry-run: PASS; exactly the two migrations above were proposed, in order.
- No migration repair, revert or additional migration was proposed.

## Production data preflight hard stop

The runtime-composition migration is not yet safe to apply. Read-only relational preflight found:

- 13 `bv2_builds` rows without an owner-matching `projects` parent.
- 12 `bv2_verification_cache` rows without a project parent.
- two `bv2_snapshots` rows without a project parent.
- one `bv2_project_pointers` row without a project parent.

All rows belong to one still-existing owner and were created on 2026-08-05/06. The missing projects
span earlier contact and booking qualification attempts, including two ready snapshots and a green
pointer. Their repeated proof-like shapes are evidence for investigation, not sufficient authority
to delete customer-associated data.

Do not weaken the foreign keys, mark them `NOT VALID`, create invented parent projects, or delete
these rows without explicit data-reconciliation approval. Classify them against backup/build
history first. Legitimate state must have its real project restored; proven disposable state must be
erased through an audited, bounded transaction. Then rerun every orphan check, reset/diff proof and
linked dry-run before production application.
