# BUILDER V2 — END-TO-END FINISH PLAN

Authored 2026-08-05, immediately after the foundations landed. This is the EXECUTION
schedule from the current, verified state to Builder v1's retirement. The architecture,
schemas, APIs and acceptance rules live in `docs/BUILDER-V2-MASTER-PLAN.md` (approved,
corrections C1-C8); this document sequences the remainder, marks every point where money
can be spent, and defines "finished". An agent executes work packages top to bottom; no
package starts before its dependencies' exit criteria are met.

## STANDING RULES (unchanged, non-negotiable)
- `THRALLO_MANAGED_SETTLEMENT_PAUSED=1` stays until WP-14's audit passes.
- NO model-powered build/fixture without Stuart's explicit approval — every spend point
  below is marked **SPEND GATE** and stops for approval.
- Builder v1 untouched until WP-18; all v2 work additive and flag-gated; `THRALLO_BV2_KILL=1`
  is the absolute off switch.
- Every commit: full node suite green (1,070 as of tonight) + its own new proofs; deploy =
  archive→scp→web build→restart→smoke 31/31; CI green; pause flag re-verified.
- Hard stops (C7): migration drift · tenant-isolation mismatch · incomplete backup coverage
  · memory/Supabase parity failure · snapshot atomicity failure.

## CURRENT STATE (verified in production)
DONE: master plan; `builder_v2_foundation` migration APPLIED (17 tables, select-smoked);
backup/restore/teardown guards extended; feature flags + kill switch; project knowledge +
byte-stable brief; Indexer v0; memory graph store; atomic snapshot store (C1/C2 proven);
retrieval engine (hard budget, traced); `ops/bv2-replay.mjs` green ON the VPS over both
committed production-tree fixtures. NOT STARTED: everything below.

---

## THE WORK PACKAGES

**WP-1 — Supabase twins + parity (plan I/J).** Zero credits. ~1 session.
Scope: `graphStore.supabase` and `snapshotStorage.supabase` implementing the exact memory
APIs; parity suite runs every existing graph/snapshot test against BOTH twins (parity
failure = hard stop); `ops/bv2-replay.mjs` gains a `--supabase` mode exercising prod tables
under a dedicated test owner, cleaned up after. Exit: parity green locally AND on the VPS;
prod rows created/GC'd under the test owner only. Rollback: tables truncate for the test
owner; modules unused by runtime.

**WP-2 — Structured patch engine (V2-09).** Zero credits. ~1 session.
Scope: `patchEngine.mjs` + `emit_patches` strict tool schema; validation via Indexer v0
(symbol exists / content parses / imports resolve / modularity holds); machine-readable
rejection; escalation to whole-file after 2 rejects of one op; bv2_patches rows. Proof:
every op type against `run17b6513f-tree.json`; synthetic cancel-confirmation patch passes
D0-D2 locally. Exit: suite green. Depends: WP-1 (patch rows persist).

**WP-3 — Verification facade + differential planner (V2-10/11).** Zero credits. ~1 session.
Scope: `verification.mjs` (one API over the EXISTING gates, D0-D4, owning-module
attribution mandatory on D3 fails); `diffPlanner.mjs` + bv2_verification_cache
(owners_hash from the graph). Proof: facade verdict parity with v1 gates on both stored
trees; verify-twice replay drives 0 journeys the second time and SAYS so (`reused` rows).
Depends: WP-1, WP-2.

**WP-4 — Capability kernel (V2-12).** Zero credits. ~1 session.
Scope: scaffold `src/lib/capabilities/` + registry; crud + guest-session (move of proven
visitorSession behind the capability interface, path compatibility kept) + role/ownership;
protected-path + modularity coverage extended; capability suite in the platform tests.
Proof: scaffold compiles; suite green; D1 capability-contract lint skeleton. Rollback:
scaffold additions unused until orchestrator ships.

**WP-5 — Booking-domain capabilities (V2-13).** Zero model credits (live schema proof uses
service role only). ~1-2 sessions.
Scope: booking/availability/conflict-prevention/cancellation + contact + newsletter, each
with version, UI state contract, and tests (atomic capacity race, cancel transition,
newsletter duplicate state). Proof: headless run against the real entities schema under a
test app id. Depends: WP-4.

**WP-6 — Contract tiering + bindings + image intents (V2-14).** Zero credits. ~1 session.
Scope: contract engine emits essential[]/secondary[], capabilities[], imageIntents[];
bv2_contracts writes; deterministic tiering per master plan Part 5; the booking regression
fixture (core green, newsletter+cancel pending → preview ships) encoded as a test.
Proof: recorded-contract fixtures through tiering. Depends: WP-4.

**WP-7 — Asset service (V2-A1..A3).** Zero model credits. ~2 sessions.
Scope: C6 licensing gate first (verify Pexels' CURRENT terms, persist licence snapshots);
provider seam with the Pexels adapter (existing client reused) driven by RECORDED payloads
in tests; bv2_assets cache with never-research rules; sharp-based optimisation into
thrallo-artifacts (dependency in the SHELL only); manifest versioning with snapshots;
selective regeneration; scaffold `src/lib/assets.js` helper. Proof: second resolve of the
booking intents = zero provider calls; selective regeneration touches only selected slots.
Depends: WP-1 (snapshots), WP-6 (intents).

**WP-8 — Orchestrator + shadow entry (V2-15/16).** Zero credits. ~2 sessions.
Scope: `orchestrator.mjs` first-green loop (contract→index→assets→CORE→D0-D2→D3e→green
snapshot→preview gate→increments with differential verify; crash-resume from pointers;
increment rollback; stop rules; per-step budgets through the EXISTING guards);
`app_build_v2` capability behind bv2.enabled+profiles+owners; Lead Agent routing untouched
unless flagged. Proof: deterministic end-to-end with scripted patches + recorded assets →
green landing page, no model; double-dispatch and crash-resume tests; prod deploy flag-off
with zero behaviour change (smoke 31/31). Depends: WP-2..7.

**WP-9 — SPEND GATE 1: first live v2 build (V2-17).** ~0.5 session + approval.
ONE simple build (landing/contact), Codex lane, ceiling 5. Target ≤2 credits first-green
(projected 0.9-1.8). Exit: measured ≤2 OR a written variance analysis before anything else
runs. Rollback: flag off.

**WP-10 — SPEND GATE 2: edit path live (V2-18).** ~0.5 session + approval.
Edit = adopt→retrieve→patch→differential verify; zero-credit replay first, then ONE real
edit, target ≤0.5. Depends: WP-9 green.

**WP-11 — Medium pipeline + the definitive comparison (V2-19/20).** ~1 session + approval.
Medium profile (design pass, per-entity increments, D4 full) + v2 repair tiers
(targeted-via-retrieval, bounded 2, regen escalation; the cancel-feedback defect replayed
as the fixture). **SPEND GATE 3:** ONE booking build on the stored prompt — the v1-vs-v2
head-to-head. Target ≤6 core / ≤9 full vs v1's 24.26/32.65. Depends: WP-9.

**WP-12 — Traces + routing + advanced scripted (V2-21/22/23).** Zero credits. ~1 session.
Trace hierarchy threaded (trace_id/parent_id/step on every v2 event), DiagnosticsView v2
tab, per-step routing table + outcome learning scoped by step kind (lane suites must pass
unchanged), advanced profile as scripted flow only (live advanced is post-rollout).
Depends: WP-8 (+WP-11 for real trace data).

**WP-13 — Indexer v1 (@babel/parser).** Zero credits. ~1-2 sessions. REQUIRED BEFORE WP-16.
Same FileIndex interface; per-file parse keyed by content hash; errorRecovery + permanent
opaque fallback; parity tests v0-vs-v1 on both fixtures (v1 must be a strict refinement:
same or better symbol precision, spans exact); replay updated. Exit: v1 default for v2
paths, v0 kept for tests.

**WP-14 — Shadow week + managed unpause audit (V2-24).** Calendar: 1 week. Zero credits.
Every v1 build shadow-indexes post-completion (fault-injected proof that shadow failure
cannot touch v1). Exit: 7 days clean drift dashboard, THEN the managed unpause audit:
billing reconciliation re-run over the week, zero creditsForUsage↔debit divergence, one
controlled managed build proving the guard arms on the managed lane → **unpause managed
settlement** (the only place this happens). Depends: WP-8.

**WP-15 — Dual-run report (V2-25).** ~1 session + normal traffic. Approval for the run set.
≥5 prompt pairs; archived comparison (cost/turns/green-rate/journey pass-rate). Exit: v2 ≥
v1 green-rate at ≤50% cost, or a written analysis and a fix loop before rollout.

**WP-16 — Limited rollout (V2-26).** Calendar: 1 week. New-project simple builds default v2
for allowlisted owners; per-owner auto-rollback (2 consecutive non-budget failures) and
global auto-off (>20% failed over 6h) live and DRILL-TESTED; one prod project-deletion
drill; one rollback drill. Exit: ≥20 builds, green-rate ≥ v1, cost ≤ targets. Depends:
WP-13, WP-14, WP-15.

**WP-17 — Broad rollout (V2-27).** Calendar: 2 weeks. v2 default for all NEW projects
(simple+medium); existing projects opt-in banner. Exit: 2 weeks stable, support incidents
≤ v1 baseline.

**WP-18 — Builder v1 retirement (V2-28/29).** ~2 sessions after criteria met.
v1 edits adopt-then-v2; projects.tree becomes write-through of the promoted snapshot
(10 legacy projects proven: edit/export/preview parity); tag `builder-v1-final`; DELETE
stagedBuild/stagePlan/contextBuilder-heuristics/engine dead modes/model-driven
search_images (gates/verifier/guards REMAIN — they are v2's); prune superseded tests.
Entry criteria: 14 days zero v1-routed builds + dual-run report archived + tag pushed.
Rollback: revert the tag.

**WP-19 — Post-launch (V2-30..34).** Ongoing, none launch-blocking: cost tuning from real
traces (replace every "projected" figure with "measured"), verification-cache cross-build
promotion, optional Langfuse exporter, live advanced validation, additional asset providers.

## DEFINITION OF FINISHED
1. A new customer's simple/medium build runs v2 by default, first-green, with measured cost
   at or under targets and preview only after essential verification.
2. Managed settlement unpaused with the audit archived.
3. Dual-run report archived showing v2 ≥ v1 green-rate at ≤50% cost.
4. Rollout drills (kill switch, auto-rollback, deletion) executed in production.
5. `builder-v1-final` tag pushed and the v1 orchestration path deleted from main.
6. Cost table in the master plan re-labelled MEASURED from v2 traces.
7. CONTEXT.md §BuilderV2 + memory updated; launch + retirement checklists ticked.

## SEQUENCE AT A GLANCE
WP-1 → WP-2 → WP-3 → WP-4 → WP-5 → WP-6 → WP-7 → WP-8 → [gate] WP-9 → [gate] WP-10 →
[gate] WP-11 → WP-12 → WP-13 → WP-14 (week) → WP-15 → WP-16 (week) → WP-17 (2 weeks) →
WP-18 → WP-19. Estimated hands-on effort: 12-16 agent sessions; calendar floor ~5 weeks
(dominated by the shadow/rollout observation windows). Total projected model spend to
finish: under 25 credits across the three spend gates plus normal rollout traffic.

## SESSION PROMPTS (verbatim starters for the executing agent)
- WP-1: "Execute WP-1 of docs/BUILDER-V2-FINISH-PLAN.md: Supabase twins for graphStore and
  snapshotStorage with memory-parity suites (parity failure is a hard stop), replay
  --supabase mode under a test owner, zero model credits, pause kept, suite green, deploy
  additively, smoke 31/31."
- WP-2..8: same shape — "Execute WP-<n> per docs/BUILDER-V2-FINISH-PLAN.md" (each package
  is self-contained above; the master plan holds the detailed specs).
- WP-9/10/11: "WP-<n> is approved: run exactly one <build/edit> under the stated ceiling
  and targets, then stop and report measured vs projected."
