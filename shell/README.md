# Thrallo product shell

The shell owns Thrallo's authenticated conversation, project, billing, diagnostics and deployment
APIs. Generated-app execution belongs to the durable build worker; production publishing belongs
to the immutable C8 release state machine.

```text
shell/
  server/   thin Node HTTP control plane; secrets remain server-side
  web/      Vite, React and Tailwind product UI
```

## What runs where

- The HTTP process authenticates, enqueues and streams status. It must not install dependencies,
  compile generated apps, run browsers or optimise images.
- The build worker owns all generated-app execution and enforces the C7 sandbox limits.
- Auth and project data use the Supabase-backed owner-isolated services.
- Builder V2 preview requires the VPS provisioner and a byte-verified green snapshot.
- Builder V2 publish and rollback activate retained immutable C8 releases and never rebuild.

## Run locally

1. Copy `shell/.env.example` to `shell/.env` and configure a non-production environment.
2. Start the server with `cd shell && node server/index.mjs`.
3. Start the UI with `cd shell/web && npm run dev`.
4. Open `http://localhost:5173` and use the conversation surface.

The retired direct `/api/generate`, `/api/preview` and `/api/publish` handlers are not mounted.
Historical `shell/harness/prove-*.mjs` files target those retired endpoints and remain forensic
fixtures, not the current production API contract.

## Proof

Run `npm run test:bv2:qualification` for the zero-credit deterministic Builder V2 matrix. A live
model quality benchmark or production mutation always requires its own approval.
