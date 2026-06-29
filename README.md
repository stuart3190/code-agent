# app-builder

The AI app-builder engine, graduated from the Phase 1 spike (`../codex-oauth-spike/`,
kept intact as the proof artifact). This is the first build-for-keeps structure:
a real engine behind a provider seam, plus an automated regression harness that proves
reliability across archetypes and records the cost baseline.

**Status: through Phase 2.2.** The engine has the targeted edit tool (2.1, `apply_patch`)
and context selection (2.2). Caching (2.3) and the router (2.4) are not built yet. Each
optimisation is proven against the harness baseline so reliability never silently regresses.

- **2.1 — targeted edit tool:** output scales with *change* size, not *file* size. `write_file`
  remains the fallback after repeated failed edits. See `baseline/PHASE-2.1.md`.
- **2.2 — context selection:** instead of re-sending every accumulated file read and patch
  blob each turn, the engine carries a paths-only **manifest** + the **current contents of just
  the relevant files** (seeded from `src/App.jsx` + its direct deps, grown as the model touches
  files) in the regenerated system prompt, and **prunes** the redundant copies out of the
  replayed history. It also tells the model not to re-read files already shown, so it patches
  directly. `runAgent` additionally retries a transient empty (0-token/no-tool) turn once
  before failing. See `baseline/PHASE-2.2.md`.

## Layout

```
src/
  providers/codexProvider.mjs   The seam: runTurn({systemPrompt,messages,tools})
  providers/auth.mjs              -> {text,toolCalls,usage}. ALL Codex specifics here.
  cost.mjs                       Cost-if-metered (ASSUMED gpt-5.5 rates; FREE on the sub).
  scaffolds/reactVite.mjs        The Vite+React+Tailwind target tree.
  tools/fileTools.mjs            list/read/write_file + apply_patch/edit_file — above the seam.
  tools/edit/*.mjs               the V4A apply_patch + search/replace appliers.
  engine/runAgent.mjs            THE tool-use loop (one copy; deduped from the spike).
  engine/context.mjs             Phase 2.2: manifest + relevant-file block + history pruning.
  engine/fileTree.mjs            tree helpers (fromScaffold/clone/flushDir/concatSource).
  engine/telemetry.mjs           per-turn token/cost accumulation + summary.
  prompts/builder.mjs            proven build/edit system prompts.
harness/
  run.mjs                        driver; --baseline / --edit=<fmt> / --ctx.
  runEngineCase.mjs              run one case through the engine (shared by run + trial).
  workspace.mjs                  shared-deps install + per-case junction + npm build.
  assertions.mjs                 named-marker presence check.
  _applier-tests.mjs             offline edit-applier tests (no model).
  _context-tests.mjs             offline context-selection helper tests (no model).
  _runagent-tests.mjs            offline empty-turn-retry tests (fake provider, no model).
  cases/*.mjs + cases/trees/     three archetypes (todo, dashboard, form-validation).
baseline/                        BASELINE.md, PHASE-2.1.md, PHASE-2.2.md (+ .json).
```

## The seam (do not break)

Everything provider-specific lives behind one interface:

```
provider.runTurn({ systemPrompt, messages, tools }) -> { text, toolCalls, usage }
```

The engine (`runAgent`) speaks only neutral message/tool/usage shapes. A future BYOK
official-API adapter satisfies the same interface without touching the engine.

## Run

```
node harness/run.mjs                        # write-only baseline path; green/red + cost
node harness/run.mjs --baseline             # also (re)write baseline/BASELINE.md + .json
node harness/run.mjs --edit=apply_patch     # 2.1 edit tool; writes baseline/PHASE-2.1.*
node harness/run.mjs --edit=apply_patch --ctx  # + 2.2 context selection; writes PHASE-2.2.*

# offline (no model, no quota):
node harness/_applier-tests.mjs
node harness/_context-tests.mjs
node harness/_runagent-tests.mjs
```

`--ctx` is opt-in so the 2.1 path stays reproducible for a clean A/B; it becomes the engine
default in a later commit. First run lazily installs the shared scaffold deps into
`harness/.deps/` (one-time), then junctions them into each case's working copy under
`harness/.work/`.

## What the harness asserts (per case)

A case is a **starting file tree + one edit prompt**. After running the engine on it:

- **(A)** the app still builds (`npm run build`),
- **(B)** every named prior-feature marker survives,
- **(C)** every named new-feature marker is present.

Green iff A ∧ B ∧ C. This is the proven Phase 1 bar, automated and generalised across
three app shapes. Coarse on purpose — keeping it identical is what makes the baseline a
fair line for later phases to beat.

## Baseline

`baseline/` records, on the current full-rewrite engine: reliability (cases green/total)
and £-if-metered per turn. See `baseline/BASELINE.md`. Every Phase 2 optimisation must
beat it on cost **without** dropping reliability.
