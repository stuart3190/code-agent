# Fresh reset and production catalog comparison

## Fresh reset proof

- Supabase CLI: `2.111.0`.
- Disposable stack: `thrallo-migration-proof` on isolated ports 55320-55324/55327.
- `supabase db reset --local --no-seed`: passed without manual SQL.
- Migration list: all 60 local versions equal the 60 database versions.
- `supabase db lint --local --schema public --level error --fail-on error`: no schema errors.
- `supabase db diff --local --schema public`: zero bytes; no schema changes found.
- Deployed Edge Function `app-auth` type-checks and all seven referenced public tables exist.

## Catalog counts

| Object | Fresh local | Production | Structural differences |
|---|---:|---:|---:|
| Public tables/views | 72 | 72 | 0 |
| Columns | 837 | 837 | 0 |
| Constraints | 285 | 285 | 0 |
| Indexes | 231 | 231 | 0 |
| Public functions | 6 | 6 | 0 |
| Non-internal triggers | 0 | 0 | 0 |
| RLS policies | 39 | 39 | 0 |
| Grants | 1,098 | 1,340 | 242 production-only |
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

### Unsafe production-only privilege drift (242)

The production project was created while Supabase automatically exposed new public objects. The
current local configuration follows the newer fail-closed default. The 60 stored migrations do not
contain these 242 grants, so they are untracked production state rather than missing historical SQL:

- 204 grants: full `SELECT/INSERT/UPDATE/DELETE` to each of `anon`, `authenticated`, and
  `service_role` on all 17 `bv2_*` foundation tables.
- 24 grants: `INSERT/UPDATE/DELETE` to `authenticated` on `ca_agents`, `ca_artifacts`,
  `ca_checkpoints`, `ca_github_installations`, `ca_repositories`, `ca_run_events`, `ca_runs`, and
  `ca_usage_records`, despite their migrations granting browser read only.
- 11 grants: full access to `anon` and `service_role`, plus browser writes to `authenticated`, on
  `deployments`, despite its migration granting authenticated read only.
- 3 grants: explicit `EXECUTE` to `anon`, `authenticated`, and `service_role` on
  `deployment_scope(uuid,text)` in addition to the function's default `PUBLIC` execute grant.

RLS currently prevents browser rows from the policy-less Builder V2 tables, but grants are still a
real security-boundary drift and must not be copied into reconstructed history. A new additive
migration should make the intended privileges explicit: browser deny for internal Builder V2
tables, service-role access for server paths, read-only authenticated access where the original
migrations intended it, and no public execution surface for the deployment helper.

There are no production-only or local-only application tables, columns, constraints, indexes,
functions, triggers, or policies. No historical migration needs editing.

Machine-readable evidence is in `catalog-diff.json`; the complete local and production catalog
snapshots are retained alongside it.
