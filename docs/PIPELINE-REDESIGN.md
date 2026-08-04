# Build pipeline: audit and redesign

Evidence: production diagnostic runs `baa3e8fc` (app_build, failed) and `f00c7950` (repair, failed),
2026-08-04, plus the surrounding 25 runs.

---

## 1. Current pipeline

```
user request
   ↓
Lead Agent  ──▶  app_build capability
   ↓
[Designer]  design direction (visual concept, palette, layout family)
   ↓
[Builder]   initial implementation ── writes the WHOLE project in one turn
   ↓
[Compiler]  npm run build                    ◀── FIRST validation of any kind
   ↓  fail
[Compiler]  capability safety audit (secret scanning, banned APIs)
   ↓
repair round ──▶ [Builder] iterate  ──▶ npm run build  ──▶ fingerprint compare
   ↓  same fingerprint
BLOCKED  → hand the npm error to the customer
```

**What is validated:** `npm run build` exits 0, and a capability safety audit.
**What is never validated:** that the application works. There is no runtime, no journey test, no
persistence check, no interaction check. A build that renders and compiles is "done".

**Checkpoints** exist (`cp-1`…`cp-4`) and are recorded, but nothing rolls back to them.

---

## 2. Root-cause report

### The actual failure, in both runs

```
src/App.jsx (7:129): "Instagram" is not exported by
  ".deps/node_modules/lucide-react/dist/esm/lucide-react.mjs"
```

One icon import. `Instagram` is a brand icon removed from the pinned `lucide-react`. Nothing else
was wrong with either project.

### Why generation produced invalid output

The Builder invented an import that does not exist in the installed version. Nothing checked the
import against the actual module surface — the first time anything looked was `npm run build`,
after the entire 27-file project had been written. There is no export-resolution step, and the model
is given no manifest of what the pinned dependencies actually export.

**This is not a model-intelligence problem.** It is a missing validation: `lucide-react`'s exports
are enumerable at build time, and the check costs milliseconds.

### Why the first repair did not solve it

`baa3e8fc` step 9, verbatim:

> "Removed the unused `Clock`, `Users`, and `Phone` icon imports from `src/App.jsx`, addressing the
> build **quality/lint** failure…"

The repair agent removed three *unused* imports and never touched `Instagram`. It believed it was
fixing a lint problem. The second attempt (`f00c7950` step 7) restored a `window.confirm` call in a
booking-cancellation handler — entirely unrelated to the build error.

**Why:** `f00c7950` step 1 says it outright:

> "…found no compile-time issue in the current source that can be safely changed **without the
> actual Build Diagnostics `baa3e8fc` output**; no files were modified."

The repair brief passed a **reference to the diagnostics**, not the diagnostics. The agent said it
could not see the error, then guessed. Both guesses were plausible-sounding and both were wrong.

This is the single highest-value finding: **the repair agent was not shown the failure it was
repairing.**

### Why the repeated failure was considered unchanged

`shell/server/lib/appBuild/appBuildService.mjs:231`:

```js
if (attempt >= maxAttempts || previousFingerprints.includes(fingerprint)) → blocked
```

The failure fingerprint `ac60a9b42a79f171` was identical across all four builds. The system
*correctly detected* no progress — and then surrendered. `attempt: 2, maxAttempts: 3`: it blocked
**before** exhausting its own budget, because an unchanged fingerprint is treated as terminal.

The rule is right ("do not repeat a patch that changed nothing") and the response is wrong. An
unchanged fingerprint is the strongest possible signal to **escalate to a different strategy**, not
to stop.

### Was the patch applied to active source?

**Yes.** `filesChanged: 1`, `diffChars: 21` then `7`, and the recorded diffs show real edits to
`src/App.jsx` in the live worktree
(`harness/.work/shell-521c8922-…/src/App.jsx`) — the same path the build read. This was **not** a
stale-source or stale-deployment problem. The patches applied cleanly and were simply aimed at the
wrong line.

### What was responsible

| Candidate | Verdict |
|---|---|
| Repair limit too low | **No.** It blocked at attempt 2 of 3, on the fingerprint rule, not the limit. |
| Patch applied to stale source | **No.** Diffs landed in the active worktree. |
| **Repair context** | **Yes — primary.** The brief referenced diagnostics instead of containing the build output. The agent said so. |
| **Missing pre-build validation** | **Yes — primary.** An unresolvable import reached a full build; import/export resolution would have caught it in milliseconds. |
| **Give-up-on-unchanged-fingerprint** | **Yes — secondary.** Correct detection, wrong reaction. |
| Architecture | **Yes — systemic.** One-shot whole-project generation, compile-only validation, no functional verification, checkpoints recorded but never used. |
| Model prompt | Contributory. No dependency-surface manifest is supplied. |

### Two unrelated defects visible in every run

- `connectors: unavailable — Could not find the table 'public.project_integrations' in the schema
  cache` — a table referenced on every build that does not exist.
- `design: photography unavailable (PEXELS_API_KEY is not configured)` — every generated app is
  built without photography, silently.

### On the second complaint — "convincing interface, controls did not work"

Directly explained by the same architecture: nothing in the pipeline ever *runs* the app. The
`plan` column is **null** on both runs — no implementation contract exists, so there is nothing to
verify against even in principle. A button wired to `setState` and a button wired to a database are
indistinguishable to `npm run build`.

---

## 3. Proposed pipeline

```
request
  ↓
CONTRACT      journeys · routes · entities · ownership · operations ·
              integrations · UI states · acceptance tests · deferred
              (persisted; every later stage reads it)
  ↓
PREFLIGHT     foundation selected · dependency graph resolved ·
              EXPORT SURFACE of every pinned dep enumerated ·
              scripts · env contract · runtime feasibility
  ↓
STAGE A  foundation      → static gate → checkpoint
STAGE B  data + server   → static gate + migration check → checkpoint
STAGE C  primary journey → static gate + BUILD + JOURNEY TEST → checkpoint ◀ smallest working app
STAGE D  supporting screens and states → gate → checkpoint
STAGE E  visual refinement → gate → checkpoint
  ↓
HONESTY SCAN  no-op handlers · in-memory persistence · mocked requests ·
              hardcoded data presented as real · dead controls
  ↓
QUALITY GATES build · runtime · workflows · persistence · responsive ·
              a11y · console/network · honesty
  ↓
publish
```

**Failure path**, replacing the current one:

```
failure → CLASSIFY (14 documented classes)
        → TIER 1 deterministic local fix   (syntax, imports, exports, scripts)
        → TIER 2 dependency/config repair
        → TIER 3 regenerate the broken module
        → TIER 4 regenerate the feature from its contract
        → TIER 5 roll back to last green checkpoint, rebuild differently
   each tier: PATCH VERIFICATION — did the intended file change? did the
   fingerprint move? a no-op or unchanged signature ESCALATES a tier
   rather than ending the run
```

Key inversions from today:

1. The repair brief **contains** the command, full output, changed files, dependency graph, prior
   attempts and the contract — never a reference to them.
2. An unchanged fingerprint **escalates**; only exhausting tier 5 blocks.
3. Only **materially different** attempts count against the budget (a no-op patch is free and
   forces escalation).
4. Checkpoints are **restored from**, not merely recorded.
5. The customer's floor is the last green checkpoint, not a broken tree.

---

## 4. Implementation plan (ordered PRs)

Ordered by evidence: PR1 and PR2 alone would have prevented both observed failures.

| PR | Title | Why here |
|---|---|---|
| **1** | **Repair brief carries the failure** — command, full stderr, diff, manifest, prior attempts, classification | Fixes the proven primary cause. Small, self-contained. |
| **2** | **Preflight import/export resolution** against installed dependency surfaces | Catches the exact error class before any build is spent. |
| **3** | **Patch verification** — intended file changed, fingerprint moved; no-op ⇒ escalate, not surrender | Turns the correct detection into the correct reaction. |
| **4** | **Repair tiers 1–5** with classification, and budget counting only material attempts | Replaces the flat retry loop. |
| **5** | **Implementation contract** persisted at plan time; `diag_runs.plan` stops being null | Prerequisite for verification and for tier 4. |
| **6** | **Continuous static validation** after each file group (parse, imports, exports, routes, SQL, duplicate identifiers, client/server boundary) | Stops building on a broken foundation. |
| **7** | **Staged generation A–E** with a gate and checkpoint per stage | The structural change; depends on 5 and 6. |
| **8** | **Functional verification** — boot the app, drive contract journeys in Playwright | Closes "renders but does not work". |
| **9** | **Honesty scan** — dead handlers, in-memory persistence, mocked calls, fake auth | Closes "convincing but simulated". |
| **10** | **Known-good foundations** for the six project types | Removes invented infrastructure. |
| **11** | **Checkpoint rollback** wired to the tier-5 path | Guarantees a working floor. |
| **12** | **Quality scoring and release gates** | Makes "complete" measurable. |
| **13** | Fix `project_integrations` missing table; decide Pexels key | Real defects found en route. |

---

## 5. Cost and latency impact

Per ordinary build, against today's baseline:

| Change | Latency | Tokens |
|---|---|---|
| Preflight + static validation | +2–5s | ~0 (deterministic) |
| Contract at plan time | +15–30s | +3–8k |
| Staged generation (5 gates) | +20–40s | +10–20% (smaller, better-targeted turns) |
| Functional verification | +30–90s | ~0 (Playwright) |
| Honesty scan | +2–5s | ~0 (static) |

**Net: roughly +1–3 minutes and +15–25% tokens on a successful build.**

Against that: today's *failed* runs each burned **8.8 and 12.7 managed credits** producing nothing
usable, plus a customer left with a broken tree. Preflight alone converts the observed failure from
"two wasted repair rounds and a blocked build" into a sub-second correction. The redesign is
expected to *reduce* mean cost per **successful** build.

---

## 6. Production proof plan

A deterministic generated-app suite, five fixtures — landing page · contact form with persistence ·
booking website · authenticated CRUD dashboard · small ecommerce flow — each generated from a fresh
request and verified against its own contract.

Into each, inject and prove automatic recovery from all twelve required faults: syntax error,
invalid import, missing dependency, incompatible dependency, missing package script, malformed env
access, failed migration, runtime exception, stale deployment source, failing browser journey,
unimplemented button, in-memory-only persistence.

Injection happens at a known stage; the proof asserts the fault is caught **at the earliest stage
capable of catching it** — an invalid import must fail preflight, not `npm run build`.

The booking app must complete from a fresh user request with **zero customer intervention**, and
its recorded journey run must show every contract journey passing.

---

## 7. Acceptance criteria

1. No build reaches `npm run build` with an unresolvable import or a missing dependency.
2. Every repair brief contains the exact command and complete output; **no brief references
   diagnostics by id**.
3. An unchanged failure fingerprint always escalates a tier; it never ends a run while tiers remain.
4. Every patch is verified to have changed the intended file and moved the failure signature.
5. Every build has a persisted contract; `diag_runs.plan` is never null for `app_build`.
6. No build is marked complete until its contract journeys pass against a running application.
7. The honesty scan finds no dead handler, in-memory-only persistence, or mocked request in a
   completed build.
8. A failure after stage C leaves the customer on the last green checkpoint, never a broken tree.
9. The customer sees npm output only when the repair budget is genuinely exhausted across all tiers.
10. All twelve injected faults recover automatically in all five fixtures.
11. The booking website completes unattended from a fresh request.
12. A high visual score cannot mark a build complete when workflow completion or persistence fails.

---

## Recommendation

PR1–PR3 are small, independent, and would have prevented both observed failures outright. I would
ship those first and re-run the two failing prompts as the immediate regression test, before taking
on the structural work in PR5–PR8.

**I have not changed the retry limit, and would not: it was not the cause.**
