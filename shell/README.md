# Buildr101 — the product shell

The shell wraps the proven app-builder layers into the live loop a user can touch:
**describe → generate → preview → iterate**, plus auth, project persistence, and the billing UI.
It *wraps* proven code — it does not reimplement the engine, the backend SDK, `costModel`, the ledger,
or Stripe (see `../baseline/PHASE-5-SHELL.md`).

```
shell/
  server/   thin Node http server — the ONLY place secrets or the local engine live
  web/      Vite + React + Tailwind SPA — the builder UI
```

## What runs where
- **Engine + ledger debit + Stripe** run in `shell/server` on this VM (the engine needs `~/.codex`
  auth + `child_process` for builds; the browser never sees a secret).
- **Auth + project persistence** run **client-side** through the Phase 3 backend SDK, so Supabase RLS
  owner-scopes every read/write (the honest tenancy path).
- **Preview** is a seam: `PREVIEW_MODE=local` runs a real Vite dev server on this VM (real HMR); `vps`
  is the deferred container-provisioning stub.
- **Publish** is an explicit no-op stub (`web/src/publish/publishStub.js`) — its own future session.

## Run (dev)
1. `cp shell/.env.example shell/.env` and fill it (same Supabase project + Stripe **test** keys as the
   Phase 3/4 proofs). `cp shell/web/.env.example shell/web/.env` and fill the two `VITE_` browser keys.
2. Terminal A — server:  `cd shell && node server/index.mjs`  (→ http://localhost:8787)
3. Terminal B — web:     `cd shell/web && npm run dev`         (→ http://localhost:5173)
4. Open http://localhost:5173 — sign up, describe an app, Generate.

`/api/generate` is the only action that spends Codex quota; it fires only on the Generate/Apply click.

## The billing webhook (for real grants)
Tier/top-up **checkout** reaches Stripe test mode from the UI. To land the resulting **grant** in the
ledger, run the Stripe CLI against the server:
`stripe listen --forward-to localhost:8787/api/stripe/webhook` (set `STRIPE_WEBHOOK_SECRET` to the value
it prints). The webhook reuses the proven `handleStripeEvent`.

## Headless proof
`node shell/harness/prove-shell.mjs` drives the whole loop server-side with a real Supabase session
(sign up → generate → build → debit → iterate → reload/reopen), the same discipline as `proveBilling.mjs`.
Skips cleanly if creds are absent.
