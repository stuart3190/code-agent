# Package 10E canary recovery

Status: **HARD STOP — incomplete**

Date: 2026-08-08

## Approved boundary

The recovery canary was constrained to fixed disposable identities, the deployed Builder V2
database/runtime modules, one dark `proof_slow` worker job, and the C8 database RPC state machine.
The runner contains no provisiond, Caddy, Docker, child-process, or atomic-publisher import and
emits a JSONL checkpoint before each subsequent stage. It cannot enable customer V2 routing,
customer worker dispatch, customer atomic publishing, managed settlement, a provider, or Stripe.

The already-green C8 filesystem evidence remains authoritative at
`docs/evidence/atomic-publishing/2026-08-07/PROOF.md`. This recovery was not permitted to repeat or
manage that filesystem/ingress path.

## Local proof and commits

- `31cbded257f1cf9bec1c45e17d3b285b48f00bf5` — guarded incremental recovery runner and five static
  boundary tests.
- `b566d557a0935d6e1100165dfe7c6fcf847fb067` — sequential production baseline reads after the first
  managed PostgREST connection-acquisition failure.
- Focused result: 18 passed, 17 Linux-only filesystem tests skipped on Windows, zero failed.
- Recovery-guard result: 5/5 passed.
- Staged production runner SHA-256 for the second attempt:
  `68f63f377519547b9351715899b7dfe473fbae223cd5811d52f990dd1f2891b9`.

## Production attempts

Both attempts failed before creating Auth users, projects, runtime rows, worker jobs, releases, or
intents:

1. Attempt 1 failed while parallel baseline reads waited for a PostgREST connection.
2. Attempt 2 used sequential reads and failed on the first `projects` baseline read for the same
   reason.

Supabase API logs confirmed continuous unrelated 504 responses across shell background workers,
worker heartbeat, custom-domain reads, analytics, repository indexing, GitHub webhook claims and
conversation recovery. Worker logs show the dark worker has been unable to acquire a Data API
connection since 2026-08-08 13:19 UTC. Direct read-only catalog access remains available, but it is
not an acceptable substitute for a production-runtime canary.

No provisiond service was started or restarted. No Caddy command, Caddy read, or Caddy mutation was
performed. No model/provider or Stripe request occurred.

## Cleanup and parity

Read-only SQL after the hard stop proved:

- production migration ledger: 67;
- fixed canary Auth users/projects: 0/0;
- canary V2 builds/reservations/worker jobs/releases/intents: 0/0/0/0/0;
- production projects/build jobs/published sites/deployments: 11/31/1/5;
- AI requests/usage records: 188/284;
- enabled V2 flag rows/non-empty owner allowlists: 0/0.

The temporary VPS runner was removed. The failed-attempt evidence is read-only at
`/home/ubuntu/thrallo-deploy-evidence/package10e-canary-recovery-20260808`; its index SHA-256 is
`83e1efe749aed548396ea219f230f5e39162d97f8bab7bfa61f8cd8782c0e794`.

At final observation, `app.thrallo.com`, `thrallo.com`, and `buildr101.com` returned HTTP 200;
`thrallo-shell`, `thrallo-provisiond`, `buildr-provisiond`, and `thrallo-build-worker` were active.
`THRALLO_MANAGED_SETTLEMENT_PAUSED=1` remained configured and the customer worker/atomic flags
remained absent/off.

## Credential-handling incident

A diagnostic command incorrectly sourced the Node environment file as shell syntax. The command
failed, did not write repository or evidence files, and did not mutate production, but one service
credential appeared in captured command output. The value is intentionally not reproduced here.
Treat that credential as exposed and rotate it before another production canary. Update the shell
and dark-worker secret stores together, restart only those approved services, and prove old-key
rejection plus new-key health.

## Required recovery before retry

Package 10E remains incomplete. Before a third canary attempt:

1. rotate the exposed Supabase service credential and update its approved production consumers;
2. restore the Supabase Data API/PostgREST pool and prove sustained non-504 reads/RPCs;
3. determine why PostgREST sessions remained unavailable and record the corrective action;
4. re-run the fixed-ID zero-model recovery from a zero-residue preflight;
5. require the final incremental checkpoint, cleanup parity, safety flags and health proof.

Do not enable any Builder V2 customer path while this gate is incomplete.
