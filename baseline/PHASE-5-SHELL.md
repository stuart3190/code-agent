# Phase 5 (SHELL) — the product shell: describe → generate → preview → iterate, proven live

_Recorded 2026-07-01. Wraps the proven capability layers (engine, backend SDK, runtime, billing) into
a product a user can touch. WRAPS proven code — reimplements none of it: the engine, the backend SDK,
`costModel.mjs`, the ledger, and Stripe are imported, never edited. No regression: billing 35/35,
ledger 19/19 still green; the engine harness is untouched (this session never edits `src/engine`)._

## What shipped

```
shell/
  server/   thin Node http server (no framework) — the ONLY place secrets or the local engine live
    routes/generate.mjs   POST /api/generate (SSE) — the gated engine call + live ledger debit
    routes/{billing,stripeWebhook,preview}.mjs
    preview/index.mjs     PreviewProvider seam: localVite (REAL) | vpsProvision (STUB)
    lib/{env,supabase,services}.mjs
    index.mjs             router + CORS + /api/config (pricing straight from costModel)
  web/    Vite + React + Tailwind SPA
    auth (backend SDK) · projects dashboard (dedicated public.projects table) · builder loop (stream + preview
    iframe + iterate) · billing panel (balance meter, tiers, top-up, 3 modes) · publish stub
  harness/prove-shell.mjs  headless end-to-end proof (the browser's exact API calls, server-side)
```

Run: `cp shell/.env.example shell/.env` (+ `shell/web/.env`), fill creds, then
`cd shell && node server/index.mjs` and `cd shell/web && npm run dev` → http://localhost:5173.
The web bundle builds clean (`vite build`: 87 modules).

## Decisions (locked with the user)
1. **Stack:** Vite+React SPA + thin Node server. Engine runs on this VM (needs `~/.codex` + build
   `child_process`); the browser never sees a Codex/Stripe secret.
2. **Project persistence:** a **dedicated owner-scoped `public.projects` table**
   (`migrations/projects.sql`) — columns `id, owner, name, tree jsonb, history jsonb, preview_ref,
   created_at, updated_at`. RLS is modelled **exactly** on the proven Phase 3.1 `entities` policies
   (4 policies: select/insert/update/delete own, `owner = auth.uid()`), so a user's projects are
   owner-scoped and invisible to other tenants. The **tree is the durable session state** and
   `history` carries the turn log; feeding the saved tree back into `runAgent` is what makes edits
   hold across reload. Reads/writes go through the user's own Supabase session (RLS-enforced), the
   honest Phase 3 path.
3. **Preview:** a seam. `local` runs a REAL Vite dev server on this VM (genuine HMR); `vps` is the
   clearly-marked no-op stub for the deferred RUNTIME.md container/nginx-HMR provisioner.
4. **Publish:** explicit no-op stub (`web/src/publish/publishStub.js`) — its own future session.

## The reuse discipline held
- Generation: `runAgent` + `createRoutingProvider({provider:"codex",strong:"gpt-5.5"})` (single-model
  pass-through = the free ChatGPT-sub lane) + `BUILD_SYSTEM_PROMPT` / `systemPromptForEdit("apply_patch")`
  + the reactVite scaffold + `buildTree` (same build bar as the 3/3 harness).
- Billing: `createLedger`/`createBilling` over the service-role client; debit uses `creditsForTurn`
  (model-weighted) — no price/weight re-derived. `/api/config` surfaces `TIERS`/floor from costModel.
- Auth: the Phase 3 backend SDK (`createSupabaseBackend`) client-side. Persistence: the dedicated
  `projects` table written through the SDK's user session, so Supabase RLS owner-scopes every project
  read/write. Balance is read client-side via `createLedger(userClient)` (RLS `select_own`).

## Live proof — `node shell/harness/prove-shell.mjs` → **17 passed, 0 failed**
Real run (Supabase `qgemqjcyhuejrsvjxkbh`, engine on the Codex free lane, preview local Vite):

| step | evidence |
|---|---|
| SIGNUP | real user `627dcd56…` via the backend SDK anon flow; access token established |
| SEED | Starter bundle granted (service role) → balance **120 cr** (stands in for the Stripe grant, whose own path is proven in PHASE-4-LIVE) |
| GENERATE | described a notes app → engine built an **11-file app that `npm run build` PASSES** |
| DEBIT | **1.6827 cr for 16827 tok on gpt-5.5** = `creditsForTurn` exactly; balance **120 → 118.317** (dropped by exactly the debit) |
| PREVIEW | returned URL `http://localhost:5200/` serves the running app — **HTTP 200** |
| PERSIST | project saved `25710f0f…` into the dedicated **`public.projects`** table (RLS-scoped, user session) |
| ITERATE | "add a search box" → **still builds**, tree **actually changed**, debit **1.2488 cr** (= creditsForTurn) |
| RELOAD | reopened through a FRESH session → tree **intact and equal to the iterated tree** (edits held); prompt history **2 turns** intact |
| ISOLATE | a second user reads **0** of user A's projects on the `projects` table — owner-scoped RLS; denial = pass |
| CLEANUP | the project row deleted through user A's own session (`delete_own`) → `projects` table back to 0 rows |

(Debit credits vary run-to-run with the nondeterministic token count; each is asserted equal to
`creditsForTurn({tokens, model})`, not to a fixed number.)

## Cost discipline
`/api/generate` is the only Codex-spending action and fires only on an explicit click. Plan-mode and
all UI/build work cost £0. The proof spends the quota deliberately (2 generations/run).

## Explicitly deferred (flagged, not built)
- **Real VPS preview provisioning** (container + nginx-HMR subdomain from RUNTIME.md). The seam is
  ready (`PREVIEW_MODE=vps` → stub); wiring the provisioning service is its own session.
- **Publish / deploy** — no-op stub only; deploy target is an open decision.
- **Stripe checkout UI end-to-end** needs `STRIPE_PRICE_*` (absent from the local key file); the server
  route + reused webhook handler are in place, checkout was not exercised this run. The billing UI reads
  the LIVE balance and lists tiers/top-up priced from costModel.
- Revision history / undo, streaming provider-fallback, custom domains.

## Files: new under `shell/` + `migrations/projects.sql` (+ one `.gitignore` line).
Imported-never-edited: `src/engine/*`, `src/providers/*`, `src/prompts/*`, `src/scaffolds/*`,
`src/billing/*`, `harness/workspace.mjs`.
