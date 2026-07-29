# Phase 3.0 — thin backend SDK (auth / entities / storage) on Supabase

_Recorded 2026-06-29 · generation model `gpt-5.5` (Codex, free on the sub) · backend: Supabase cloud (free tier)._

The generated apps stopped being static. They now target a **thin backend SDK** —
`import { auth, db, storage } from "./lib/backend"` — and never touch Supabase directly. The
SDK is a swappable seam (same pattern as the provider seam): Supabase is one implementation
behind `createSupabaseBackend({ url, anonKey })`; a self-hosted Supabase or own-Postgres backend
satisfies the same shape with no generated-app changes.

## The SDK surface (small + stable)

```
auth.signUp({email,password})  auth.signIn({email,password})  auth.signOut()  auth.currentUser() -> user|null
db.entity("<type>").create(data) | .list() | .get(id) | .update(id,patch) | .delete(id)   // record = {id,type,data,owner,created_at}
storage.upload(file, path?) -> {path}   storage.getUrl(path) -> public URL
```

Data model is migration-free: ONE generic `entities(id, type, data jsonb, owner, created_at)`
table, so `db.entity("note")` / `db.entity("task")` need no per-app schema.

## The rule held: 3/3 regression unaffected

Adding `@supabase/supabase-js` to the scaffold + the SDK files + rewriting the build/edit prompts
to the SDK contract did **not** regress the committed harness: **3/3 green**, £-if-metered/turn
**£0.0052** (baseline £0.0051). The existing client-only cases don't import the SDK, so it tree-shakes
out of their builds. (`node harness/run.mjs`.)

## Proof: a generated app worked against LIVE Supabase (not just `npm run build`)

`harness/proveBackend.mjs` (opt-in, creds-required, kept out of `CASES`): generate a Notes app from
ONE prompt → build → assert the source wires all three surfaces → then exercise the generated app's
**own** backend factory against the live project. The build-only harness can't prove backend
interaction, so the live step round-trips real data:

```
1. GENERATE  Notes app, one prompt, Codex     5 turns · ~17.6k tok (free)
2. BUILD     npm run build                     PASS
3. MARKERS   auth.signUp · auth.signIn · db.entity · storage.upload   all PASS
4. LIVE      against project qgemqjcyhuejrsvjxkbh:
   PASS  auth.signUp / signIn / currentUser (matched)
   PASS  db.entity.create -> id 760958c5-…              (row created)
   PASS  db.entity.list read-back                       (row read back = data landed)
   PASS  storage.upload -> proof/…​.txt
   PASS  storage.getUrl -> https://…/object/public/uploads/proof/…​.txt
   PASS  storage fetch-back bytes match (25b)           (object round-tripped)
   => ALL GREEN
```

The live step uses the **pure** factory (`createSupabaseBackend({url,anonKey})`) with creds from
`process.env` — the exact code path the app ships, env-wired for Node instead of Vite. Its bare
`@supabase/supabase-js` import resolves from the work dir's junctioned `node_modules`.

## Scope (single-tenant proof — explicitly deferred)

Per-user / per-project tenancy and RLS **isolation** are NOT built here. The project uses one
permissive policy (authenticated = full access to the one table/bucket) — the minimum for the
anon/authenticated role to touch anything, not tenant scoping. Multi-tenant isolation, multiple
entity tables, email/verification flows, and the runtime/preview + orchestration backend remain
later sessions.

## Secrets

URL + anon key are read from env only (`SUPABASE_URL` / `SUPABASE_ANON_KEY` for the Node proof;
`VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` for the app). Never logged, written to disk, or
committed; `.env`/`*.key` are gitignored. The anon key is the public browser key by design — the
`service_role` / `sb_secret_` key is never used in the app or the proof.

## One-time Supabase project setup the proof needs

- Auth → Email: enable signups, **disable "Confirm email"** (so signUp→signIn is immediate).
- `create table public.entities (...)` + enable RLS + one `authenticated` full-access policy.
- Storage: public bucket `uploads` + an `authenticated` policy on `storage.objects` for it.

## Caveats

- **Single-pass.** The generation model is nondeterministic; this is one generation + one live run.
- **Coarse marker check** on the generated source (presence of the three SDK calls) + a real build,
  same bar as the regression harness; the live round-trip is the semantic proof.
