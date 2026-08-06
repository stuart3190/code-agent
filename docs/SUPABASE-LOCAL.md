# Reproducible Supabase database

Thrallo pins Supabase CLI `2.111.0` in `devDependencies`. Production project
`zczgvcsokfafuyognvwx` is never linked by the commands in this repository. The active migration
directory mirrors the production migration ledger exactly; archived pre-reconciliation files live
outside that directory and are therefore never replayed by the CLI.

## Prerequisites

- Node.js 22 and `npm ci`.
- Docker Engine or Docker Desktop with at least 7 GB available memory.
- Ports 55320-55324 and 55327 available. These deliberately avoid Supabase's default ports so the
  proof stack cannot collide with another local project.
- No production database password, service-role key, access token, or linked-project metadata is
  needed for local reset, lint, diff, or migration listing.

## Deterministic commands

```text
npm run supabase:version
npm run supabase:start
npm run supabase:reset
npm run supabase:migrations
npm run supabase:lint
npm run supabase:diff
npm run supabase:stop
```

`supabase:reset` always includes `--local` and disables seeding. Never substitute `--linked`:
remote reset is destructive and is forbidden for production. The reset proof must begin from an
empty disposable database and apply every file under `supabase/migrations` without manual SQL.

Catalog comparison uses the read-only Supabase plugin for production and the local PostgreSQL
container for the disposable side. Production is never changed to make a diff disappear; genuine
untracked production objects become new additive reconciliation migrations after review.
