# app-builder

The AI app-builder engine, graduated from the Phase 1 spike (`../codex-oauth-spike/`,
kept intact as the proof artifact). This is the first build-for-keeps structure:
a real engine behind a provider seam, plus an automated regression harness that proves
reliability across archetypes and records the cost baseline.

**Phase 2.0 scope only.** No targeted edit tool (2.1), context selection (2.2),
caching (2.3), or router (2.4) yet. The engine still rewrites whole files — the Phase 1
*reliable but expensive* path. The harness + baseline exist so those optimisations can
be attempted without silently regressing reliability.

## Layout

```
src/
  providers/codexProvider.mjs   The seam: runTurn({systemPrompt,messages,tools})
  providers/auth.mjs              -> {text,toolCalls,usage}. ALL Codex specifics here.
  cost.mjs                       Cost-if-metered (ASSUMED gpt-5.5 rates; FREE on the sub).
  scaffolds/reactVite.mjs        The Vite+React+Tailwind target tree.
  tools/fileTools.mjs            list/read/write_file — model-driven, above the seam.
  engine/runAgent.mjs            THE tool-use loop (one copy; deduped from the spike).
  engine/fileTree.mjs            tree helpers (fromScaffold/clone/flushDir/concatSource).
  engine/telemetry.mjs           per-turn token/cost accumulation + summary.
  prompts/builder.mjs            proven build/edit system prompts.
harness/
  run.mjs                        driver; `--baseline` writes baseline/.
  workspace.mjs                  shared-deps install + per-case junction + npm build.
  assertions.mjs                 named-marker presence check.
  cases/*.mjs + cases/trees/     three archetypes (todo, dashboard, form-validation).
baseline/                        BASELINE.md + baseline.json (recorded).
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
node harness/run.mjs            # run all archetypes; green/red + per-turn cost
node harness/run.mjs --baseline # also (re)write baseline/BASELINE.md + baseline.json
```

First run lazily installs the shared scaffold deps into `harness/.deps/` (one-time),
then junctions them into each case's working copy under `harness/.work/`.

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
