# SEC-20260808-PACKAGE10E-SUPABASE

Status: contained credential; Data API blocker remains open  
Severity: high  
Detected: 2026-08-08  
Production project: `zczgvcsokfafuyognvwx`

## Credential incident

A Supabase new-format secret key used by `thrallo-shell` and `thrallo-build-worker` was exposed in
privileged diagnostic tool output. The value is intentionally absent from this record. Its stable
identity was API-key id `a2dae86d-2da2-49db-8869-44c363765323`; its SHA-256 was
`364c32a12f17737e1f9786789deafed72a2824c0238dabd69f906f21349e7b9a`.

The credential existed in the two approved active stores and four unsafe plaintext backup/transient
files. A content-addressed scan found no copy in the repository, Git history, application database
diagnostics, worker journal, current journal, evidence archives, shell history, or the scanned
temporary/log paths. The two logs skipped by the original size-bounded scan were subsequently
streamed in full and contained zero matches.

Containment actions:

- Created one replacement Supabase secret key through the supported Management API.
- Atomically replaced only `SUPABASE_SERVICE_ROLE_KEY` in
  `/home/ubuntu/code-agent/shell/.env` and `/etc/thrallo/build-worker.env`, retaining the existing
  owner/group/mode.
- Restarted only `thrallo-shell` and `thrallo-build-worker`.
- Proved the replacement returned HTTP 200, revoked the exposed key as compromised, and proved the
  revoked key returned HTTP 401 while the replacement continued returning HTTP 200.
- CAS-verified and removed exactly four plaintext backup/transient files. Hash-only evidence is at
  `/home/ubuntu/thrallo-deploy-evidence/package10e-infrastructure-recovery-20260808/credential-containment.json`
  (SHA-256 `16a9834085b93212979e5f5a1a09edc52e123469090d87f33a24b6fb0c0b4914`).

During investigation, Supabase CLI `projects api-keys --output json` revealed legacy project keys
even without an explicit reveal flag. Its output was not persisted into repository or VPS evidence,
and this command is prohibited for future diagnostic use. The legacy service-role key was not
disabled in this incident because production Edge Functions consume the platform-provided
`SUPABASE_SERVICE_ROLE_KEY`; changing those unrelated consumers was outside the approved scope and
requires a separately planned migration and proof.

## Data API incident

The production database itself was not saturated: it had 21-23 of 60 connections, no blocked
sessions, no lock waiters, and no long-running application query. Ten PostgREST connections were
observed idle in transaction/aborted while shell and worker retry loops were receiving 504s.
Stopping only shell and worker did not drain the pool. Terminating nine stale PostgREST backends
restored access immediately; no database row or configuration setting changed.

The recovered service passed 150 mixed table/RPC probes over 73 seconds with zero errors and zero
pool timeouts (p50 67.23 ms, p95 99.93 ms, max 218.61 ms). The failure nevertheless recurred
deterministically in the Package 10E C8 negative-CAS proof. The historical API log records:

- `POST /rest/v1/rpc/request_publish_activation` -> 200 at `2026-08-08T16:11:07.180Z`.
- The immediately following stale-version request -> 504 at `2026-08-08T16:11:07.665Z`.

The RPC raises SQLSTATE `40001` for an expected business CAS conflict. `40001` is the reserved
serialization-failure code; through PostgREST this path exhausted/wedged the internal pool and
returned a 504 rather than the intended conflict. The canary runner formerly accepted any error as
a stale-CAS success. It now requires code `40001` plus the exact stale-version message, so the 504
fails closed.

## Impact and disposition

No customer data changed. Both failed canaries completed cleanup and reproduced the eight baseline
customer hashes. Builder V1 remained the only customer builder; V2 flags, customer worker dispatch,
atomic customer publishing, and managed settlement remained off/paused. No model or Stripe call
occurred. Provisiond and Caddy were not touched.

Package 10E is **FAIL**. A new additive forward repair must replace the business-conflict SQLSTATE
with a non-retryable application error, preserve CAS semantics, and re-run the sustained Data API
and full fixed-ID canary proofs. No V2 traffic or later finish-plan package may start first.

