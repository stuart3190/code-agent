# DIAGNOSE — per-app backend: why first-build backend apps fail

_Written 2026-07-20, before any code (GATE 1). Live repro: a generated barber booking site
("Q Barber Shop") renders its static hero but its shop-data card throws "Something went wrong —
the shop data could not be loaded." A prior tracker instead fell silently to "demo mode (saved on
this device)." Same root cause, two faces._

## Headline finding — the plan's premise is half-right, and the wrong half matters

The plan hypothesised the per-app backend **"isn't wired into the preview container."** It is. The
barber site's *other* error — `new row violates row-level security policy for table "entities"` — is
a **real Supabase error returned by the live project**. You only get that if the client is
constructed with a valid URL + anon key and is actually talking to the database. So config injection
works end to end. The failure is **not missing config** — it is **missing an authenticated session**
plus a **content-model mismatch**.

## How config reaches the app today (verified, works)

1. `shell/server/lib/runtimeEnv.mjs` `withRuntimeEnv(tree, projectId)` injects a `.env` at
   materialization time (build check / preview start / preview update — called in
   `buildJobs.mjs` runJob):
   `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_APP_ID=<projectId>`,
   `VITE_AUTH_URL=<url>/functions/v1/app-auth`. Never written to the durable `projects.tree`, never
   in export ZIPs — backend-as-parameter intact.
2. The preview provider forwards the **whole** tree (including `.env`) to the target:
   `localVite` writes every file (no dotfile filter, `preview/index.mjs:63`); `vpsProvision` POSTs
   the full tree to provisiond. Vite loads `.env` (`VITE_*`) automatically.
3. `src/scaffolds/reactVite/lib/backend/index.js` reads `import.meta.env.VITE_*` and constructs the
   SDK via `createSupabaseBackend({ url, anonKey, appId, authUrl })`. If env is absent it falls to
   `unconfigured()` (every call throws a clear config error) — **but that is not what happened here**
   (the app got a live RLS error, not the config error).

**Conclusion:** BUILD step 1 ("thread backend config into the container") is already satisfied.

## Where the read actually fails

`entities` schema (confirmed via the live DB):
`id uuid`, `type text`, `data jsonb`, **`owner uuid NOT NULL default auth.uid()`**, `created_at`,
`app_id text`. RLS is owner-scoped (`owner = auth.uid()`), unchanged since Phase 3.1.

The generated data layer (`supabaseBackend.js`) is correct **for a signed-in user**:
- `db.entity(type).create(data)` inserts `{ type, data, app_id }` and lets the column default set
  `owner = auth.uid()`. `list()`/`get()` filter by `app_id` + `type` and RLS restricts to the caller.

The barber app broke because it touched the backend **with no app-user session**:
- **Anonymous read** (shop-data card on mount): RLS `owner = auth.uid()` with `auth.uid()` NULL →
  the SELECT matches **zero rows**. The app treated "no rows" as failure and threw the fatal card.
- **Anonymous write** (saving shop config): `auth.uid()` is NULL → the `owner` default is NULL →
  the INSERT's `WITH CHECK (owner = auth.uid())` fails → `new row violates row-level security policy`.

`proveBackend`/`proveTenancy` pass precisely because they **sign in first** — the exact step a
first-load visitor hasn't done.

## Why it's inconsistent (barber hard-error vs tracker demo-mode vs RBLX-Forge success)

Nothing structural differs in the wiring — the difference is entirely in the **generated app's
own error handling**, which the prompt does not constrain:
- RBLX-Forge worked because its flow signed the user in before any data op.
- The tracker wrapped its read in a `catch` that fell back to `localStorage` → silent "demo mode".
- The barber let the read throw into an error boundary → fatal card.

The current prompt (`src/prompts/builder.mjs`) actively tells the model *"the backend IS live … do
NOT build demo-mode / localStorage fallbacks"* but never tells it: (a) backend rows are
**per-signed-in-user** and reads/writes require a session; (b) **public site content** (a business's
name, services, hours, gallery) is **not per-user data** and must not be stored/read through the
owner-scoped `db.entity`; (c) a read failure or empty result must render a **seed/empty state, never
a fatal card**. So each build improvises differently — that non-uniformity *is* the bug.

## The content-model mismatch (the real design gap)

There is exactly one data home — `entities`, owner-scoped. A barber site has two very different data
needs the model conflated:
- **App-public content** every visitor sees (shop name, services, opening hours). This has no
  per-visitor "owner" and should render for a signed-out visitor. Putting it in owner-scoped
  `db.entity` guarantees an empty/blocked read for anyone not signed in as its author.
- **User-owned records** (a customer's bookings). These are correctly owner-scoped and require
  sign-in — and they work today once authed.

RLS policies are inviolable (constraint), and a shared-project public-read policy would weaken the
tenancy guarantee, so the fix must **keep public content out of the owner-scoped store**, not
broaden RLS.

## Smallest wiring that fixes it (no inviolable seam touched)

Config already arrives, RLS is correct, the SDK is correct — so the fix is **not** more
infrastructure. It is making the **generated app** behave uniformly, which is shaped by the one
caller-side lever the constraints leave open: the **builder prompt** (`src/prompts/builder.mjs`,
where the Design/Photography guidance already lives — not the `runTurn` seam). Harden the backend
block so every generated app:

1. Renders **app-public content as in-code seed constants** and shows it immediately — never fetches
   site content (name/services/hours/menu/gallery) from `db.entity`.
2. Uses `db.entity` **only for genuinely user-owned dynamic records** (bookings, the user's own
   items) and **gates those behind `await auth.currentUser()`** — prompting sign-in when signed out.
3. **Never lets a backend read failure or empty result render a fatal screen** — wrap reads so they
   degrade to a seed/empty state (this is the uniform-error-handling fix; demo-mode/localStorage is
   still not the answer — a clean empty/seed UI is).
4. First render must work for a **signed-out visitor with zero rows**, zero iterate turns.

Optionally, a tiny SDK ergonomic (`auth.currentUser()` is already there; no new surface strictly
needed) — the behavior change is the prompt.

BUILD steps 2 & 4 (SDK inits from injected config; writes round-trip under `app_id`) are already
proven by `proveBackend`/`proveTenancy`; the net-new work is steps 3 + first-build-render, delivered
through the prompt. Proof: a generated barber-style site, built and loaded **as an anonymous
visitor**, renders its shop content with no fatal card and no demo-mode banner — added as a
first-build-render assertion to `proveBackend`.
