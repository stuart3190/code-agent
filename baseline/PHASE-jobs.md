# Background builds — server-side jobs + a coarse status stream

_Recorded 2026-07-20. Builds no longer live or die with the browser: a generate request creates a
detached server-side **job** that runs to completion regardless of what the client does, and the
client is a passive observer of a **coarse phase stream** (`queued → preparing → planning|building
→ finalizing → complete|failed|interrupted`). The `runTurn`/provider seam, the ledger/billing code,
the existing RLS policies, and provisiond are **untouched callers** — the engine loop was moved
verbatim, not reimplemented. No regression: billing 35/35, ledger 19/19, runagent 13/13, router
22/22, prove-shell green against the new job flow._

## Why

Two coupled problems, one fix:

1. **Builds died with the connection.** `handleGenerate` awaited `runAgent` inline in the HTTP
   handler and pushed progress by writing straight to `res`. There was **no** `req.on('close')` and
   **no** AbortController anywhere in the path, so when the browser navigated away or the socket
   dropped, the loop kept running while its writer wrote to a dead socket — and, critically, the
   built tree shipped **only** in the final `done` frame (the client saved it; the server persisted
   nothing). A dropped stream = a finished build lost, and on the managed lane the tokens were spent
   but **never debited** (the debit ran after the loop). "unknown error" in the UI was really the
   client throwing `"no result"` on a stream that ended with no `done`.
2. **The stream leaked internals.** Model names (`gpt-5.5`), tool calls (`read_file`,
   `apply_patch`), file paths (`src/App.jsx`), and token counts streamed straight to the browser and
   were rendered in the timeline, a raw-log panel, and a footer.

Both dissolve once the build is a detached job and the client only sees coarse phases.

## What shipped

```
migrations/build_jobs.sql          owner-read RLS, service-role writes, server_id column
shell/server/lib/buildJobs.mjs     the job runner + in-memory registry (mirrors preview's live Map)
shell/server/routes/generate.mjs   shrunk: validate + 402 gate + createJob -> 202 {jobId}
shell/server/routes/builds.mjs     GET :id/events (SSE) · GET projects/:id/active-build · POST :id/cancel
shell/server/index.mjs             the three job routes + a startup interrupted-sweep
shell/web/src/lib/api.js           createBuild / watchBuild / activeBuild / cancelBuild
shell/web/src/builder/Builder.jsx  phase chip, cancel, reattach-on-open, jobId-deduped save; leaks removed
shell/harness/prove-jobs.mjs       the live proof (npm run prove:jobs)
```

Run: `npm run prove:jobs` (needs `shell/.env` creds; spends Codex on ~1 full + 1 partial build + plans).

## Design (the load-bearing decisions)

- **Registry is the live source; Supabase is write-through.** A module-level `Map<jobId, job>`
  (modelled on `preview/index.mjs`'s `live` Map, which already survives request teardown) owns the
  running loop; every status/phase change is written through to `build_jobs`. The DB row is what a
  reattaching client reads, and what the restart sweep acts on.
- **Persistence stays split.** The server does **not** write the `projects` row — that stays the
  client's single RLS-scoped writer (`supabase.mjs` header rule; the client already rewrites
  `tree`+`prompts` on rename/knowledge/revert, so a second writer would race it). The job's terminal
  deliverable lives in `build_jobs.result` (jsonb) so a client that reattaches *after* completion can
  still apply-and-save it. History entries carry `jobId`, so "already applied" is distinguishable
  from "finished while I was away."
- **One translation point.** Coarse phases are set at the job-runner boundary; engine internals
  never enter the client stream **by construction** (they go to the server console/journal, prefixed
  `[job <id>]`, exactly as before). The client-frame contract is a whitelist:
  `{ jobId, projectId, mode, phase, status, error, result }` with
  `result ⊆ { finalText, tree, buildOk, previewUrl, need, balance }`. `build_stderr` is stored
  server-side only (it is full of file paths) — build-error "Fix it" sends `fixBuild:true` and the
  server composes the fix prompt from the stored stderr.
- **Concurrency: a single constant.** `MAX_CONCURRENT_BUILDS_PER_USER = 2` + a FIFO queue; excess
  jobs sit `queued`, not rejected. One active job per project (a second create returns the running
  one). Per-tier caps are seamed but out of scope (read the constant from the entitlement later).
- **Cancel with zero engine changes.** The runner's `log` callback (called by `runAgent` between and
  within turns, caller-side of the seam) throws `CancelledError` when the job's flag is set — a clean
  between-turn abort. A cancelled/failed loop skips `settle`, exactly like today's error path (the
  mid-flight provider tokens are forfeited undebited).
- **Restart sweep, scoped by `server_id`.** On startup, rows this server left `queued|running` are
  marked `interrupted` with an honest message. Scoped to our `SHELL_SERVER_ID` (or hostname) because
  **local dev and prod share one Supabase project** — an unscoped sweep would kill the other
  environment's running builds.
- **The missing disconnect handler.** The events SSE route attaches `res.on('close')` to detach the
  subscriber (never touching the job) — the exact handling whose absence used to kill builds — plus a
  15s comment-ping so Caddy doesn't idle the stream out between rare phase changes.

## Proof — `prove:jobs` 25/25 GREEN (live, real Codex spend)

Denial-shaped where it's security/correctness. The server journal during the full build was full of
`gpt-5.5`, `read_file`, `src/App.jsx`, and token counts — and the **leak gate confirmed all client
frames were clean**, proving the internals are *filtered at the boundary*, not merely absent.

- **DETACH** — a job with no subscriber ever attached ran to `complete`, persisted its result, and
  **debited exactly once** (denial of the disconnect revenue leak).
- **BUILD / REATTACH / LEAK GATE** — mid-build subscribe showed a live coarse phase; the stream
  ended with a terminal `complete` carrying a 27-file `buildOk:true` tree; **all client frames clean**
  (no model/tool/path/token leaks; keys within the whitelist); debited exactly once; re-subscribing a
  finished job returned the terminal snapshot + result and **closed with no hang**.
- **CONCURRENCY** — at creation, 2 running + 1 **queued** (cap held, excess queued not rejected); the
  queued job ran once a slot freed (FIFO drain).
- **ROUTING** — two concurrent jobs streamed with no cross-talk (each stream carried only its own
  `jobId`).
- **AUTHZ** — user B got `404` on A's events and cancel, and `0 rows` on an RLS-scoped read of A's
  job (server check + RLS, both).
- **SWEEP** — an own-server orphan read `interrupted` with the honest message; a foreign `server_id`
  row was left untouched.
- **CANCEL** — cancel between turns → `failed "Cancelled by user."`, no result delivered, **no debit**
  recorded for the cancelled build.

## Regression

`test:billing` 35/35 · `test:ledger` 19/19 · `_runagent-tests` 13/13 · `_router-tests` 22/22 ·
`prove-shell` GREEN (updated to drive the new `202 {jobId}` + events flow — the old harness drained
an SSE `done` frame the route no longer emits; telemetry/decision are gone from the client payload by
design, so debit-exactness is now checked by ledger balance delta here and independently in
`prove:jobs`). The web bundle builds clean.

## Out of scope (deferred)

Multi-server job handoff · retry/resume of interrupted builds · per-tier concurrency caps (the
constant is the seam) · plan-mode clarifying-question popups · the `gpt-5.6` model-string bump (a
separate 2-line change). A Projects-dropdown active-build indicator is a nice-to-have, not shipped.
