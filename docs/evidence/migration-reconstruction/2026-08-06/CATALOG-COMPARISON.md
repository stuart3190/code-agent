# Fresh reset and production catalog comparison

## Fresh reset proof

- Supabase CLI: `2.111.0`.
- Disposable stack: `thrallo-migration-proof` on isolated ports 55320-55324/55327.
- `supabase db reset --local --no-seed`: passed without manual SQL.
- Migration list: all 60 local versions equal the 60 database versions.
- `supabase db lint --local --schema public --level error --fail-on error`: no schema errors.
- `supabase db diff --local --schema public`: zero bytes; no schema changes found.
- Deployed Edge Function `app-auth` type-checks and all seven referenced public tables exist.

The first local export was later found to have replaced non-ASCII punctuation with question marks
in 13 historical SQL files. Although those changes were confined to comments/comment strings and
did not alter the catalog, that reconstruction was invalid. The files were archived, the 60
authoritative `statements` arrays were re-read through the Supabase plugin, and Git conversion was
disabled for active migration SQL. The corrected 61-migration history independently passed reset,
lint, zero schema diff, and this catalog comparison again. Evidence is prefixed
`corrected-reconstruction-*` and `corrected-catalog-*`.

## Catalog counts

| Object | Fresh local | Production | Structural differences |
|---|---:|---:|---:|
| Public tables/views | 72 | 72 | 0 |
| Public sequences | 5 | 5 | 0 |
| Columns | 837 | 837 | 0 |
| Constraints | 285 | 285 | 0 |
| Indexes | 231 | 231 | 0 |
| Public functions | 6 | 6 | 0 |
| Non-internal triggers | 0 | 0 | 0 |
| RLS policies | 39 | 39 | 0 |
| Object grants after reconciliation | 1,075 | 1,401 | 326 production-only unsafe grants |
| Default privileges after reconciliation | 72 | 96 | 24 production-only unsafe defaults |
| Extensions | 7 | 6 | 1 expected local-only |

Function bodies and signatures are equal after normalising PostgreSQL's `$function$` dollar-quote
rendering. Tables, columns, defaults, nullability, primary/foreign/unique/check constraints,
indexes, functions, triggers, RLS flags, policy roles/commands/expressions, and catalog ownership
otherwise match exactly.

## Classified differences

### Expected local Supabase environment differences (4)

- Local schemas `_realtime`, `net`, and `supabase_functions` are created by the current local
  Supabase stack services.
- Local extension `pg_net` 0.20.4 in `extensions` is a current local-stack dependency.

These are platform-environment objects, not Thrallo application migrations.

### Unsafe production-only privilege drift (350)

The production project was created while Supabase automatically exposed new public objects. The
current local configuration follows the newer fail-closed default. The 60 stored migrations do not
contain these grants, so they are untracked production state rather than missing historical SQL.
The additive reconciliation migration intentionally produces a strict subset of production's
privileges; these rows will remain production-only until that migration is separately approved and
applied:

- 238 grants: all seven table privileges to both `anon` and `authenticated` on all 17 `bv2_*`
  foundation tables.
- 48 grants: six non-read privileges to `authenticated` on `ca_agents`, `ca_artifacts`,
  `ca_checkpoints`, `ca_github_installations`, `ca_repositories`, `ca_run_events`, `ca_runs`, and
  `ca_usage_records`, despite their migrations granting browser read only.
- 13 grants: all seven table privileges to `anon`, plus six non-read privileges to
  `authenticated`, on `deployments`, despite its migration granting authenticated read only.
- 3 grants: `EXECUTE` to `PUBLIC`, `anon`, and `authenticated` on
  `deployment_scope(uuid,text)`.
- 24 grants: `SELECT`, `UPDATE`, and `USAGE` to `anon` and `authenticated` on four server-write
  sequences. Their defining migrations grant sequence access only to `service_role`.
- 24 default privileges: the hosted project's legacy defaults grant browser roles future table,
  sequence, and function access. The additive migration replaces those defaults with explicit
  browser deny and service-role access.

RLS currently prevents browser rows from the policy-less Builder V2 tables, but grants are still a
real security-boundary drift and must not be copied into reconstructed history. Additive migration
`20260806210321_production_catalog_grants_reconciliation.sql` makes the intended privileges
explicit. It has passed a clean 61-migration reset, lint, and zero-diff proof locally. It has not
been applied to production.

There are no production-only or local-only application tables, columns, constraints, indexes,
functions, triggers, or policies. No historical migration needs editing.

Machine-readable post-reconciliation evidence is in `reconciled-catalog-diff.json`; the complete
local and production catalog snapshots are retained alongside it. `catalog-diff.json` is the
pre-reconciliation snapshot retained for audit history.
