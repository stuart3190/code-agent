# Builder V2 production remediation

This is the live implementation ledger for the approved Builder V2 production remediation
programme. It records what the repository and production evidence prove; an unchecked item is not
silently treated as complete.

## Safety baseline

- Audited/current `origin/main`: `92e4c9fe5c864799eee228f304849064bacb0190`.
- Implementation branch: `remediation/builder-v2-production`.
- Customer Builder V2 rollout remains paused. Builder V1 remains the customer default.
- `THRALLO_MANAGED_SETTLEMENT_PAUSED=1` is a mandatory release invariant.
- `THRALLO_BV2_KILL=1`, `bv2.enabled=false`, and an empty `bv2.owners` allowlist are mandatory
  until the internal-pilot gate is explicitly approved.
- No model-powered proof, provider spend, Stripe action, production mutation, or migration is
  authorised by repository work alone.
- The shadow period that began on 2026-08-06 is diagnostic history, not valid rollout evidence.
  Its clock restarts only after atomic graph persistence and complete drift validation are live.

Run the network-free local evidence capture with:

```text
npm run audit:remediation-baseline
```

The optional flag read is deliberately double-gated and remains read-only:

```text
THRALLO_BASELINE_READ_APPROVED=1 node ops/capture-remediation-baseline.mjs --live-read
```

Never paste the resulting service environment or credentials into this document. The report emits
only interpreted booleans/counts for rollout controls and never emits owner ids or raw environment
values.

## PR ledger

| PR | State | Evidence | Production action |
|---|---|---|---|
| PR-01 Freeze and current-state baseline | Local implementation complete | Current main matched; local capture, 5 focused tests, full code-agent suite, web build, and 118 browser tests pass | Live read awaiting explicit approval |
| PR-02 Reproducible Supabase history | Pending | Duplicate versions `20260801200000` and `20260801220000` are detected by PR-01 | No history repair or migration run |
| PR-03 Essential verdicts and cache | Local implementation complete | C2/C3 focused proofs, all 107 Builder V2 tests, and all 1,172 code-agent tests pass | None; deploy only after normal review |
| PR-04 Atomic graph and shadow | Deployed dark and production-canary green | Atomic production persistence/reload parity was exact across 45 paths, 144 symbols, 477 refs and 124 edges; injected child-row drift exited non-zero and cleanup restored zero canary rows | Ready for a new shadow clock; customer V2 remains paused |
| PR-05 Immutable snapshots | Local implementation complete | Stored-byte corruption, materialisation, concurrent promotion, memory/Supabase parity, and Builder V2 regressions pass | None; deploy only after normal review |
| PR-06 App eligibility/reset | Local implementation complete | UUID registry, origin policy, HMAC, atomic reset-claim, Deno check, and all 1,179 code-agent tests pass | Edge deploy and secret require explicit approval |
| PR-07 Assets | Local security/compliance unit complete; worker isolation pending PR-11 | H5/H6 hostile fetch, MIME/size/dimension, immutable replacement and licensing proofs; all 1,182 code-agent tests pass | None; deploy only with the later isolated worker boundary |
| PR-08 Diagnostics/erasure | Diagnostics redaction unit local-complete; full cross-store erasure pending | Secret-pattern/environment redaction and prompt/source retention controls proven; erasure proof still pending | None |
| PR-09 Shared limits | Pending | Audit evidence confirmed | None |
| PR-10 Durable build leases | Installed dark; customer dispatch off | Atomic race, expiry/reclaim, cancellation race, idempotent completion, owner isolation and restart durability pass | Queue is durable; no customer dispatch |
| PR-11 Build worker | Deployed dark and production-canary green | Synthetic success, SIGKILL/lease recovery, zero duplicate results/orphan containers, responsive shell, and post-layout synthetic job pass | Service active dark; shell worker flag remains off |
| PR-12 Atomic deployment | Deployed dark and production-canary green | Real immutable A/B activation, no-build rollback, unpublish/republish, CAS and post-pointer fault reconciliation pass; test state fully removed | Atomic publish flag off; shared Caddy unchanged |
| PR-13 Cost/retrieval | Retrieval correctness local-complete; cost reservation pending | TS/TSX parser, opaque-context fail-closed, capability and project-knowledge integration proven | None |
| PR-14 V2 composition | Pending | Placeholder confirmed | None |
| PR-15 Operational surfaces | Pending | Audit evidence confirmed | None |
| PR-16 Release pipeline | Pending | Audit evidence confirmed | None |
| PR-17 DR/SLO/final proof | Post-deploy backup/restore gate green; broader DR/SLO work pending | Backup `thrallo-2026-08-07T201226` and network-isolated restore match all canonical rows/objects/files/modes; worker artifact root restored exactly | Shadow restart awaits explicit approval; off-host/RTO/RPO work remains |

## Evidence still requiring approved production read access

- Deployed commit and immutable artifact identifiers.
- Active release pointers and retained V1 rollback artifact.
- Redacted live values of settlement pause, V2 kill, enabled, owner allowlist count, and shadow.
- Remote migration-history mapping and actual schema checksum.
- Running service and worker versions.
- Latest complete backup timestamp and validated age.

PR-02 must not guess any of these values. In particular, duplicate local migration filenames must
not be renamed or repaired remotely until the real `supabase_migrations.schema_migrations` history
and corresponding live objects have been compared.

## 2026-08-07 dark-deployment and backup gate

- Production code is dark at `4fa3087f8e53a4cd63dd8e4b605c5d8725a05bff`; the worker itself reports
  `7d4ce3a464c20dcd99f3610e6f93d2dd47f2c522-dark` because the later commits change only backup
  evidence/tool permissions. Builder V1, disabled customer-worker/atomic-publish flags, paused
  settlement and unchanged shared Caddy remain hard invariants.
- The worker account home moved from the canonical artifact root to
  `/var/lib/thrallo-build-worker-home` (`0700`). `/var/lib/thrallo-build-worker` remains `0750`
  and contains only intentional durable Thrallo artifacts. The backup still rejects every symlink;
  it records and restores directory modes as well as regular-file bytes/modes.
- The first post-repair backup exposed stale 60-row migration evidence and was quarantined rather
  than accepted. Read-only Supabase evidence now overlays the immutable 60-row reconstruction
  through production row 65 with zero pending local migrations.
- Final backup `/home/ubuntu/thrallo-backups/thrallo-2026-08-07T201226` contains 82 application
  tables / 36,862 table rows, 31 auth identities, 2 Storage objects, 163 filesystem files and 46
  directory records. Manifest SHA-256 is
  `703c984882963e360f21faff71365f98c14864cb5005e4e667c47f6eb7f9efd0`.
- The isolated restore passed byte/hash/mode, snapshot materialisation, blob declarations,
  pointers/cache, graph/shadow, queue/result/event, publishing and two-owner isolation checks.
  Independent monitoring recorded zero successful connections on all ports `55320-55327` during
  the full restore. The disposable containers, volumes and restored filesystem were destroyed.
- Every technical shadow-restart criterion is now green. The seven-day clock has **not** been
  restarted; that remains a separate explicit approval. The remaining real hostname/certificate
  Caddy canary is independent and still requires its separately approved ingress window.

## Implemented correctness units

- C7 now uses an additive service-only durable queue with leased, retryable and idempotent jobs.
  `build_jobs` remains the customer lifecycle record and links to the currently active worker job;
  payload, result and event evidence survive shell/worker restarts. Completion persists its result
  before acknowledgement in the same transaction, and a completion racing cancellation is
  rejected. Atomic `SKIP LOCKED` leasing and lease tokens prevent two workers from owning a job.
- The opt-in `thrallo-build-worker` process owns generated-app dependency installation, compilation,
  Playwright verification, QA, publish packaging, Android packaging and Sharp optimisation. Leaf
  generated-code work runs in one-job Docker sandboxes with read-only roots, dropped capabilities,
  no-new-privileges, network denial where possible, bounded output, wall/CPU/memory/PID limits and
  process-tree cleanup. The shell flag defaults off, preserving Builder V1 behavior until approved.
- The actual sandbox image built successfully and compiled a real scaffold; a malformed project
  preserved exact stderr/exit 23 without killing the supervisor, timeout removed the complete
  container tree, and the 256 MiB memory proof exited 137. Disposable Postgres reset/lint/diff and
  queue race/recovery proofs are green. See `docs/evidence/build-worker/2026-08-06/PROOF.md`.
- C8 is now locally implemented behind an independent default-off flag. Worker/package output is
  finalised into byte-hashed read-only release directories; a versioned Postgres activation intent
  and atomic site pointer make crashes replayable. Rollback activates retained bytes without a
  build. Existing mutable live directories require the documented byte-identical adoption and Caddy
  cutover before the flag can be enabled. See `docs/ATOMIC-PUBLISHING-ARCHITECTURE.md` and
  `docs/evidence/atomic-publishing/2026-08-07/PROOF.md`. The worker's trusted control process currently needs Docker-group access; customer
  code never receives the socket, and rootless Docker remains the preferred host hardening before
  broader untrusted workload rollout.

- Atomic graph persistence is implemented by the pending additive migration
  `20260806221153_bv2_atomic_graph_and_full_shadow.sql`. One service-only RPC transaction owns the
  revision, symbols, references, edges, readiness/count metadata and immutable graph hash.
  Transaction-scoped advisory locking serializes identical revisions; retries repair quarantined
  incomplete rows and reject conflicting ready graphs. Composite project/owner/revision foreign
  keys prevent tenant mixing, while authenticated/anonymous roles have no table or RPC access.
- Shadow results now pin an exact revision manifest and append every validation check. CLEAN means
  exact equivalence across paths, hashes, opaque state, symbols/spans/hashes/metadata, references,
  edges, callers/importers/imports and ownership answers. Missing, extra, incomplete, corrupt or
  stale evidence exits non-zero. The old shadow week remains invalid and has not been restarted.
- Fresh reset, lint, migration history and zero-diff checks passed on a disposable Supabase stack.
  Real Postgres fault triggers proved rollback at all four write stages, safe retry, concurrent
  convergence, tenant/browser isolation and snapshot/shadow-aware GC. See
  `docs/evidence/builder-v2-graph/2026-08-06/PROOF.md`.

- `a5be84a` keeps unattributed essential failures blocking, records
  `journey_ownership_missing` separately, and supplies repair with deterministic bounded fallback
  context. The production orchestrator now uses the attribution result instead of bypassing it.
- Differential cache identity now includes the journey definition, full contract, verifier
  version, owner contents, transitive dependency contents, capability versions, generated
  backend/runtime contents and explicit environment/config versions. Zero-owner journeys are
  never cached. Every reuse carries its original verdict/evidence snapshot and a reason.
- Cache rows expire after 30 days by default; project/journey invalidation and retention pruning
  are explicit operations in both the memory and Supabase adapters. The existing
  `owners_hash` column stores the composite content-addressed key, so this safety fix adds no
  migration before PR-02 repairs migration history.
- Snapshot creation and materialisation now hash the bytes read back from storage, manifests are
  immutable, and ready finalisation is a conditional building-to-ready transition. Promotion
  byte-verifies the target immediately before activation and uses compare-and-set pointer updates;
  concurrent promotions cannot silently overwrite one another. Corrupt snapshots are marked
  `corrupt` and cannot become green, preview or published.
- Generated-app auth now accepts only a real `projects.id` UUID and an origin matching that
  project's active preview, live published site or verified custom domain. Reset codes use HMAC
  with the dedicated `APP_AUTH_RESET_PEPPER` Edge Function secret. Attempt consumption is a
  compare-and-set; a correct code is marked used before the password mutation, so parallel reset
  confirmations have one winner. The Edge Function must not be deployed until the pepper has
  been created and a rollback deployment is retained.
- Asset ingestion now accepts only allowlisted HTTPS origins, checks every DNS answer and
  redirect, enforces a ten-second timeout and 15 MiB body ceiling, verifies declared MIME against
  raster signatures, and applies Sharp channel, dimension, pixel and decode limits. Rejected
  bytes persist no remote row and fall back visibly to a generated placeholder. Sharp is pinned
  to `0.35.3`; the production dependency audit reports zero vulnerabilities.
- Responsive variants use output-byte hashes in immutable object names with overwrites disabled.
  Regeneration completes validation/transformation before atomically updating the existing slot
  row, so replacement failure leaves the active asset unchanged. CPU/memory process isolation is
  deliberately not faked here: Sharp must move behind PR-11's real worker boundary before H5 is
  closed and customer V2 builds are enabled.
- Pexels-specific API rules remain inside the provider adapter. Photographer, photographer-page,
  photo-page and provider metadata are persisted with the dated licence snapshot, exposed through
  `ASSET_CREDITS`, and enforced by a deterministic orchestration lint requiring generated UI to
  consume the credits, link Pexels, and link photographer credit to `photoUrl`.
- Diagnostics redact bearer credentials, API keys, common provider tokens, JWTs, private keys,
  credential-bearing URLs, sensitive fields, and configured secret environment values before
  any run, step, plan, contract, compressed output or request-context write. The raw value is not
  recoverable from diagnostics storage. `DIAG_CAPTURE_PROMPTS=0` disables persisted run/step
  prompts, plans and contracts; `DIAG_CAPTURE_SOURCE_DIFFS=0` retains changed-path audit metadata
  without source diff bodies. Runtime contracts remain in memory so disabling persistence does
  not silently cripple repair. Cross-store project/account erasure is not yet claimed complete.
- The production indexer now activates Babel's TypeScript plugin for `.ts`/`.tsx` and JSX for
  `.jsx`/`.tsx`; valid typed modules no longer become opaque. The patch lane has no `read_file`
  tool, so retrieval no longer claims one exists: an opaque required body that cannot fit the
  hard context budget fails before provider dispatch instead of sending an unusable interface.
  Bound capability packages are included in scoped retrieval, and persistent project knowledge
  is loaded into both contract generation and patch prompts through the existing knowledge-store
  seam. No model call or provider credit was used to prove these paths.
