# Phase 3.1 — per-tenant data isolation (Supabase RLS)

_Recorded 2026-06-30 · backend: Supabase cloud (free tier) · no generation model needed (the
isolation proof exercises the SDK directly, no app generation)._

Phase 3.0 shipped the backend SDK but ran under ONE permissive policy — `authenticated` = full
access to the shared `entities` table and `uploads` bucket. That was enough to prove a single user
can round-trip data, but it meant **every user could read and write every other user's data**. 3.1
turns that into a real multi-tenant backend: owner-scoped RLS on `entities`, path-scoped RLS on a
**private** `uploads` bucket, and a proof that the isolation actually holds.

## Tenancy model

**`entities` — purely DB-side, ZERO SDK change.** The table owns `owner uuid not null default
auth.uid()`. The SDK inserts `{ type, data }` and never sets `owner`; the DB default stamps it with
the caller, and four owner-scoped policies (`owner = auth.uid()` on select/insert/update/delete)
confine every operation to the caller's rows. `.insert().select()` / `.update().select()` still
return the row because the caller owns it. Generated apps stay completely unaware of tenancy.

**`uploads` — private bucket + path-prefix RLS + signed URLs (one small SDK change).** Storage has
no app-controlled `owner` column we can default, so isolation is by **folder convention**: keys live
under `"<uid>/..."` and the policies enforce `(storage.foldername(name))[1] = auth.uid()::text`. The
bucket is **private**, so bytes are served only via short-lived signed URLs the owner mints. The SDK
changes are localized to `storage`:
- `upload()` prefixes the key with the caller's uid (read from the in-memory session — no extra
  network round-trip) and returns the full prefixed key. The app still passes its own logical path
  and stores the returned key opaquely, so it stays unaware of tenancy.
- `getUrl()` is now **async** and issues `createSignedUrl(path, 3600)`. This aligns with the SDK
  contract line that already said "All methods are async (await them)" — `getUrl` was the lone
  sync exception. The build prompt's SDK surface line was updated to match.

`auth` and `db` are untouched; `index.js` is untouched (async `getUrl` is transparent through it).

## The SQL (run in the Supabase dashboard)

```sql
-- ENTITIES — owner-scoped
alter table public.entities enable row level security;
alter table public.entities alter column owner set default auth.uid();
alter table public.entities alter column owner set not null;
drop policy if exists "authenticated full access" on public.entities;  -- drop the 3.0 permissive policy
create policy "entities_select_own" on public.entities for select to authenticated using (owner = auth.uid());
create policy "entities_insert_own" on public.entities for insert to authenticated with check (owner = auth.uid());
create policy "entities_update_own" on public.entities for update to authenticated using (owner = auth.uid()) with check (owner = auth.uid());
create policy "entities_delete_own" on public.entities for delete to authenticated using (owner = auth.uid());

-- STORAGE — private bucket + path-prefix (folder = uid)
update storage.buckets set public = false where id = 'uploads';
drop policy if exists "authenticated uploads access" on storage.objects;  -- drop the 3.0 permissive policy
create policy "uploads_select_own" on storage.objects for select to authenticated
  using (bucket_id = 'uploads' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "uploads_insert_own" on storage.objects for insert to authenticated
  with check (bucket_id = 'uploads' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "uploads_update_own" on storage.objects for update to authenticated
  using (bucket_id = 'uploads' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'uploads' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "uploads_delete_own" on storage.objects for delete to authenticated
  using (bucket_id = 'uploads' and (storage.foldername(name))[1] = auth.uid()::text);
```

> The 3.0 permissive policy names above are placeholders — discover the real ones with
> `select policyname from pg_policies where tablename in ('entities','objects');` and drop each.

## Proof: `harness/proveTenancy.mjs` — isolation, not just access

Two INDEPENDENT backend instances (= two independent auth sessions in one process), two users via
normal `signUp`/`signIn` (no `service_role`). A creates an entity + uploads a file; then every cross-
tenant access B can attempt is asserted to be denied. The denial IS the proof.

```
1. SETUP      two distinct authed users A, B
2. ACCESS (A's own use still works)
   PASS  A db.entity.create (owner = A)
   PASS  A list() / get() read its own note back
   PASS  A storage.upload (namespaced under A's uid)
   PASS  A signed-URL fetch-back bytes match
3. ISOLATE (denial = pass)
   PASS  B list() does NOT contain A's note
   PASS  B get(A's id) is blocked (no row)
   PASS  B cannot list A's storage folder
   PASS  B cannot download A's object
   PASS  B cannot mint a signed URL for A's object
4. IMMUTABLE (RLS denies silently -> verified by A re-reading)
   PASS  B update(A's id) affects 0 rows
   PASS  A's note title UNCHANGED after B's update attempt
   PASS  A's note STILL EXISTS after B's delete attempt
=> ALL GREEN — B reached none of A's data; A's own access works.
```

Run: `SUPABASE_URL=… SUPABASE_ANON_KEY=… node harness/proveTenancy.mjs` (anon key only). Without
creds it exits early — isolation is a live DB property with nothing to assert offline.

## The rule held: 3/3 regression unaffected

The async-`getUrl` SDK change and prompt tweak don't touch the client-only cases (they never import
the SDK; it tree-shakes out), so `node harness/run.mjs` stays **3/3 green**. `proveBackend.mjs` (the
3.0 single-user round-trip, now awaiting `getUrl`) re-runs green under the new owner-scoped policies,
confirming legitimate access wasn't broken.

## Secrets / spend

Anon public key + URL from env only; never logged or committed. **No `service_role` key** anywhere —
both users are created with the ordinary anon `signUp` flow. Codex unused (no generation); Supabase
free tier (two signups + a few small ops). Free-tier caveat: signups are rate-limited per IP/hour —
two is fine.

## Deferred (NOT built here)

This is **per-END-USER isolation within one app's data**. Isolating one **builder's** project from
another builder's project on the platform is a **different tenancy layer** — it belongs with the
persistent project-storage / orchestration backend (a later phase), not here. Don't conflate the two.
