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

## Progress — fresh downlight failure reproduced and repaired locally
- Fresh production downlight build ended failed/blocked after 274 seconds and 6.0059 recorded credits, before preview. Report `/home/ubuntu/thrallo-deploy-evidence/advanced-run/reliability-20261016-downlight-1792183560319.json`. These were connected-provider allowance records, not proof of a managed-credit debit.
- Root cause chain: contract rejected an explicitly blank optional spacing input; model emitted an invalid literal in a destructured function parameter; patch engine hid the parser's actual diagnostic; final escalation demanded replaceFile even though the failed newFile never entered the tree. Final content was valid but rejected because the path did not exist.
- Replayed final emitted content unchanged against retained snapshot `2c060f43-7a7a-42dd-96eb-15ba9772ddf2`, changing only replaceFile to newFile: patch accepted and real Vite compilation passed. Replay used isolated local files, no customer-state mutation or model call.
- Local fixes: allow exact empty-string input fixtures while still rejecting invisible empty expected outputs; teach the contract producer the distinction; expose bounded Babel diagnostics; distinguish existing/missing files in escalation; clarify custom function declaration syntax; narrowly normalize replacement to creation only with same-path prior parser-rejected creation evidence. Scope/protected-path/parser/compile gates remain enforced.
- Blank-input contract/verifier-focused suites passed 33/33 plus actual browser blank-input test 1/1. Parsing/model/escalation/contract/baseline regressions passed 92/92 before final recovery integration. Recovery patch-engine tests passed 14/14; full orchestrator integration now running. A nonexistent test filename was supplied alongside the patch suite; its result provides no extra coverage.
- Full earlier code-agent baseline completed: 2,823 tests, 2,820 passed, two stale assertions failed, one skipped. Fixed current prompt-length measurement separately from historical frozen baseline and changed historical Git audit-pin equality to ancestry. Broad rerun pending final integration.
- Next: finish integration checks, commit, build a NEW immutable sandbox image (ef92b74 is now stale), check active builds, back up live release state, deploy through guarded existing process, then repeat full live downlight build and independent visible-result checks. No application source deployment yet.

## Progress — recovery regression and real publish routing repair
- Recovery integration now proves the real scaffold/patch engine/compiler accepts a valid whole-file correction after rejected creation, with exactly two model emissions total and no extra correction dispatch. Focused prior run: 133 existing/new tests passed; the one new integration assertion initially included unrelated import-scope correction. Reworked fixture isolates rejected-creation recovery; that integration passes. Broad suite is still running.
- Live failed downlight settlement confirmed: compensation eligible, 2.7006 service credits actually in credit_ledger; managed refund zero because connected allowance was used. No manual accounting changes.
- Production quality/security/configuration checks: **40/40 passed**.
- P1 publish false-success reproduced on audit counter: service reported published, public URL returned 404. Immutable artifact and `.thrallo/sites/<slug>/current` existed, but effective Caddy root still pointed at legacy `/publish/<slug>`. Only one currently live Thrallo published_sites row exists (this audit project); no existing customer live row needed migration.
- Backups `/home/ubuntu/backups/reliability-20261016-caddy/` contain both original configurations and hashes. Changed ONLY Thrallo publish root in effective shared config to `/publish/.thrallo/sites/{http.request.host.labels.3}/current`; synchronized production re-raise copy to actual shared configuration, preserving all other host blocks. Staged `caddy validate` passed. Caddy v2.11.4 supports SIGUSR1 reload with its actual `run --config` invocation; used graceful reload, not container restart. Confirmed success log, unchanged October 11 start time and restart count 0. Official reload reference: https://caddyserver.com/docs/command-line#signals . Stale runbook requirement to restart with admin off does not apply to this version.
- Published audit URL now HTTP 200: https://reliability-counter-20261016.app.thrallo.com/ . Both app.thrallo.com health and buildr101.com still 200. Counter preview 502 separately: its runtime had exited normally seven minutes BEFORE reload, likely idle cleanup; investigate wake-on-open instead of attributing to routing change.
- Outstanding publish systemic fix: internal artifact health does not prove public ingress. Add public manifest/HTTP verification to release activation and recovery so configuration drift cannot produce another success receipt. Do not blindly deploy ops/Caddyfile.unified over the shared config; it lacks unrelated live host blocks.

## Progress — public delivery gate implemented
- Published counter independently passed **10/10 desktop/mobile interactions**, with no browser runtime errors or horizontal overflow.
- Added public ingress proof: canonical validated Thrallo slug only, HTTPS, redirects refused, bounded response bytes/time/retries, exact SHA-256 and size for index plus same-origin script/style assets. Used after pointer activation and before completion for new publish, rollback and reconciliation. Artifact-only validation remains for a previous release before restoring its pointer.
- Publication regression suites **55/55 passed**, including 404/redirect/auth/503 refusal, stale index, SPA fallback masquerading as JavaScript, bounded transient recovery, arbitrary-host rejection, and previous-pointer rollback when public ingress fails.
- New proof executed against the real published counter: exact index, JS, CSS and analytics asset all matched immutable artifact bytes. Initial read attempted a nonexistent publish_releases.manifest column; corrected to the authoritative provisiond verify response. No database writes for this proof.
- Sandbox d746907 image built and provenance proof compatible; publishing changes do not alter the verifier identity. Next deployment will still use the existing image-mode release procedure against the final commit.

## Progress — release 86bab83 activated and post-release work
- Runtime release **86bab83309a838e3c3db9c10f1d096eb4059bf76** deployed through guarded existing deploy script, rebuilt sandbox image `thrallo-build-sandbox:86bab83309a8`. Host/image verdict identities agree. Exact prior worker drained and stopped before live source writes; only worker and shell restarted. Fresh new-worker preview-isolation/admission proof passed; public health green and post-deploy route smoke **31/31 passed**.
- Backup of changed live source, metadata and worker environment: `/home/ubuntu/backups/reliability-20261016-release-86bab83/live-before.tar.gz`; rollback.json lists newly added paths and prior hashes. No unrelated tracked-file drift detected. Production-specific shared Caddy config preserved. Web artifact reused; fake local browser-test config never deployed.
- Full broad repaired suite completed **2,833 tests: 2,832 passed, 0 failed, 1 skipped**, 828.7 seconds. Separate publication suites passed 55/55 after the broad run had already loaded its initial files. No 99% claim: deterministic coverage is not a representative live-build sample.
- Existing deploy script now invokes `/home/ubuntu/thrallo-advanced-run/drain-worker-for-release.mjs` after preparing artifacts and before live writes. It identifies the service PID/hostname registration, refuses busy/operator-paused workers, waits for acknowledged draining, then stops exactly that service. Backup of pre-hook script retained. Move this operational helper into repository and add release-process documentation/tests in follow-up.
- New live downlight run on 86bab83: project `f0041916-9d38-4fab-b84d-b59e83ac32dc`, public build `006ed3f1-b928-4a8b-9fcb-f0920f0be254`, work job `da238767-d6de-40de-bab8-5d5cfd141310`, internal `b67612ea-a916-448f-8922-0ec21ceb0c22`; `/home/ubuntu/thrallo-reliability-runs/downlight-fixed.log`. Do not restart worker while it is active.
- Idle preview recovery passed using authoritative green snapshot and normal provisioner start: counter preview returned HTTP 200 after its idle stop. Direct stale preview links still return 502 until owner opens/restarts preview; assess graceful inactive-preview UX separately.
- P1 operational failure: nightly backup failed because default QA filesystem root did not exist. Worker default `/var/lib/thrallo-qa` also disagreed with shell/backup `~/thrallo-qa` and lay outside worker's writable systemd paths. Explicitly set QA_ARTIFACT_DIR=/var/lib/thrallo-build-worker/qa in BOTH shell and worker environment, created dedicated owner/group 2750 root, effective in this service restart. Config backups `/home/ubuntu/backups/reliability-20261016-qa-config/`. Backup rerun active; real QA capture/download proof pending. Do not weaken backup missing-root checks.
- Disaster-recovery health also reports isolated restore drill older than 31 days. Existing full drill requires external port-probe prerequisite; inspect available safe isolated environment and complete possible restore validation without exposing restored production data. No customer restore performed.
- Connected Supabase confirms October 6 smoke/bypass verifier-policy widening already applied. Migration drift read-only report: 107 live tables, zero coverage problems. Recorded current migration history overlay: **89 active/applied, zero pending, historical version drift explicitly preserved**.
- Security advisor identified PUBLIC EXECUTE on three internal SECURITY DEFINER trigger functions. Confirmed live definitions return trigger; applied `restrict_internal_audit_trigger_functions` (20261016210929) after isolated PostgreSQL17 proof: authenticated entity insert still emits audit event, service-role updates remain blocked by append-only guards, browser execute privileges revoked, service role retained. No table/data/RLS changes. Rollback grant documented in migration. Advisor recheck clears all six function warnings; only leaked-password protection warning remains, plus intentional deny-all-RLS informational notices. Links: https://supabase.com/docs/guides/database/database-linter?lint=0028_anon_security_definer_function_executable and https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection .
- Deployment manifest still inherits old migration count 84 from prior release (actual89); admission checks pass but release schema metadata is stale. Use captured live ledger in next release via --ledger; do not rewrite active identity while a build runs.

## Current next actions
1. Finish and independently verify live fixed downlight build; repair any new genuine failure.
2. Finish backup rerun, real QA artifact capture/read and isolated restore proof where safe.
3. Queue representative CRUD/persistence and multi-route/booking builds, inspect real outcomes and costs.
4. Commit/deploy migration ledger and operational runbook fixes on next idle release; improve stale-preview and remaining contract fixture coverage.
