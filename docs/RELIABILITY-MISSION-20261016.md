# Thrallo reliability mission — 2026-10-16

## Authority and preservation
Owner authorizes inspection, repair, testing, safe deployment and measured reliability improvement. No customer deletion, security bypass or unrelated changes. Work in isolated branch `audit/reliability-20261016`, worktree `/home/ubuntu/thrallo-reliability-audit`, based on deployed `1aaf91817c37b4dea6e74f71d9dd6144a43496d7`. Production is a deployment copy, NOT a Git checkout. Existing dirty `/root/thrallo-downlight-audit` and other worktrees are preserved. Other Codex/Aria processes exist; no changes to their work. No 99% claim without representative measured evidence.

## Observed baseline
- Public `https://app.thrallo.com/api/health`: HTTP success; ok, supabase, provisiond, stripe, stripeWebhook, byok true. This is configuration/health evidence, not end-to-end certification.
- Active systemd: thrallo-shell (PID 3072), thrallo-build-worker (3345), thrallo-provisiond (3275), all rooted in `/home/ubuntu/code-agent`. Shell reports 2 restarts since activation October 11; worker/provisiond zero.
- Separate Buildr101 services and `/home/ubuntu/app-builder` coexist; shared Caddy. Never restart shared services for routine Thrallo fixes.
- Deployment provenance: source 1aaf918, sandbox source 09895b8, immutable image digest recorded in production `.deployment-provenance.json`.
- Disk 140 GiB available (64% used); memory 37 GiB available. No swap.
- Source Git object for production commit exists in `/root/thrallo-codex-hotfix` repository. Source worktrees include old downlight changes and advanced reliability branch; do not merge blindly.
- Existing runbooks contain historical dark-worker instructions contradicted by newer release documentation. Verify live state before actions.
- Staging environment: not yet established. Full-build success rate: unknown.

## Audit queue and findings
| Area | State / next evidence |
| --- | --- |
| Runtime/deployment | Check manifest/image gate, service logs, deploy script and rollback |
| Build failures | Reproduce retained downlight composition, text case, feet/ft and visible outcomes |
| Verification/repair | Run deterministic qualification and broad tests; identify false negatives without weakening real assertions |
| Signup/login/onboarding/chat | Inspect routes, run HTTP and browser coverage |
| Providers/planning/generation | Inspect current routing, failure classification and representative builds |
| Preview/publish/domains/persistence | Verify worker, generated runtime and deployment gates |
| Billing/credits/security | Targeted regressions, inspect infrastructure-failure accounting |
| Jobs/concurrency/recovery | Read current metrics, leases and failure history |
| Desktop/mobile/UX | Build and run relevant tests; document unavailable environments |
| Database/migrations/backups | Read-only history and safety checks before any migration |

## Changes, tests and deployment
- Created isolated worktree and this ledger. No production mutation or deploy performed.
- Reused installed dependencies via untracked node_modules symlink; do not modify shared dependencies.

## Next action
Inspect current release health gates and sanitized logs, execute deterministic qualification, reproduce retained downlight failures, then implement focused fixes with regression evidence. Continue updating this ledger across compaction.

## Progress 20:35 UTC
- Fresh production worker admission passed for source 1aaf918, no configured version drift, current preview isolation proof. No warning-priority journal entries in last 24 hours (application JSON still needs inspection).
- Read-only queue sample from 2026-09-16T20:29:36Z: 51 jobs, 28 succeeded, 21 failed, 2 cancelled; 13 generated_app, 5 contract, one each worker_error/provider_customer/sandbox_version_mismatch. Includes engineering runs; NOT a representative user success metric. Success among non-cancelled queue jobs: 28/49 = 57.1%, not an end-to-end quality certification.
- P1 deployment defect confirmed: actual `/home/ubuntu/thrallo-advanced-run/deploy.sh` lacks documented image-rebuild guard. Historical October 5 job failed sandbox_version_mismatch. Implemented immutable-target preflight in ops/check-release-sandbox.mjs; 5/5 focused tests pass, including stale checkout policy, invalid revision/mode and explicit image rebuild.
- Historical October 6 worker error was verifier-policy database check rejection; current source has widening migration. Verify deployed migration before treating resolved.
- Found additional source repository `/home/dev/projects/code-agent` at 5d83498 with untracked unrelated work and 9 worktrees; preserved. The chosen repair branch remains based on actual deployed source.
- Retained September 22 downlight evidence in `/root/thrallo-downlight-audit/docs/evidence/downlight-20260922/HANDOFF.md` distinguishes initial invalid transient store dependency from later correct calculations rejected by copy assertions. Prior draft fixes are unvalidated and not blindly imported.
- Initial test runs invalidated by missing Playwright browser and partially installed scaffold dependencies. Stopped only this worktree's two test runners; installed Chromium and repairing local scaffold deps. No production dependency writes. Initial logs are diagnostic only, not baseline pass/fail evidence.

## Progress — first repairs and qualification
- Deployment preflight installed into the actual server deploy path (no app restart). Rollback original: `/home/ubuntu/backups/reliability-20261016-deploy/deploy.sh`, SHA256 `7867fd49cc1acfb7aac6c43c30941f7e3d26fd90d027ae7b2c091d8c342afdce`. Guard executes before release artifacts/live writes. `bash -n` passed. Actual 09895b8→1aaf918 permitted; incompatible 999e537→1aaf918 blocked with exit 2. Public health remains green.
- Deterministic qualification: **260/260 passed**, 170.5 seconds. Current downlight/output/runtime regression: **29/29 passed**. This confirms current fixes, not original retained snapshots or representative paid builds.
- P1 false-green preview readiness reproduced: HTTP 301/401/403/404/429 counted as ready with verifier disabled. Fixed readiness to require 2xx, release response bodies on retry/success. New regression failed before fix; verification-mode suite **9/9 passed**, including orchestrator bypass integration.
- P2 composed-store inherited-property crash reproduced for `constructor`, `toString`, `__proto__`, `hasOwnProperty`. Fixed own-property lookup and computed __proto__ declaration; both transient and durable reserved-name regressions pass. Requires sandbox image rebuild before app deployment.
- Production read-only terminal consistency: 283 records, zero active/post-activation inconsistencies, 15 historical pre-policy inconsistencies. No historical data rewritten.
- Web build passed. Initial UI run 6 passed / 44 skipped because auth config absent. Rebuilding local test bundle with fake public configuration to execute mocked-auth cases without production credentials.
- Broad code-agent suite still running. Runtime code fixes not yet deployed; release guard is the only activated change.

## Progress — live build and remaining failures
- Started an isolated counter build using the existing live qualification runner and its established owner/connected Codex lane, verifier ON. Project `1b778109-5358-4a49-acb7-d96d62d38a00`; public build `44496d9e-6aac-46a0-b08a-ee919b34da69`; work job `d5810075-aa5c-4b40-9424-c0508dbc46d3`; internal `1461737d-87fd-49dc-aa79-d2c37408d2a0`. Logs `/home/ubuntu/thrallo-reliability-runs/counter.log`. No existing projects modified. Do not deploy while it is active.
- Billing harness was stale: it referenced absent short Haiku ID instead of catalogue's canonical dated ID and crashed. Updated test fixture only, no rate/credit policy changes; **37/37 passed**. Ledger, static security, HTTP security, ownership and billing-limits harnesses all exited 0 independently.
- Backup validation passed. Local migration history validation reports 88 active vs 87 recorded, with October 6 policy widening pending in local ledger. This is local ledger evidence, NOT remote schema status. The live counter successfully created a smoke_v1 build, so that historical constraint rejection is not currently reproduced.
- Retained complex downlight graph proof **fails** at overall contract validation: missing state producers and ambiguous cross-journey record producers. This legacy fixture predates current provenance requirements; retain failure and inspect whether normalization/repair handles it. Do not weaken provenance checks to make it green.
- Runtime crash/entity integrity regressions after own-property repair: **37/37 passed** (plus separate durable __proto__ test passed).

## Progress — browser and release evidence
- Mocked-auth UI suite now **50/50 passed**, desktop and mobile. Real signup/login remains separate from this fixture-based coverage.
- Production public-auth and mounted-route smoke **31/31 passed**, including owner gates, cancel/reattach/export, downloads, publish/domain routes and browser asset auth configuration. Actual production has no shell/web/.env; smoke uses shell/.env successfully. Runbook command referring to absent web env is stale.
- Independent retained-source browser replay **4/4 passed**: initial snapshot reliably reproduces missing calculation store, all three repaired snapshots render correct visible outcomes for feet (9 lights), custom metric (12), default metric (6), and invalid-input validation with no result panel. Each source snapshot is copied unchanged into isolated test fixtures; .env.example credential fields verified empty. Existing audit worktree remains unchanged.
- Built sandbox image `thrallo-build-sandbox:ef92b74ac311` from archived commit ef92b74; not yet pinned or activated. Image provenance and isolated sandbox proofs are next. Runtime changes await production build completion and release gates.

## Progress — independent live checks
- Counter baseline completed on 1aaf918: 256,257 ms, internal green, queue succeeded, fresh smoke verified, HTTP 200, 2.0816 recorded credits. Report `/home/ubuntu/thrallo-deploy-evidence/advanced-run/reliability-20261016-counter-1792183207091.json`.
- Independent live-browser counter proof passed **10/10 actions** across desktop/mobile (increment twice, decrement, reset, negative value), no page errors or horizontal overflow. Initial probe used wrong exact accessible name; actual aria-labels append “control”; corrected probe uses observed accessible names. This was a harness mismatch, not an app failure.
- Current live preview uses `preview.buildr101.com`, not the documented Thrallo preview domain. It works and CSP permits it; assess tenant branding/configuration separately without changing shared ingress.
- Sandbox safety proof passed: valid compile, exact malformed compiler diagnostics, enforced CPU/memory/pid/read-only/network limits, timeout process cleanup, OOM isolation, browser load, browser cancellation cleanup, supervisor recovery. Image provenance compatible.
- Source baseline compared 1,553 tracked files against production: none missing; only `provisiond/Caddyfile.tls` differs. Preserve this production-specific configuration.
- Real production HTTP proof passed with a newly created disposable user: sign-in, authenticated fetch log streaming, registered/custom analytics origins and malformed/unregistered/oversized rejection. Improved proof cleanup to revoke session before identity deletion and fail on identity cleanup errors. No customer identity modified; no email sent.
- Downlight baseline active: project `7587fa81-7293-42c1-ad19-bb5f95633cf2`, public build `2b5edd86-c33c-49f0-87d1-d916e44ab97e`, queue `42ee63b8-f01d-4b5b-93e3-24df76f1c9d5`, internal `62e637a6-7e7c-471c-bce5-0c789a57ec4c`. Log `/home/ubuntu/thrallo-reliability-runs/downlight.log`.
- Desktop release API and both Windows artifact endpoints return HTTP 200. Native Windows execution is not available on this Linux host; not certified by HTTP checks.
