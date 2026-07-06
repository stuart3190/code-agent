# PLAN — Per-app auth (fixes the shared login pool) — QUEUED, ready to run

**Decided 2026-07-06 with Stuart** (after he hit "already registered / invalid login" testing an
exported app with his own email — his Buildr101 account and every app's end-users share ONE
`auth.users` pool). Resolves the "open tension" from `DECISION-hosting.md` Decision 3.

## DECIDED — hybrid, two lanes (do NOT re-explore)

- **Default lane (free/hobby): per-app user pools INSIDE the shared project.** An `app_users`
  table + platform-minted scoped JWTs. Emails unique per (app_id, email), not globally. Marginal
  cost per app ≈ £0; platform upgrades to Supabase Pro ($25/mo flat, ALL apps) only at real scale.
- **Paid lane (agency clients): dedicated Supabase project per app**, provisioned via the
  Management API, injected through the existing backend-as-parameter seam (`withRuntimeEnv`) —
  different env values + republish, ZERO app-code changes. ~$10/mo per project, passed through to
  the paying client. Build this lane in its OWN later session.

## Key architecture facts (from the 2026-07-06 session — verified, not guesses)

- `withRuntimeEnv` (shell/server/lib/runtimeEnv.mjs) injects backend config at materialization
  ONLY (buildTree / preview / publish) — the seam both lanes plug into. Saved trees/exports clean.
- `entities` RLS is `owner = auth.uid()`; storage policies key on the uid path prefix — a minted
  JWT whose `sub` is the `app_users.id` uuid satisfies BOTH untouched.
- The SDK (`src/scaffolds/reactVite/lib/backend/`) is the swappable seam: only its `auth` surface
  changes; `db`/`storage`/generated apps untouched.
- **Published apps are static and CANNOT reach the shell server (it runs on Stuart's box).** The
  auth endpoints must live somewhere public → **Supabase Edge Functions on the shared project**
  (public URL, service-role available inside, free tier 500K invocations/mo; deployable via the
  Supabase MCP `deploy_edge_function`). This is the natural home — do NOT try to host auth in the
  shell.
- The Supabase MCP CAN apply DDL migrations directly (proven repeatedly this session).

## BUILD (stages, commit each on say-so)

1. **`app_users` table** (migration via MCP): `id uuid pk default gen_random_uuid(), app_id text
   not null, email citext not null, password_hash text not null, created_at`, `unique (app_id,
   email)`. RLS deny-all to clients (service-role/Edge-Function only — same custody as byok_keys).
2. **Edge Function `app-auth`** (signup / signin / reset-request / reset-confirm): bcrypt verify,
   mint JWT signed with the project JWT secret — claims `{ sub: app_users.id, role:
   "authenticated", app_id, email, exp }`. Basic rate limiting. NEW SECRET: the project's
   `SUPABASE_JWT_SECRET` lives only in Edge Function env (never the repo, never the client).
3. **SDK auth swap:** when `VITE_APP_ID` is set AND a new `VITE_AUTH_MODE=app` flag is injected,
   `auth.signUp/signIn/...` call the Edge Function instead of `supabase.auth`; the returned JWT is
   held in memory/localStorage and passed to the supabase-js client (accessToken option) so RLS
   sees the minted `sub`. No flag → exact current behavior (previews can keep shared auth until
   flipped; old apps unaffected).
4. **Reset emails:** provider = Resend free tier (3k/mo) or SES; token table + the Edge Function
   endpoints; prompt addendum telling generated apps the reset flow exists.
5. **Prove it:** publish two apps; sign up the SAME email on both (no collision, separate rows,
   separate data via app_id); cross-app JWT rejected; existing suites green (prove-shell 41/41,
   tenancy, billing/ledger). Flip the default for NEW publishes only.

## Constraints

- runTurn/provider seam untouched (nothing here goes near the engine).
- billing/ledger untouched; Buildr101 BUILDER accounts stay on Supabase auth exactly as today —
  this is only END-USER auth for generated/published apps.
- Backward compatible: apps built before the flag keep working against shared auth.
- Secret gate: JWT secret + email-provider key are new env custody items (Edge Function env +
  gitignored notes), never committed.

## Paid lane (separate session, after the default lane ships)

Management-API provisioning service: create project (needs a Supabase personal access token —
new secret from Stuart), run the entities/RLS migrations on it, store per-project backend config
on the `projects` row (`backend_url`, `backend_anon_key` columns), and let `withRuntimeEnv`
prefer per-project config over the shared env. Publish/preview pick it up automatically —
that's the whole point of backend-as-parameter.
