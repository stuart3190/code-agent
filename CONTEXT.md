# Thrallo handoff

## Current milestone

**The v2 pivot is approved and underway.** `docs/PRINCIPLES.md` (12 principles +
implementation emphases + platform architecture) is the source of truth for every
implementation decision; the roadmap lives in `Desktop\Thrallo_V2_Roadmap.md`. Phases run
with a Stuart approval gate at the end of each.

VERIFICATION AGENT LIVE (2026-07-31, PRs #64-#67): a permanent Verifier specialist
gates EVERY app build — Playwright drives the live preview as a real user (signup, login,
session + database persistence across reload, edit/delete/upload where offered, console +
network hygiene incl. 404/500/CORS). The gate is STRUCTURAL: completion messages only
exist after PASS ('built, verified, and live' + ✓ summary); FAIL sends named failures to
the Builder as a surgical repair job (design/layout/colours/branding/UX preserved, minimum
diff) and re-verifies — two auto rounds then honest escalation. repair_app capability
classifies 'X is broken' reports as precise fixes on the EXISTING tree, never rebuilds.
First live run immediately caught real platform bugs: previews pointed at the undeployed
app-analytics function (CORS noise on every app — injection removed) and show_preview/
publish materialized RAW trees without withRuntimeEnv (fixed — one env seam everywhere).
Playwright chromium installed on the VPS. FULL PASS achieved on ProofBook in production.
Build once. Repair precisely. Verify completely.

FULL-STACK GENERATED APPS DELIVERED (2026-07-31, PRs #62/#63, backend-pipeline
investigation for Stuart): ROOT CAUSE — Thrallo produced frontend-only apps; withRuntimeEnv
injected real config but the per-app runtime (entities + app-auth) deferred at P19 was
never provisioned (app-auth 404, no entities; runJob's static gates reported success
anyway; repairs could only regenerate frontend because no backend component existed). FIX —
per_app_runtime migration (entities owner-RLS + app_id namespace, app_users, auth
events/resets) applied; app-auth Edge Function DEPLOYED to zczgvcsokfafuyognvwx
(synthetic domain apps.thrallo.com); runtime honesty gate in runJob
(appRuntimeStatus.backendRuntimeReady — SDK-shipping builds fail loudly when the runtime is
down); DR coverage extended; PUBLIC_URL set. PROOF — scripts/prove-app-backend.mjs 6/6 in
prod through the exact shipped SDK (signup/persist/reload/namespace-isolation/RLS-deny),
and a freshly generated ProofBook app passed 3/3 Playwright as a real user: account
created, message saved, survives hard reload with session intact
(p15dee53d96f34963a589d50a194f0d4e.preview.thrallo.com).

PREVIEW INCIDENT + FIXES (2026-07-31, PRs #59/#60, deployed): Stuart reported a build
claiming 'the preview is live' with no card. Chain: the Phase 24 route codemod had
SILENTLY SWALLOWED the /api/domain-check dispatch (verification grepped only the import
line) → every on-demand cert ask 404'd since that deploy → provisiond's readiness probe
failed through Caddy while containers were healthy → runJob recorded previewUrl:null →
the relay still claimed 'live'. Fixes: (1) dispatch restored + e2e regression test
asserting the gate's own {ok:false} JSON shape (generic no-route now fails CI); (2)
buildEndSummary() pure helper — never claims a preview without a URL ('warming up'
instead); (3) recoverPreview() polls ~3min after a URL-less success and delivers the card
late + away-notification; (4) show_preview capability revives reaped/missing previews from
the stored tree (Publisher choreography); (5) provisiond waitReady 120s→240s
(PREVIEW_READY_TIMEOUT_MS). Orbit healed live: preview_ready delivered, HTTP 200, fresh LE
cert. LESSONS: codemod verification must grep the DISPATCH, not the import; a 'timeout'
whose artifact later works points at the probe path, not the workload.

OWNER ACCOUNTS (2026-07-31, PR #57, deployed + live-proven): Thrallo staff
(THRALLO_OWNER_EMAILS in shell/.env — currently stuart3190@gmail.com,support@thrallo.com;
resolved owner-id→email via auth admin, cached 5min, fail-closed) bypass EVERY enforcement
point — run budgets/rate caps, mid-run token guards, build affordability, app_build
admission, completions limits — while usage keeps recording for analytics
(ownerAccounts.mjs; budgetOverview returns ownerAccount/unlimited/previewPlan and all
enforcement sites honor unlimited). Plan preview: owners View-as Free/Starter/Pro
(ca_subscriptions.preview_plan, POST /api/v1/owner/preview-plan, settings-sheet toggle) —
presentation only, enforcement stays off; ignored for non-owners. /api/v1/usage now
returns plan/budgets too (pre-existing gap fixed). Live-proven: staff PAT shows
ownerAccount:true/unlimited:true, preview round-trips, non-listed accounts get 403.

PERSISTENT CHECKPOINTS + BYOK CONTROLS + DAILY SPEND (2026-08-01, PR #121, merged +
deployed + prod-verified): closes the three limitations left open by #119/#120.
(1) build_checkpoints table — the ring was in-memory and died with the process. Checkpoints
write through (expires_at stamped at write, default 48h via THRALLO_CHECKPOINT_RETENTION_HOURS),
a resuming lifecycle SEEDS from surviving rows, and boot-time recoverInterruptedLifecycles()
restores last-known-good when an interrupted build left the project worse. Hourly sweep +
releaseLifecycleCheckpoints() keeps only the BEST row when a lifecycle ends. scrubTree() drops
.env/.pem/key files and redacts inline secret assignments BEFORE anything is stored.
**RLS on + ZERO policies + revoke from anon/authenticated — verified in prod:
rls_enabled=true, policy_count=0, authenticated/anon SELECT=false, service_role=true.**
Deliberately NOT ca_checkpoints (repo-agent pipeline); a test enforces the separation.
(2) BYOK "Optional spending safeguards" UI under each connected BYOK provider in Settings →
AI connection. Schema now supports {global, providers:{<id>:{...}}, timezone}; a provider
value overrides the global default control-by-control, an explicit null turns one off for
that provider only. ALL still default to disabled and the copy states plainly that Thrallo
does not cap a key the user owns. Saves via POST /api/v1/ai/byok-safety (numbers + nulls
ONLY — no key material in or out).
(3) ai_requests.byok flag (set from buildContext) makes rolling daily BYOK spend real:
dailyByokSpend() sums CHARGED byok rows in a UTC day (or the user's IANA zone), excluding
managed usage, other tenants, other days and null/zero-cost rows; a provider switch keeps
per-provider totals separate so nothing is double-counted. **Fails OPEN** when accounting is
unavailable — never block a user's own paid capacity over a telemetry hiccup.
Bug found + fixed en route: validateByokSafetyInput rejected a flat document containing only
a timezone because it read document-level keys as controls.
388 node + 46 Playwright green (43 new in test/code-agent/checkpoint-persistence.test.mjs +
e2e/provider-settings.spec.mjs).

AUDIT REMEDIATION COMPLETE (2026-08-01, PRs #123-#131, all merged + deployed + prod-verified).
Seven planned PRs plus two follow-ups. Every confirmed defect from the 2026-08-01 audit is fixed
and proven in production; 454 node + 100 Playwright; smoke 18/18.
ROOT CAUSE of the biggest cluster: **PR #53's Buildr101 legacy unmount OVER-SWEPT**, deleting
Thrallo's OWN Phase-19 route bodies (/api/builds/*, /api/projects/:id/active-build, /api/export,
/api/test-runs) and leaving empty `{ let m; }` blocks. Nothing imports a handler until it is
mounted, so no lint/type/test error fired — users could not cancel a build at all, and export and
QA were dead. (The audit blamed PR #73; git proved that was only reformatting.)
PERMANENT GUARDS now in place: route-manifest (every route module mounted OR retired with a
written reason, both directions fail; references COUNTED so an imported-but-undispatched handler
fails on its own); scripts/smoke-production.mjs (the DEPLOYED origin answers every critical path —
run after every deploy); backup coverage (EVERY create table, not a name allowlist); provider
registry vs EVERY AI constraint; desktop build (8 tests); scripts/feature-health.mjs (which
features have NEVER executed in production).
DESKTOP WAS UNBUILDABLE, not merely stale: `compile` died on the removed copilot extension, and
`package` died from any normal shell because upstream's hasAuthenticodeSignature REJECTS on spawn
error when the Windows SDK is not on PATH. Both fixed and discovered automatically, plus an
`installer` command (ISCC installs per-user, never on PATH). Windows release 0.4.0 published and
proven end to end: install -> launch -> token auth against production -> real projects render.
FOUND BY TESTING, NOT REASONING (each shipped): app_notifications RLS took THREE attempts — a
`for all` policy let a client FORGE source=password_changed and phish its own users (proved by
doing it), then pinning `source is null` in WITH CHECK blocked marking platform notifications
read; COLUMN GRANTS are the answer. `export { x } from` creates no local binding and threw at the
first checkpoint. Stop build was invisible on mobile. apply_patch was strictly exact (a trailing
space or one space of indent defeated it — now graduated, and a tolerant match preserves the
FILE's lines). The outcome `exported` signal missed /api/export because export has TWO entry
points.
28 tables in supabase/migrations were NEVER APPLIED to production (Buildr101-era) — qa_runs and
app_notifications among them; both created properly with Thrallo's isolation posture.
DELIBERATELY NOT DONE: `preview_opened` (needs client-side tracking plus a product decision);
`regenerated` (repairs are already run.repair_rounds, re-builds already `superseded`; emitting it
would double-count AND suppress `accepted`).

REPAIR-PIPELINE HARDENING (2026-08-01, PR #119, merged + deployed + prod-verified):
**ROOT CAUSE of four confirmed defects: `planEndAction` inferred retry eligibility from job
`status` alone, so EVERY non-complete job became a blind paid retry.** (1) `cancelJob`
finishes as `failed`/"Cancelled by user." and nothing unsubscribed the relay → a cancelled
build was reclassified as a crash and RETRIED; (2) `ManagedBillingError` and the cost-guard
throw surfaced as generic failures → a spent budget funded another attempt, and a provider
quota exhaustion retried the SAME exhausted provider; (3) the retry path read `job.prompt`
but `createJob` stores it at `job.input.prompt` → every retry dispatched `prompt: undefined`;
(4) `managedAffordableCreditLimit` is PER JOB with nothing summing across the lifecycle → a
three-job loop could spend 60+40+40.
FIX: jobs stamp `build_jobs.stop_reason` where the truth is known; `classifyEndState`
(endState.mjs) maps (status, stopReason, error, result) → one of ELEVEN explicit states;
**only `transient_interruption` may auto-retry.** New modules: endState.mjs (classification
+ provider-condition + human-input detection), lifecycleBudget.mjs (aggregate credits/
tokens/turns/jobs/repairs/elapsed, configurable per plan+mode via
THRALLO_LIFECYCLE_<FIELD>_<PLAN>_<MODE>; free build 90cr / starter 140 / pro 220, jobs=3),
byokSafety.mjs (5 OPTIONAL controls, ALL default null=disabled — **BYOK gets NO mandatory
Thrallo spend cap**; loop safety comes from the structural limits instead),
repairProgress.mjs (no-progress detection: compile/preview/runtime/verification-score/
failure-count/subset-narrowing/meaningful-diff), buildCheckpoints.mjs (bounded in-memory
ring, marks generated|compiled|preview-ready|verification-passed|verification-failed,
last-known-good never evicted, auto-restore on regression — **deliberately NOT ca_checkpoints**,
that table is the repo-agent pipeline's). A `lifecycle` object threads originalInput +
budget + checkpoints + repairMemory + round history through every dispatch; provider
fallback resumes from the same step keeping all counters (never restarts). Owner notified
once on every terminal path. Wording corrected: "I completed the initial build and 2
automatic repair attempts" (was the overstated "3 autonomous repair rounds").
PRESERVED: three-job ceiling, failure fingerprinting, duplicate-brief detection, scoped
context, diagnostics, verification gate, provider routing, agent structure.
Migration `20260801120000_repair_pipeline_hardening` (build_jobs.stop_reason,
ca_ai_preferences.byok_safety). Relay takes injectable `deps` so tests assert what is
actually DISPATCHED, not just what the planner returns. 367 node + 38 Playwright green
(45 new in test/code-agent/repair-pipeline.test.mjs).

FIRST REAL GROK BENCHMARK (2026-08-02, PR #117): Grok connected (BYOK, active provider).
Benchmark now resolves BYOK keys SERVER-SIDE via --owner (decrypts in-process; key never
printed/logged/written to results) — run on the VPS, never locally. **LIVE PROBING KILLED
THREE ASSUMPTIONS I had written without a key: grok-build-0.1 REJECTS `reasoning` (400
invalid-argument — every call failed); `grok-4.5-fast` DOES NOT EXIST ("Model not found",
an invented name → replaced with grok-4.3 which the account lists); grok-4.5 does accept
reasoning. The account also exposes grok-4.3 / grok-4.20-* / imagine-* that the catalog
never had.** Adapter now self-corrects: "does not support parameter X" → strip, retry
immediately (not against the retry budget), remember per-model; UNKNOWN models attempt
reasoning optimistically so a new Grok costs one corrected call, not a code change.
HEAD-TO-HEAD (identical tasks, real engine loop, real local compile verification, all 6
PASS): edit openai 1792tok/0.179cr/8s vs grok 4217tok/0.088cr/7s; bugfix openai
1180/0.118/3s vs grok 2584/0.063/5s; component openai 2881/0.288/5s vs grok
9126/0.171/13s. **Grok 41-51% CHEAPER on every task at equal verified success; OpenAI
faster on the two harder tasks (component 5s vs 13s). Grok uses 2.4-3.2x more tokens at a
much lower per-token price.** Real product build on Grok recorded into Provider
Intelligence: grok-build-0.1 cost/verified 0.2266 cr vs gpt-5.6-terra 1.8817 cr. Ranking
still "Collecting benchmark data." — Grok has 1 of the 5 builds the floor requires.

XAI CONNECT INCIDENTS (2026-08-02, PRs #114/#115, deployed + prod-verified): TWO separate
user-reported failures, both real, neither what they looked like.
(1) "won't accept my Grok API key / something went wrong" → NOT the key. PR #90 shipped the
xAI adapter/validation/routing/UI but the DB CHECK constraints on `ca_ai_credentials`
(provider_check + provider_auth_check) AND `ca_ai_preferences.active_provider_check` still
listed only codex/openai/anthropic/gemini, so the INSERT died on a constraint violation
surfaced as a generic 500. Fixed by migration `allow_xai_provider`; **guard test parses
API_KEY_PROVIDERS from aiCredentialStore and asserts every provider appears in the
migration constraints — code can never outrun the schema again.** Diagnosis took one step
because journalctl carried the raw error (the error shield logs privately, hides publicly).
(2) "xAI disappeared completely from Settings" → NOT a rendering/catalogue/flag/cache
regression: adapter, `/api/v1/ai/connections`, Settings list and filtering all intact, and
e2e/provider-settings.spec.mjs run AGAINST PRODUCTION proved the row renders desktop+mobile
with key field and Connect. Real defect was NAVIGATIONAL: the model selector's "Configure
xAI / Grok" row called onOpenSettings → Settings ROOT, a screen that never mentions xAI →
indistinguishable from "gone". SettingsSheet now takes `initialSection`; Configure rows
deep-link to AI connection (avatar/palette still open root). New suite in test:ui,
production-runnable via E2E_BASE_URL, also asserts a provider whose last validation FAILED
stays listed and reconnectable. LESSON: when a user says a UI element vanished, verify
rendering against PRODUCTION before touching the render path — the bug may be the route
that gets them there.

OUTCOME LEARNING (2026-08-02, PRs #111/#112, deployed + VALIDATED ON REAL PROD DATA):
Auto learns from what users DO, not opinions. `lib/buildOutcomes.mjs` — signal vocabulary
is a CLOSED validated list (preview_opened/exported/deployed/rolled_back/regenerated); no
likes/ratings exist or can be added. Most signals DERIVED at read time from durable
records (follow-up counts from ca_conversation_turns selected as `role, created_at` ONLY —
content never read; repair cycles from diag_runs; deployment from published_sites;
acceptance/first-pass/abandonment/editing time). Explicit client events post to
idempotent owner-scoped POST /api/v1/builds/:id/signal (unique index). userSuccessScore
0-100 w/ published SUCCESS_WEIGHTS {acceptance .35, completion .25, firstPass .20,
lowFriction .20}. rankCandidates gains WEIGHTS_WITH_OUTCOMES {userSuccess .45, cost .25,
duration .15, verification .15} used ONLY when EVERY eligible model has outcome evidence
(partial → technical weights, never an uneven basis); explainChoice leads with "users
completed and kept its builds more often" when outcomes drove it. Dashboard shows success
score, first-pass, follow-ups, repair cycles, export/deploy/rollback/completion/
abandonment + which weighting ranked. **PR #112 BUG FOUND BY VALIDATING ON REAL DATA:
follow-ups + last-activity were counted to the END of the conversation, so an early build
in a long session showed 7.5 follow-ups / 0% acceptance / never settled — every model
penalised for later unrelated work. A build's window now ends when the NEXT build starts;
superseded builds settle immediately.** After the fix, real prod: 12 outcome rows, 9
accepted, 4 first-pass, 2 abandoned, avg 1.08 follow-ups; gpt-5.6-terra user success 79.6
(44.4% first-pass, 88.9% accept/complete, 11.1% abandon, 1.22 follow-ups, 0.11 repairs);
gpt-5.6-sol collecting (3). Privacy verified: serialised analytics contain no owner/email/
prompt. 319 node + 30 PW.

PER-MODEL INTELLIGENCE (2026-08-02, PRs #107/#108/#109, deployed + REAL BUILDS RUN):
every MODEL is benchmarked, learned per task type. Taxonomy (contextScope.TASK_TYPES,
ordered pattern list, tested): planning, architecture, frontend, backend, debugging, ui,
refactoring, documentation, full_build, quick_edit (+feature, verification_repair).
ORDERING MATTERS: quick_edit is tested BEFORE frontend (else "rename the Save button"
reads as component work) and feature before frontend; ui beats quick_edit for colour/
spacing. modelProfiles() adds per model: recommendationScore, relative strengths/
weaknesses derived from METRICS ranking vs peers (never assigned), taskWinRate (share of
task families ranked #1), trend (recent half of window vs earlier half), collecting flag.
providerTree() nests models under providers using a provider map LEARNED from evidence →
new providers/models appear with zero code change. Dashboard: providers expand to
per-model profiles. **PR #108 BUG FOUND BY RUNNING REAL BUILDS: repair_app wraps the user
prompt in "REPAIR MODE — fix ONLY this reported problem", so EVERY conversational edit
classified as debugging and poisoned per-task learning → createJob accepts `taskHint`
(user's own words) used by scopeForJob for classification while the model still gets the
full wrapper.** LIVE STATE after ~8 real builds: 17 evidence rows, gpt-5.6-terra 9 builds/
88.9% verified/1.88cr-per-verified/14s/Low confidence, gpt-5.6-sol 3 builds/0% verified/
still collecting; task split now includes a distinct `ui` family (classification fix
proven). Overall ranking still "Collecting benchmark data." because ranking needs ≥2
models past the floor and ONLY OpenAI is configured — a genuine blocker needing a second
provider key (Stuart), not a code gap. 310 node + 30 PW.

PROVIDER INTELLIGENCE (2026-08-02, PR #105, deployed + VALIDATED ON REAL PROD DATA):
Auto learns routing from measured builds. `lib/providerIntelligence.mjs`: collectEvidence
joins ai_requests × diag_runs by build_id (anonymised — owners counted not identified, NO
prompt text) → buildScorecards byProvider/byModel/byModelTask/byMode with cost per
VERIFIED build, verification + cancellation rates, avg build duration, repair/retry
frequency, cache efficiency, samples. rankCandidates = DETERMINISTIC: published WEIGHTS
{costPerVerified .5, duration .25, verification .25}, min-max normalised, alphabetical
tie-break → same evidence always same order (dashboard publishes the weights so any
ranking is re-derivable by hand). explainChoice quotes the REAL measured delta
("approximately 38% lower average cost", "24% faster with the same verification success").
MIN_SAMPLES=5 verified builds; below it everything says "Collecting benchmark data." and
Auto keeps its configured order — statistics are never invented. Confidence Low/Medium/
High at 5/15/50. recommendModel tries task-family scope then overall then null.
modelRouting.applyIntelligence promotes a recommended model WITHIN the existing candidate
set (fallbacks preserved; never invents a candidate) and attaches evidence even when it
was already first, so Auto explains choices it would have made anyway; createRoutedCodingModel
looks it up for managed+auto only (injectable `intelligence` for tests). autoStrategy
surfaces {reason, confidence, samples, learned}. Admin → Provider Intelligence
(`intelligence` manage view, /api/v1/admin/intelligence, ADMIN_EMAILS-gated): provider +
model rankings, per-task winners, mode comparison, trend, sample sizes, confidence,
weights. VALIDATION on live prod (10 evidence rows, 1 owner): gpt-5.6-terra 3 builds /
66.7% verified / 5.64 cr per verified / 17% cache; gpt-5.6-sol 2 builds / 0% verified /
75.9% cache; both below the floor → "Collecting benchmark data." + recommendation null.
That is the system working correctly, NOT a gap. 305 node (11 new) + 28 PW.

PROVIDER QUOTA MANAGEMENT (2026-08-02, PRs #102/#103, deployed + live-proven):
`lib/providerQuota.mjs` — providerHeadroom (EXACT for managed via plan budget; ESTIMATE
for BYOK from this month's ai_requests spend vs THRALLO_BYOK_SOFT_CEILING_CREDITS, labelled
"roughly"; unknown → silent, never invents figures); thresholdCrossed returns the MOST
URGENT crossed band (20/10/5) not the loosest — a jump straight to 9% warns at 10%;
already-warned bands read back from durable quota_warning events (restart-safe);
alternativeProviders lists only reachable providers (codex excluded as a build-time
target). Copy: lowQuotaMessage / switchedMessage / exhaustedNoAlternativeMessage — plain
English, no status codes. leadAgentService: announceQuotaState() before each turn;
managed-exhaustion no longer hard-stops (fallback on → switch to a connected provider +
"continued from the last successful step", loop state untouched so NOTHING restarts;
fallback off → asks; nothing connected → explains + how to continue); router mid-run
fallback surfaced the same way. provider_badge events (🤖 Building with X / ⚡ Switched to
Y / 🧠 Deep Thinking) render in the rail. recordProviderSwitch writes reason (quota,
rate_limit, outage, user_request, cost) to the private incident trail. TESTABILITY SEAM:
processConversation accepts credentialStoreFactory. **TWO SANITISER BUGS FOUND HERE:
(1) length>320 was nuking legitimate long help text → only unpunctuated blobs now;
(2) length<3 was replacing short real replies ("OK") with the fallback → only empty text
falls back (caught live post-deploy).** 294 node (10 new) + 28 PW.

ERROR SHIELD (2026-08-02, PRs #99/#100, deployed): users NEVER see raw technical failure
detail. `lib/errorShield.mjs`: captureIncident() writes the full private record to
`diag_incidents` (migration; RLS deny-all, owner-scoped reads) — message, stack, DB/
provider code, service, conversation/build/run ids, agent, model, logs, retryCount,
timestamp — behind reference THR-XXXXXX; returns {friendly, unresolvedMessage,
privateBriefing, classification, fingerprint}. sanitizeUserFacingText scrubs constraint/
table names, SQL phrases, stack frames, fs paths, internal URLs, keys, JWTs, uuids, status
codes + TECHNICAL_MARKERS wholesale fallback. **ORDERING GOTCHA (test-caught): whole-phrase
SQL rules MUST precede the constraint-name rule, else "duplicate key … violates" survives
as a fragment.** Lead recovery: processConversation takes `recovery` state; on error →
capture → if retryable && new fingerprint && attempt<MAX_RECOVERY_ATTEMPTS(2): friendly
line + recovery event + RE-ENTER the original task with privateBriefing appended to input
(never-repeat contract); success emits FRIENDLY.recovered; exhaustion → lead_error carrying
ONLY sanitised message + reference. finishWithMessage sanitises every closing message
(defence in depth). Event-sequence collisions: SupabaseConversationStore.appendEvent
retries EVENT_WRITE_ATTEMPTS(5) on isSequenceCollision (23505) with fresh sequence +
jittered backoff. UI: recovery states (Recovering/Repairing/Verifying/Continuing),
FailureCard (Retry / Contact support / owner-only View technical details via
/api/v1/diagnostics/incidents[/:ref]). **PR #100: blocked-build messages used to paste raw
compiler output into chat — split into failureEvidence() (names the failing check + points
at Diagnostics) vs rawFailureEvidence() (Diagnostics/explain/operator only).** 284 node
(10 new) + 28 PW.

SELECTOR UX PASS (2026-08-01, PR #97, deployed): closed pill = "🤖 Model: Auto ▾" /
"🤖 provider · model • Mode ▾" (purpose obvious without opening); menu = document.body
PORTAL (fixed, anchored below pill, z-60 above everything, on-screen clamp, flips above
near viewport bottom, repositions on scroll/resize, outside-click + Escape close w/ focus
return); GOTCHA FIXED: portals escape .chat-root and inherit LEGACY BODY tailwind styles
(text-slate-200 → washed-out names; caught by screenshot review) — any portalled surface
must restate base text + button reset. Hierarchy: MODEL header, Auto row w/ Recommended
pill + plain-language explanation + "Why?" expansion (current choice/reason/cost/
duration/benchmark confidence), provider monogram badges, "Configure X" rows → Settings,
mode icons/badges, ArrowUp/Down/Left/Enter/Escape keyboard nav. e2e proves portal
layering (elementFromPoint), anchoring, clamping, outside-click, keyboard;
selector-shots.spec.mjs (SHOTS=1) for visual review. 275 node + 28 PW.

THREE-LEVEL SELECTOR (2026-08-01, PRs #94/#95, deployed + live-proven): Provider → Model
→ Mode. Adapters self-describe via *ProviderMeta() exports (openAI/anthropic/gemini/xai:
name, env-synced model list, supportedModes, modeMap) — adding a provider = registering
its meta, ZERO provider-specific UI outside adapters (routing's providerOptionsForMode
resolves knobs from the same maps, strips tierHint). Modes fast/balanced/deep/cheapest/
max_quality: reasoning effort where native (openai/xai), tier steering under Auto
(selectionTier honors policy.mode), unsupported hidden (gemini no deep) + validation
coerces to balanced. Pref format `value#mode` (parseModelPref/formatModelPref); mode flows
lead loop → policy.mode → provider ctors. Measured stats per model (modelStats over
recent 500 diag_runs: success/cost/duration/repairs; "Collecting benchmark data…" <5
samples, STATS_MIN_SAMPLES). Auto expansion = exact routeCandidates decision + measured
reason + one-click pin (codex credential mapped→managed for truthfulness, #95).
Conversation switch confirms "Future requests will use X • Mode." — future-only contract
unchanged. 275 node (12 selector) + 28 PW; live: hierarchical catalog w/ collecting-stats
on prod, deep-mode pref round-trip, auto strategy accurate.

MODEL SELECTOR (2026-08-01, PR #92, deployed + live-proven): per-project provider/model
choice. GET /api/v1/models (lib/modelSelector.mjs selectableModelsForOwner) = the owner's
ACTUAL catalog: Auto first (default/Recommended), managed models (platform env keys),
BYOK-covered providers ("Your API key"), Codex when connected ("Included plan"); each w/
source, tier label, relative cost (modelWeight); unconfigured providers → "Configure
providers" link, never selectable; zero secrets (tested). Begin: ModelSelector.jsx under
composer, remembered in localStorage thrallo-model-pref, rides with the first message
(postUserMessage modelPref → validated → ca_conversations.model_pref, migration
conversation_model_pref). In-conversation: same pill above composer (ct-model-dock),
POST /conversations/:id/model owner-scoped + catalog-validated, emits model_changed
receipt; switching affects FUTURE requests only (tested: turns/events/state untouched).
Lead loop: resolveConversationModel pins requested to the pref; unavailable pref NEVER
silently switches — visible-notice fallback ONLY when routing allowFallback, else clear
warning w/ escape hatches; pill shows warn state. Live-proven: catalog correct on prod
(managed trio + codex, xai/anthropic/gemini unconfigured), set/read-back on DiagProof,
invalid model 400, reset to auto. 277 node + 28 PW.

XAI/GROK PROVIDER (2026-08-01, PR #90, deployed): first-class alongside OpenAI/Codex/
Anthropic/Gemini — ALL Grok logic in `lib/xaiProvider.mjs` (both seams: lead `turn` +
engine `runTurn` over api.x.ai OpenAI-compatible Responses API; retries/timeout/
AbortSignal cancellation; usage incl cached+reasoning tokens; normalized xai_* errors;
XAI_MODELS catalog grok-4.5/-fast/grok-build-0.1 w/ context limits, standard + LONG-context
pricing tiers + thresholds, capability flags, rate limits; discoverXaiModels merges live
/models). Exact cost xaiCostForUsage (long tier past threshold, cached always at cached
rate); credit weights via XAI_RATES in src/cost.mjs (costModel ALL_RATES merge). BYOK:
aiCredentialStore providers += xai (xai- prefix, live /models probe, hint-only public
shape); Settings UI row. Routing: modelCatalog xaiCatalogEntries() gated on configured AND
THRALLO_XAI_ENABLED + model allowlist; NEVER default (earns rank via health scoring);
buildContext xai BYOK branch honors per-agent gating + task reasoning (simple edits low).
Admin env knobs: THRALLO_XAI_{ENABLED,AGENTS,MODELS,DEFAULT_REASONING,MAX_CONTEXT_TOKENS,
LONG_CONTEXT_APPROVAL,PER_REQUEST_LIMIT_CREDITS,DAILY_BUDGET_CREDITS,PER_USER_BUDGET_CREDITS,
MAX_RETRIES}. Benchmark: scripts/benchmark-providers.mjs (identical tasks, real engine loop,
local compile verification, judged by cost-to-verified-result; --stub offline; results →
benchmark-results.json; OpenAI baseline recorded, Grok pending XAI key — YOU_NEED_TO_DO).
8 tests in xai-provider.test.mjs. Live-proven: BYOK validation answers on prod, UI shipped.

SCOPED CONTEXT PIPELINE (2026-08-01, PR #88, deployed): audit-first (scripts/
measure-context.mjs — offline scripted-provider harness, zero API cost). AUDIT FINDINGS:
engine NEVER sent whole-project contents (tool-based access; only paths via list_files),
previews/verification already AI-free, job contexts already fresh; real waste = blind
discovery turns on edits + unpruned in-job history + 30-turn conversation replay + no
repair fingerprinting. FIXES: `appBuild/contextScope.mjs` (task classification w/
env-configurable budgets THRALLO_CTX_BUDGET_*, local entry-file inference from
prompt/stderr, seeded entry+direct-imports scope w/ budget trim + warnings,
failure/prompt fingerprints, autonomous cost guard THRALLO_COST_APPROVAL_CREDITS —
user jobs never blocked); runJob iterate/repair now uses the engine's PROVEN Buildr101
contextSelection mode (seeded + history pruning). MEASURED: simple edit 3208→1855 tok
(-42%, 4→2 turns), repair 4215→1855 (-56%), feature 9427→8481 (-10%); builds unchanged.
Controlled repair loop: planEndAction stops on repeated failure fingerprint (normalized —
ids/numbers → #), relay refuses identical repair briefs, repairMemory threaded through
relay+verification; job.trigger recorded (user/autonomous_repair/verification_repair).
Lead Agent: assembleInput collapses older turns into a deterministic summary block
(recent 16 full, 6KB/turn cap). Context diagnostics: ai_requests +trigger/run_id/context
(migration ai_requests_context), /api/v1/diagnostics/:id/requests + Context Inspector in
DiagnosticsView (token split, seeded files WITH inclusion reasons, warnings). 9 new tests
(context-scope.test.mjs). REMAINING oversized-risk spots (documented, acceptable): build
mode's in-job history still append-only (provider prefix caching covers it, ~50% observed),
lead capability outputs ride within the 12-turn loop, repo-runs use their own indexed
retrieval.

USAGE & PLAN PRODUCTION (2026-08-01, PR #86, deployed): customer UsageView redesigned —
plan+reset, meters w/ 75/90/100% warnings (shared usageWarnings.js, threshold-tested) +
90% banner, builds-this-month/AI cost (credits + measured £ via
RECORDED_COST_PER_CREDIT.sonnetUncached), by-provider/agent summary, recent activity w/
per-build expandable cost-by-agent/model, detailed tables in collapsed Advanced Usage.
Per-request accounting: `ai_requests` (RLS deny-all; provider/model/agent/token classes/
duration/exact cost/build+project/timestamp) written by buildDiagnostics session.step —
which also FIXED a telemetry-shape bug (engine reports input/output, code read
inputTokens/outputTokens → per-class totals were 0; normalizeTelemetry handles both).
Admin analytics (`usageInsights.mjs` adminAnalytics, /api/v1/admin/analytics,
ADMIN_EMAILS-gated 403): AI spend cr+£, monthly revenue from active paid subs
(THRALLO_*_PRICE_GBP-gated), gross profit, avg per user/build, top builds/users, cost by
model/agent, daily/weekly/monthly CSS-bar charts; AdminAnalyticsView = manage view
`analytics`. Security posture: browser can NEVER read these tables (RLS enabled, zero
policies — advisors confirm), every API path owner-eq'd; usage-security.test.mjs proves
cross-owner null/404, export purity, admin gate incl. email-less PAT owners, route
source-guard. Live-proven: own insights 200, cross-id 404, non-admin PAT 403, ai_requests
recorded from the first post-deploy build.

BUILD DIAGNOSTICS (2026-07-31, PR #83, deployed + live-proven): permanent audit trail for
every build session under one Build ID — `appBuild/buildDiagnostics.mjs` (diag_runs/
diag_steps/diag_prefs, migration `build_diagnostics`, service-role only). One diag SESSION
spans build → autonomous repair rounds → verification (threaded through relayBuildJob/
runVerificationGate; recorder attached per job as job.diag). Captured: user prompt, plan,
agents, inter-agent prompts (engine/repair/polish prompts verbatim), FULL compiler stderr
(job.buildStderr stays truncated for the client; diag keeps everything), design/capability
audits, backend runtime probes, unhandled stacks, complete terminal log (serverLog tap),
files created/modified/deleted + per-round diffs (prefix/suffix-trim line diff), rounds,
status, duration, model, tokens + per-step/total cost (creditsForUsage). Recording is
chained-async fire-and-forget — storage failures NEVER touch the pipeline (nullDiagSession
for hook safety; tested). EVIDENCE-OR-NOTHING failures: blocked/exhausted messages append
session.failureEvidence() quoting exact stored output; POST /diagnostics/:id/explain
grounds the model in stored logs (provider.turn) and quotes verbatim; zero captured
diagnostics → explicit "platform bug in the diagnostics recorder" statement, fabrication
banned + regex-tested; LEAD_INSTRUCTIONS FAILURE EVIDENCE block added. API: GET
/api/v1/diagnostics(+/:id, /:id/step/:seq, /:id/download, /prefs). UI: DiagnosticsView
(manage view `diagnostics`, palette + settings): runs list w/ status/rounds/cost, per-round
steps, expandable raw logs (lazy full fetch >12KB), round comparison, download bundle,
explain button, retention select. Retention: diag_prefs 30/90/365/forever (default 90),
6-hourly sweeper (purge audited via JSON log line, gzip >16KB at write + aged >7d inline
logs, stale running → interrupted after 2h).

NAVIGATION REPAIR (2026-07-31, PR #81, deployed): explicit "← Projects" pill beside the
wordmark whenever a conversation is open (all states; wordmark stays Home, both with
accessible labels; 44px mobile target, safe-area-aware, no strip overlap). goHome only
closes the client stream — builds continue server-side; reopening replays durable events
(history/plan/team/preview) and now restores per-conversation scroll position
(scrollMemory ref map; the thread auto-follows the stream ONLY when the reader is at the
bottom, <80px). Playwright proof "background navigation": leave a growing build → Home
shows live status → start a second project → return → away-time events/team/preview
present + `after`-resume asserted (expect.poll — the reconnect loop is on a 1.5s cadence);
phone/tablet/desktop verified (nav-shots.spec.mjs SHOTS=1). Compact preview-rail shows
agent status only in title attr — e2e must assert differently per form factor.

DESKTOP DISTRIBUTION (2026-07-31, PR #79, deployed + fully verified): Thrallo Desktop
v1.131.0 ships as real Windows downloads. `desktop/installer/Thrallo.iss` (Inno Setup 6,
ISCC at %LOCALAPPDATA%\Programs\Inno Setup 6) → `Thrallo-Setup-x64.exe` (218MB): user-level
(%LOCALAPPDATA%\Programs\Thrallo, no admin), Start menu + optional desktop shortcut,
standard uninstall, signed-ready (SignTool directive commented). Portable =
`Thrallo-Portable-x64.zip` (323MB, same build). Distribution: `releaseDownloads.mjs` —
GET /api/v1/downloads (manifest: version/sizes/sha256/date/notes) + GET|HEAD
/downloads/:name (Range-capable resumable streaming); ONLY files listed in manifest.json
under THRALLO_RELEASES_DIR (VPS /home/ubuntu/thrallo-releases, env in shell/.env) are
reachable — traversal/stray 404. `scripts/build-release-manifest.mjs` hashes artifacts.
Downloads screen = real "Download for Windows" + "Portable ZIP" buttons w/ version, size,
date, copyable SHA-256, notes, Windows x64 badge — npx/coming-soon copy REMOVED. Smoke
gained THRALLO_SMOKE_EXE (any installed/portable exe). VERIFIED: silent install → installed
app 6/6 smoke (launch/brand/file-edit/terminal/prod sign-in/conversation webview) → silent
uninstall clean (dir + shortcut gone); portable extract 6/6 (use tar -xf + SHORT dest —
Expand-Archive dies on long paths); live: manifest 200, both links HEAD/Range/206, FULL
installer download sha256 == manifest. GOTCHAS: PowerShell `*>` logs UTF-16 (grep watchers
miss ASCII markers — build "hang" was actually done); package build syncs web dist at START
(rebuild dist first, or refresh resources/app/extensions/thrallo/media/app in output after).
Release update procedure: build → ISCC → rename zip → build-release-manifest → scp all 3 to
thrallo-releases. Binaries unsigned until Stuart buys a cert (SmartScreen warnings expected).

THEME REPAIR (2026-07-31, PR #77, deployed + live-proven): after Stuart reported "light
mode has disappeared" — investigation showed tokens/light-default were intact and nothing
auto-darkens; the real gaps: theme applied only after the workspace mounted (flash +
unthemed early surfaces), no System option, preference trapped in one browser's
localStorage (a device that once picked Dark looked stuck-dark). Fixes: stored preference
applies PRE-PAINT in main.jsx; Appearance selector = Light/Dark/System (same toggle row;
System tracks OS live via matchMedia change listener); persistence = localStorage +
account user_metadata `thrallo_theme` via auth.updateUser (fresh devices adopt the account
preference when local is empty). e2e/theme-check.spec.mjs (in test:ui): light default even
on dark OS, round-trips, live System tracking both directions, reload persistence,
cross-device adoption, measured WCAG contrast of token pairs in BOTH themes; dark+light
screenshot passes reviewed. Landing stays dark by design. 224 node + 18 Playwright.

PRODUCTION POLISH PASS (2026-07-31, PR #75, deployed): full UX audit, no redesign — boot
splash + skeletons (project cards, thread bubbles, SkeletonRows/useCopy in manage/shared)
everywhere async renders; greeting no longer flashes (localStorage `thrallo-returning`);
Escape closes the delete modal + focus lands on Cancel + aria-modal on all dialogs;
command palette is fully keyboard-driven — two real bugs found by its e2e test: rapid
keystrokes raced React state (ref-backed selection `selRef`) and opening under the cursor
let a phantom mouseenter steal selection (mousemove-based highlight, :hover rule removed);
:focus-visible outlines, aria-live toast, aria-pressed toggles, Space on cards,
prefers-reduced-motion; mobile 32px touch targets (pointer:coarse), grab-handle hit area,
no autofocus on touch (FINE_POINTER), placeholder ellipsis, days-remaining never
truncates; failed sends restore the draft (send() returns boolean, composer refills),
double-submit guard (sendingRef), "Copied ✓" feedback, document.title follows the open
project. e2e/polish-shots.spec.mjs = screenshot pass (SHOTS=1, skipped in CI). 224 node +
14 Playwright.

PROJECT DELETION + 7-DAY RECOVERY (2026-07-31, PRs #71/#72/#73, deployed + live-proven):
Home cards carry an X → confirm modal → SOFT delete (`ca_conversations.deleted_at`,
migration `soft_delete`): the project leaves Home instantly, keeps all data, and every
normal access path 404s because list/get/messages/events all pass through the filtered
`getConversation` (deleted ⇒ null ⇒ 404 — no per-route checks to forget). Recently Deleted
section on Home (collapsed toggle, existing design language) shows title/deleted date/days
remaining with owner-scoped Restore (single action, `POST /:id/restore`, row returns
exactly as before) and Delete Now (`DELETE /:id?permanent=1` → the owner-checked
`deleteConversationCascade`: provisiond stop/unpublish, entities, app users + synthetic
auth accounts, domains, published site, build history, project row, product memory when
orphaned, conversation LAST so failures never fake success; every permanent deletion logs
an `audit: project_permanent_delete` JSON line). `deletedProjectSweeper` purges past-window
rows hourly through the same cascade. Cascade/purge reach hidden rows via internal
`*IncludingDeleted` store accessors — public reads stay filtered. CRITICAL FIX FOUND BY
THE LIVE PROOF (PR #73): `return handleX(...)` inside the dispatcher's try/catch does NOT
catch the handler's async throw (try exits before rejection), so handleConversationGet's
404 crashed the whole shell — all 55 dispatches are now `return await handleX(...)` with a
source-guard test. Tests: 224/224 node (12 deletion incl. hide/block/restore-exact/
delete-now/cleanup-expiry/cross-owner) + 12/12 Playwright (full workflow); prod lifecycle
curl-proven end to end.

THE CONSOLE MERGE (2026-07-31, Stuart's final consolidation directive, PR #55, deployed):
**there is now exactly one Thrallo application** — /console is deleted (old bookmarks land
home) and every former console capability lives natively in the conversation-first app,
redesigned around user goals rather than ported: the Settings sheet is the one settings
experience with drill-ins for what must live there (AI connection incl. BYOK keys + the
Codex device flow + smart routing + provider health/comparison; API tokens; Downloads —
secrets never enter the conversation); summonable token-styled views in
`shell/web/src/manage/` (RepositoriesView — GitHub App connect, index progress/reindex,
per-repo drill-in where old per-agent policies became repository policies, open PRs whose
[Review] sends a sentence, per-repo automations, code/symbol search; UsageView — meters,
spend guards, plan switch/portal, records; OpsView — admin telemetry; RunOverlay — live
timeline, artifacts, full approval machine); and the `open_view` capability makes
conversation the entry point ("Show me my repositories" → the view opens instantly, Lead
narrates one line — LIVE-PROVEN in production). The agents CRUD workspace, dashboards, and
manual run launching were dissolved, not ported. Net −800 LOC. The desktop ships this same
unified bundle. Verify 197/197 + 8/8; every surface screenshot-reviewed.

Phase 24 (v2) — Buildr101 retirement + cleanup — is in progress (2026-07-31), with
everything not gated on Stuart complete: **workspace context** (Stuart's final principle)
is live end-to-end — the desktop extension streams active file/selection/diagnostics to the
conversation panel (debounced bridge in `editor/vscode/extension.js`), the composer shows a
dismissible context chip, `postUserMessage` accepts a sanitized bounded `workspaceContext`
(`sanitizeWorkspaceContext` in leadAgentService), the model turn carries it as a marked
suffix while the visible thread stays the user's words with a "⌁ shared file" line.
**Retirement step 3 done**: final validated Supabase export of qgemqjcyhuejrsvjxkbh stored
off-box (`C:\Users\Administrator\buildr101-final-export-2026-07-31.tar.gz`, 33 tables, 109
auth users). **Repo cleanup done**: the legacy Buildr HTTP surface (71 handlers across 29
route modules — generate/builds/billing/templates/connectors/runtime/android/qa/owner
console/…) is unmounted from `shell/server/index.mjs` (route FILES remain where Thrallo
imports pieces, e.g. `slugify` from routes/publish.mjs); the orphaned Buildr web UI is
deleted (builder/, legal/, TopBar, BillingPanel, SettingsPanel, lib/api.js + friends —
verified importer-free first). `/console` is KEPT deliberately: AI connection, API tokens,
repos, reviews, automations management still live there until conversational parity.
Deployed 2026-07-31 and live-verified: Thrallo surfaces all 200, buildr101.com and
focusflow.app.thrallo.com unaffected, legacy `/api/generate` properly 404. LIVE
context proof: a production message carrying workspaceContext (file/selection/diagnostic)
got a Lead Agent reply that named the file, quoted the selection, and explained the
warning — nothing pasted by the user. Remaining steps are Stuart-gated (YOU_NEED_TO_DO.md
§Phase 24): stop the Meta ad, audit/cancel Stripe subs → then freeze, reboot test, stop
buildr-* services, retire monitoring/email. **Desktop packaging waits for this phase to
complete (Stuart's instruction).**

Phase 23 (v2) — Thrallo Desktop adopts the conversation surface — is built and
smoke-proven (2026-07-31): the desktop's primary view is the SAME built web bundle as
app.thrallo.com, hosted by the builtin extension in a webview running in desktop mode
(`editor/vscode/lib/conversationPanel.js` — asset-URI rewrite, strict CSP with a nonce for
the injected bootstrap, `window.__THRALLO_DESKTOP__` = {server, PAT}); it auto-opens on
startup in the Thrallo fork only, shows a one-action connect prompt without a token, and
re-renders on reveal after connecting. Desktop-mode seams in the web bundle are inert on
the web (accessToken → injected PAT, apiBase prefix, synthesized session). CORS now allows
VS Code webview origins (bearer-only API — verified live with a preflight). Build plumbing:
`syncBuiltin`+`syncWebApp` run before every dev/compile/package and always travel together
(the prepare marker hashes the COMMITTED tree — uncommitted extension work never reached
the builtin otherwise; the builtin copy wipes media/app). Desktop smoke has a STRICT sixth
check (the Begin screen must render inside the webview; connect-prompt-only fails) — dev
build passed 6/6 against live production. Three real defects found via that loop: CSP
blocking the inline bootstrap (nonce), stale builtin, wiped bundle. PRs #51/#52, verify
194/194 + 8/8 + smoke 6/6. **NO PACKAGING — awaiting Stuart's Phase 23 desktop review;
then Phase 24 (Buildr101 retirement, strict ops order).**

Phase 22 (v2) — publish, domains, notifications, automations as conversation — is live and
proven (2026-07-30/31): `appBuild/appPublishService.mjs` (lean conversational publish:
unique slug collision-checked against the shared publish root, real production build, ship
to Thrallo provisiond, `published_sites` record) + `connectDomain` (custom_domains row +
provisiond symlink; ask gate approves the domain immediately, A-record instructions
returned). `notifications/`: dependency-free web push (RFC 8291 aes128gcm + RFC 8292 VAPID
ES256 — proven by receiver-side decryption in tests), Resend email adapter dormant until
`THRALLO_RESEND_KEY`, `notifyOwnerIfAway` skips channels while anyone streams the
conversation; wired to preview_ready/build-failure/question_asked/publish. Capabilities
`publish` / `configure_domain` / `create_automation` registered (registry only). Ask gate +
`ops/Caddyfile.unified` extended for `*.app.thrallo.com` (on-demand certs) + Thrallo custom
domains. Shell renders `published` receipts; settings sheet has the single notifications
row; `public/sw.js`. Migration `app_publish_platform` applied; backups extended. LIVE
PROOF: "Publish this, please." in the FocusFlow conversation → Publisher choreography
(Building → Uploading → Going live) → **https://focusflow.app.thrallo.com/ HTTP 200, LE
cert minted on demand**; "Every week, check…" → Lead Agent created a real scheduled_task
automation via create_automation (deleted after proof so it never spends unattended);
notifications config live (webpush on, VAPID keys in prod env; email off pending Resend
key). OPS NOTE: `docker restart buildr-caddy` can fail on a reaped preview network — the
fix IS the P19 design: restart `thrallo-provisiond`, whose boot ensureCaddy rm-f's and
re-raises the front byte-identically (proven live; ~30s outage). PRs #49/#50, verify
191/191 + 8/8. **Awaiting Stuart's Phase 22 review before Phase 23 (desktop conversation
surface) and Phase 24 (Buildr101 retirement).**

Phase 21 (v2) — the conversation-first production UI — is live at https://app.thrallo.com/
(the console is preserved at /console during the transition; /design keeps the wireframes):
`shell/web/src/chat/` — ChatShell (Begin → thread → living rail with preview dominance →
settings sheet → ⌘K palette; mobile team strip + full-screen preview sheet),
`conversationState.js` (pure reducer: thread/roster/rail derive from
ca_conversation_events replay + live SSE `after`-resume — tested against the real Phase-19
production stream), escaped-first markdown, canonical tokens (light default + dark).
Permanent UI is exactly the four; the rail's Publish action just posts a sentence to the
Lead Agent. Real defect fixed en route: CSP `frame-src` still only allowed buildr101
domains — Thrallo preview iframes would have been blocked (httpSecurity.mjs). Playwright
converse→team→preview flows run at desktop+mobile with a stubbed API + seeded session
(e2e/chat-shell.spec.mjs; skips without local auth env; test:ui includes it). PR #47,
main `a471518`, verify 186/186 + 8/8. **Awaiting Stuart's production UI review — the
Phase 21 gate — before Phase 22 (publish/automations/notifications as conversation).**

Phase 20 (v2) — design system + wireframes — is implemented and live at
https://app.thrallo.com/design/ (static, unlinked, noindex): `docs/DESIGN.md` is the
experience brief (permanent UI = exactly conversation + living agent rail + preview +
settings sheet; the rail is ONE surface with three states empty→team→team+preview; preview
is the hero; approvals/questions are in-thread cards; ⌘K hides the power; explicit removals
listed), canonical tokens at `shell/web/src/theme/tokens.css` (light default + dark, violet
accent + specialist hues, Space Grotesk/Manrope — NOT imported by App.jsx yet), and a
self-contained clickable prototype at `shell/web/public/design/` (four scenes incl. an
auto-choreographed Build→Preview replay of the real Phase-19 event vocabulary, mobile
frames, settings sheet, palette, publish flow, dark toggle; token parity + self-containment
guarded by test). PR #44, main `2141c82`, verify 179/179. **Awaiting Stuart's wireframe
approval — the Phase 20 gate — before Phase 21 builds the production UI.**

Phase 19 (v2) — app builds on Thrallo infrastructure — is implemented and live-proven
(2026-07-30): the Buildr generation pipeline runs entirely on Thrallo. `projects` +
`build_jobs` live in Thrallo's own Supabase (service-role only); the legacy credit ledger is
replaced by `appBuild/budgetLedger.mjs` (Thrallo budgets behind the legacy ledger interface,
spend recorded as standalone usage rows `kind: app_build`); `appBuild/openaiEngineProvider.mjs`
gives the engine its `runTurn` contract over the OpenAI Responses API (managed key), with
`buildContext.mjs` resolving BYOK (Anthropic via routing provider / owner's OpenAI key) per
owner. The engine is exposed ONLY through the Capability Registry as `app_build`
(`appBuildService.mjs` relays build phases as the staged Planner/Designer/Builder/Tester/
Publisher team and fires `preview_ready` unprompted). Preview infra: a second, Thrallo-owned
provisiond instance (`ops/thrallo-provisiond.service`, port 8791, own token, suffix
`preview.thrallo.com`), the shared Caddy front re-homed to the Thrallo-owned
`ops/Caddyfile.unified` (adds `*.preview.thrallo.com` on-demand TLS; deployed byte-identical
to /home/ubuntu/provisiond/Caddyfile.tls AND /home/ubuntu/code-agent/provisiond/Caddyfile.tls —
replace IN PLACE, the bind mount is by inode, and `admin off` means `docker restart
buildr-caddy` to apply), and the ask gate re-homed onto Thrallo's shell
(`routes/previewDomainCheck.mjs` + provisiond `/exists`: preview labels validated against
real containers so strangers can't mint certs; everything else passes through to the frozen
Buildr101 gate so customer domains keep renewing). Live proof: conversation "Build me a
pomodoro timer" → Lead Agent discovered `app_build` via the registry → 27-file FocusFlow app
generated (tree/design persisted server-side) → Let's Encrypt cert minted on demand →
https://pa12f1def1d17432b8d6facc8d785ea37.preview.thrallo.com/ served HTTP 200 → usage row
(gpt-5.6-sol, 48,493 in / 6,771 out, managed) recorded against Thrallo budgets. Buildr101
production (Supabase qgemqjcyhuejrsvjxkbh, its provisiond :8790, Stripe) untouched. PR #42
merged from main `99ef131`; migration `app_build_platform` applied; verify 177/177. NOTE:
previews use per-label on-demand certs (the Cloudflare token only covers the buildr101.com
zone) — Let's Encrypt caps ~50 new certs/week per registered domain; fine now, revisit with a
thrallo.com DNS token (wildcard DNS-01) before launch scale. **Awaiting Stuart's Phase 19
review before Phase 20 (design system + wireframes, Stuart gate).**

Phase 18 (v2) — the conversation platform — is implemented and live: Capability Registry
(the Lead Agent's tools are generated from it; extension proven by test), the durable Lead
Agent loop with specialist lifecycle events over resumable conversation SSE, the three-layer
Memory System (encrypted owner profile, named products, episodic memories), run
dispatch/relay, budget metering, stale-thinking recovery, and a temporary chat pane in the
existing console. Live production proof on 2026-07-30: a real conversation invoked
get_status (accurate live run states and budget numbers) and remember (product persisted to
ca_products/ca_memories), replying in plain English. One live-verification fix (#40):
strict tool schemas need all-properties-required with nullable optionals. Deployed from main
`bd5280a`; migration `conversation_platform` applied (6 service-only encrypted tables).
Phase 18 was approved and Phase 19 built on it directly.

Prior state: Phase 17's Code - OSS Thrallo Desktop reached its first verified Windows
milestone (dev + packaged builds 5/5 smoke-verified). Phase 12's automatic PR reviews are
active: the GitHub App subscribes to `["pull_request", "push"]`. The Phase 1 vertical slice includes the control-plane data model, v1 API, worker, commercial
OpenAI/Anthropic tool loop, Daytona runner, GitHub App installation flow, durable run artifacts,
usage metering, stale-run recovery, retry, signed GitHub webhooks, approval-gated commit/push/PR
publishing, and the new web workspace. Phase 2 adds a private, idempotent webhook-delivery ledger,
atomic background claims, exponential retry, crash recovery, and authoritative synchronization of
GitHub installation and repository-access lifecycle events. The product is branded Thrallo and the public repository
is `https://github.com/stuart3190/code-agent`. The production repository-to-pull-request proof
completed on 2026-07-29 as PR #2, including Daytona execution, explicit publication approval,
GitHub branch push, pull-request creation, and passing GitHub Actions verification. Phase 3 adds
encrypted per-user Codex device sign-in, OpenAI and Anthropic BYOK, managed-provider selection,
and isolated Codex subscription execution. Phase 4 adds bounded incremental repository scanning,
AES-GCM encrypted paths and source excerpts, scoped HMAC exact-code lookup, 1536-dimension OpenAI
embeddings, database-side hybrid ranking, owner-authenticated code search, and relevant context
injection before agent execution. Phase 5 adds encrypted language-aware definitions and signatures,
imports/calls/references/inheritance relationships, file dependency graphs, definition/reference
search, live indexing progress, durable manual refreshes, GitHub default-branch push refreshes, and
symbol-map context injection before agent execution. Phase 6 adds Gemini Interactions API support,
quality/balanced/fast/economy/manual model profiles, task-aware routing, retryable-error fallback,
provider latency and reliability health, encrypted provider evaluations, Gemini BYOK, and routing
and comparison controls in Settings. Phase 7 adds Free/Starter/Pro subscription plans, monthly
managed usage budgets (runs and sandbox compute for every run, managed tokens for managed-key
runs) enforced at run creation, worker claim, and mid-run, personal spend guards, billing-source
usage tagging, dormant `THRALLO_STRIPE_*` checkout/portal/webhook wiring that stays disabled
until pricing is approved, the Usage & billing workspace view, and the `ADMIN_EMAILS`-gated
`/api/v1/ops/telemetry` Operations view. Phase 8 adds per-agent publish policies
(require-approval or auto-publish with protected-path globs that force approval), sandbox
preservation on failure with linked resume runs that re-attach the same workspace and branch
(clean-baseline fallback on expiry), and private Supabase Storage artifact offloading with an
authenticated content route. Phase 9 adds per-agent sandbox network policies (offline blocks
egress after checkout, restored only for publishing; relaxed with a warning for Codex runs),
restricted command policies in the tool loop (in-sandbox publication always refused),
per-owner concurrent and hourly run admission caps, past-due metering at free-plan limits,
and a retention sweeper pruning run timelines and artifact content after
`CODE_AGENT_RETENTION_DAYS`. Phase 10 adds hashed personal access tokens (session-managed,
never operator-capable) authenticating the v1 API for editor clients, token management in
Settings, a real Downloads view, and the zero-dependency `editor/vscode` extension with an
agents view, run launching, live timeline streaming, diff review, approve/decline
publication, and resume. Phase 11 adds repository-aware pull-request review agents: PR head
checkout in the sandbox, a read-only review toolset that can still run tests, structured
findings (verdict/severity/line anchors), review artifacts, a Reviews workspace view listing
open PRs, and approval-gated posting of the GitHub review with conservatively mapped verdicts
and inline comments. Phase 12 adds automations: webhook-triggered reviews of new pull
requests (draft filtering, explicit autoPost opt-out of the approval gate) and scheduled
maintenance runs every 1–168 hours via an optimistically claimed sweeper, all passing the
same budget and rate-limit admission with run provenance and recorded skips. Phase 13 adds
the `thrallo` CLI: token login with 0600 config, run/review launching with streamed timelines
and interactive (or `--yes`) approval, plus repos/agents/usage/status/resume/cancel, built on
the shared zero-dependency API client. Phase 14 adds disaster recovery: nightly validated
backups of every control-plane table, auth users, and the artifact bucket under
`thrallo-backup.timer`, a migration-drift-guarded table list, a confirm-gated FK-ordered
restore script, and the `docs/DISASTER-RECOVERY.md` runbook (offline kit: `shell/.env` with
`PLATFORM_ENC_KEY` plus a copied backup run — a Stuart action). Phase 15 makes the VS Code
extension marketplace-ready — generated PNG icon, license, changelog, gallery metadata, a
proven `thrallo-0.2.0.vsix` package build — and adds inline run status: a live status-bar
indicator during runs and per-agent latest-run states with themed icons in the Agents view.
Marketplace publication is a documented Stuart action. Phase 16 adds opt-in inline code
completion: `POST /api/v1/completions` (fill-in-the-middle on the fastest configured tier,
enriched with encrypted-index excerpts, budget-gated for managed calls, standalone-metered,
per-owner rate-limited, Codex falling back to managed) and the extension's debounced
cancellable provider behind `thrallo.completions.enabled` (repository auto-detected when one
is connected), shipped as `thrallo-0.3.0.vsix`.

## Verification state

- `npm run verify` passes locally and in GitHub Actions.
- Dedicated Supabase project `Code Agent` (`zczgvcsokfafuyognvwx`) is active and healthy in
  organization `nuzfrbtaqkoemvdajzfh`, region `eu-west-1`.
- The eleven Code Agent migrations are applied remotely. The repository index, intelligence, routing telemetry,
  and encrypted evaluation tables have restrictive
  RLS and no browser grants; hybrid search is executable only by the service role. All control-plane
  tables have RLS. Browser roles have
  no webhook-ledger or AI-credential grants, owner-readable policies reject anonymous identities, and
  Performance Advisor reports no missing foreign-key indexes. Unused-index info notices are
  expected until the young project receives traffic.
- The project URL and publishable key are configured in the ignored local environment files.
- The ignored local environment now has verified Supabase, Daytona (`eu` target), and OpenAI
  credentials. Paid inference is verified against `gpt-5.6-sol`; reasoning effort is explicitly
  configurable and currently set to `medium`.
- Production target: the existing Buildr101 VPS, isolated as `/home/ubuntu/code-agent`, systemd
  service `thrallo-shell`, private port `8788`, and public origin `https://app.thrallo.com`.
- Production service and Caddy routes were installed on 2026-07-29. Internal `/api/health` and
  `/api/v1/capabilities` are green, and Buildr101 remained healthy after the proxy reload.
- Phase 3 was deployed from main commit `8539b2f` on 2026-07-29. Production reports encrypted credential
  storage, Codex device login, and BYOK as enabled. A real app-server device flow and the complete
  authenticated start/cancel HTTP route both returned `auth.openai.com` and cleaned up successfully.
- Phase 4 repository indexing is deployed on 2026-07-30. A paid
  `text-embedding-3-small` call returned one 1536-dimension vector, the database hybrid-search
  transaction returned the expected match, and the production repository index/search route is
  verified against `stuart3190/code-agent`.
- Phase 5 repository intelligence is deployed on 2026-07-30. Definitions, relationships, dependency
  graph routes, manual refresh queue, progress reporting, and agent symbol-map retrieval are
  implemented with encrypted-at-rest source metadata and service-only graph tables. Production
  indexed main commit `2788881` into 353 files, 572 context chunks, 1,925 definitions, 33,441
  relationships, and 849 dependency edges; exact definition lookup and forward/reverse file
  dependencies were decrypted successfully through the server-only retrieval layer.
- Phase 6 smart model routing is deployed from main commit `6d78771` on 2026-07-30. Production
  advertises the OpenAI Sol/Terra/Luna tiers, current Claude and Gemini catalogs, managed OpenAI
  availability, and optional BYOK for OpenAI, Anthropic, and Gemini. The full local verification
  suite passed with 63 Code Agent tests and four desktop/mobile Playwright checks. Supabase
  verification confirmed RLS enabled, no anon/authenticated table access, and service-role access
  for routing attempts and encrypted evaluation records.
- Phase 7 subscriptions, budgets, and telemetry are deployed from main commit `2fca243` on
  2026-07-30. The `subscriptions_budgets_telemetry` migration is applied remotely with RLS
  enabled, zero browser grants, a restrictive deny policy, the partial Stripe-customer unique
  index, the `billing_source` usage column, and the run-state telemetry index; the security
  advisor reports only the pre-existing leaked-password notice. Production capabilities
  advertise the three plans (free approved, paid pending pricing), budgets, and operational
  telemetry; `/api/v1/billing/webhook` answers 501 while dormant and the billing and ops routes
  require authentication. `ADMIN_EMAILS` is set to Stuart's account so the Operations view is
  visible to him. Local verification passed with 84 Code Agent tests and four Playwright checks,
  and Buildr101 stayed healthy after the restart.
- Phase 8 publish policies, sandbox resume, and object-storage artifacts are deployed from main
  commit `9364b8f` on 2026-07-30. The `approval_policies_resume_artifacts` migration is applied
  remotely and verified: the policy and resume columns exist, the private `thrallo-artifacts`
  bucket exists with storage RLS enabled and zero browser policies. Production capabilities
  advertise approval policies, auto-publish, protected paths, resume, and artifact storage; the
  full local verification passed with 97 Code Agent tests and four Playwright checks, and
  Buildr101 stayed healthy after the restart.
- Phase 9 egress/command policies, rate controls, and retention are deployed from main commit
  `7ddef64` on 2026-07-30. The `egress_command_policies_retention` migration is applied
  remotely and verified (policy columns, `pruned_at`, partial retention index). Production
  capabilities advertise network policies, command policies, rate limits, and 90-day
  retention; the full local verification passed with 105 Code Agent tests and four Playwright
  checks, and Buildr101 stayed healthy after the restart.
- Phase 10 API tokens and the VS Code extension are deployed from main commit `72a840a` on
  2026-07-30. The `api_tokens` migration is applied remotely; production capabilities
  advertise API tokens and the extension, the token routes require authentication, and
  Buildr101 stayed healthy after the restart. The full local verification passed with 114
  Code Agent tests and four Playwright checks.
- Phase 11 review agents are deployed from main commit `7c15810` on 2026-07-30. The
  `review_runs` migration is applied remotely; production capabilities advertise pull-request
  review and approval-gated posting, and Buildr101 stayed healthy after the restart. The full
  local verification passed with 122 Code Agent tests and four Playwright checks.
- Phase 12 automations are deployed from main commit `0d1203f` on 2026-07-30. The
  `automations` migration is applied remotely; production capabilities advertise
  pull-request-review automations, scheduled tasks, and autoPost; the automations routes
  require authentication; Buildr101 stayed healthy after the restart. The full local
  verification passed with 130 Code Agent tests and four Playwright checks. Automatic PR
  reviews activate once the GitHub App subscribes to the Pull request event (Stuart action).
- Phase 13's CLI is deployed from main commit `c1f6b3f` on 2026-07-30 (no migration). The
  shell restarted healthy, `node cli/thrallo.mjs help` works on the production checkout, and
  Buildr101 stayed healthy. The full local verification passed with 136 Code Agent tests and
  four Playwright checks.
- Phase 14 disaster recovery is deployed from main commit `ee861b8` on 2026-07-30 (no
  migration). `thrallo-backup.timer` is installed and active on the VPS, the first real
  production backup succeeded and self-validated (25 files, every ca_ table plus auth users
  and the artifact bucket, ~14 MB gzipped), and the dry-run restore re-validated the run end
  to end. The full local verification passed with 140 Code Agent tests and four Playwright
  checks, and Buildr101 stayed healthy. The offline DR kit (shell/.env + a copied backup run)
  is a pending Stuart action in YOU_NEED_TO_DO.md.
- Phase 15's marketplace-ready extension is deployed from main commit `99dca33` on 2026-07-30
  (no migration; web Downloads copy updated). The `thrallo-0.2.0.vsix` package build is
  proven, the shell restarted healthy, and Buildr101 stayed healthy. The full local
  verification passed with 141 Code Agent tests and four Playwright checks. Marketplace
  publication (publisher account + vsce publish) is a documented Stuart action.
- Phase 16's inline completion is deployed from main commit `ad2129f` on 2026-07-30 (no
  migration). Production capabilities advertise `editor.inlineCompletion`, the completions
  route requires authentication, the shell restarted healthy, and Buildr101 stayed healthy.
  The full local verification passed with 148 Code Agent tests and four Playwright checks.
- The first production dogfood session completed on 2026-07-30: a CLI-launched run (PAT auth)
  executed via the Codex subscription, opened PR #35 adding the CLI `version` command, passed
  CI, triggered the pull-request-review automation via the live webhook (the reviewer ran the
  CLI tests itself, 8/8), had its review approved and posted to GitHub, and merged. Three
  rough edges surfaced and were fixed and deployed from main commit `fc0e50d`: the CLI's
  Windows exit crash (process.exitCode), prompt-sliced pull-request titles (synthesizeTitle),
  and publication copy shown for review-run approvals in the Agents workspace. The
  `claude-dogfood` API token and the repository's pr_review automation remain active.
- Thrallo Desktop reached its first verified milestone on 2026-07-30, on Windows, against the
  pinned Code - OSS 1.131.0 commit `3a03d6f7`: toolchain installed (MSVC 14.44 + Spectre
  libs + Python 3.12), `npm ci` and full compile clean, and the dev build's `Thrallo.exe`
  passed a 5/5 Playwright-driven smoke test — branded window, real local folder, file edit
  persisted to disk, integrated terminal executed a command, and the built-in Thrallo
  extension signed into production with an API token and listed live agents with run states
  in the THRALLO: AGENTS view (screenshots under desktop/out/smoke, gitignored). The
  packaged unsigned win32 build also completed and passed the same 5/5 smoke test as
  "Thrallo Desktop" (`desktop/VSCode-win32-x64/Thrallo.exe`, archived to
  `desktop/out/thrallo-win32-x64.zip`, 263.8 MB); getting there surfaced and fixed four real
  packaging constraints, one found by Thrallo's own automated review of this PR (no
  vscode-*-archive gulp task; quality=stable requires proprietary win32ContextMenu config;
  signtool needed on PATH for signature STRIPPING only; the upstream copilot builtin removed
  plus a guarded tolerance patch). VERIFIED: everything above, on Windows. CONFIGURED BUT
  UNVERIFIED: darwin/linux targets — macOS stays "Coming soon" in all public copy until
  Stuart approves. Nothing is signed, notarised, or store-published, and no paid accounts
  were created. No installer beyond the archive exists yet (Inno Setup integration is future
  work).
- Cloudflare DNS and automatic TLS are live. `https://thrallo.com` and `https://www.thrallo.com`
  redirect to `https://app.thrallo.com`; the public SPA, health endpoint, and capabilities endpoint
  all pass externally.
- The private `Thrallo Code Agent` GitHub App is installed on `stuart3190/code-agent`. App
  authentication, short-lived installation tokens, signed webhook delivery, repository discovery,
  branch push, and pull-request publishing are verified in production.
- Phase 2 production proof completed on 2026-07-29 using a real `installation.created` redelivery.
  Delivery `b715b380-8b85-11f1-8dbe-4622a495bc7e` was stored once, processed in one attempt,
  refreshed installation `149918583`, and confirmed one accessible repository. A second
  redelivery kept the ledger at one row and one processing attempt.
- The first live run exposed and fixed Daytona writable-workdir, untracked-file diff, and
  post-refresh run-restoration defects. The fixes are tracked in PR #1 and deployed.
- Never reuse Buildr101 production Supabase, Stripe, or provider secrets for this product.

## Builder v2 (2026-08-05/06)

The app-build pipeline rebuild. Canonical docs, read in order: `docs/BUILDER-V2-MASTER-PLAN.md`
(architecture, approved with corrections C1-C8), `docs/BUILDER-V2-FINISH-PLAN.md` (execution,
WP-1…WP-19), `docs/BUILDER-V2-HEADTOHEAD.md` (measured v1-vs-v2 results). Code lives in
`shell/server/lib/builderV2/` — orchestrator (first-green loop + repair tiers), patch engine
(strict `emit_patches`: symbol ops, `add_import`, `replaceFile`), indexer (`indexer.mjs`
facade = v1 on @babel/parser; v0 is the floor), retrieval (hard-budget slices), verification
facade + differential planner, capability registry/lints, asset service (Part 18: intents,
cache-first, licence-stamped, sharp variants), model lanes (one shared ceiling per job,
per-step reasoning routing), shadow (WP-14), rollout guard rails (WP-16).

State: WP-1..14 engineering DONE; gates WP-9 (simple, 1.73cr green) and WP-10 (edit, 1.64cr
green) passed; WP-11 booking parked at 13.58cr/3 attempts (v1 spent 102.9/3 on the same
prompt) — attempt 4 awaits Stuart. Shadow week started 2026-08-06 (`bv2.shadow` on; daily
`ops/bv2-shadow-drift.mjs` via the VPS `bv2-drift.timer`); the managed-settlement unpause
audit happens ONLY at its end (~08-13). Flags: `bv2.enabled`/`bv2.owners` off (customer
traffic stays v1), `THRALLO_BV2_KILL=1` is the absolute off switch. Runners:
`ops/bv2-first-build.mjs`, `ops/bv2-edit.mjs`, `ops/bv2-booking-build.mjs` (all `--live`
gated — NO paid run without Stuart), `ops/bv2-dual-run.mjs` (zero-credit comparator).
Diagnostics: v2 runs appear in DiagnosticsView with a Builder v2 panel (per-step spend,
snapshot lineage, pointers) via `/api/v1/diagnostics/:id/bv2`.

## Next implementation slice

Phase 24 completion: Stuart's steps 1-2 (Meta ad, Stripe audit — YOU_NEED_TO_DO.md), then
my steps 4-7 (freeze, reboot test, stop buildr-* services, retire monitoring/email), then
desktop packaging. Deeper src/ pruning of buildr-only modules is deferred until after the
services stop (some legacy prove-harnesses still exercise them). Roadmap substitutions
require asking Stuart first.

User-owned setup and billing actions are tracked in `YOU_NEED_TO_DO.md`. Flipping paid plans
live is Stuart-owned: approve prices, create the dedicated Thrallo Stripe products and webhook,
and set the `THRALLO_STRIPE_*` environment.

## Important boundaries

- Browser: publishable Supabase key only.
- Shell: auth verification and owner-scoped control-plane API.
- Worker: service role, model keys, GitHub installation tokens, Daytona credentials.
- Sandbox: receives only the minimum short-lived clone credential and, for a Codex-selected run,
  a private temporary Codex auth file that is deleted before the workspace is preserved or discarded;
  it never receives the platform service role or encryption key.
- Imported Buildr generation routes remain in the server temporarily for compatibility but are not
  linked from the Thrallo UI. Remove them as the standalone control plane absorbs shared needs.
