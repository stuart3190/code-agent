# app-builder

The AI app-builder engine, graduated from the Phase 1 spike (`../codex-oauth-spike/`,
kept intact as the proof artifact). This is the first build-for-keeps structure:
a real engine behind a provider seam, plus an automated regression harness that proves
reliability across archetypes and records the cost baseline.

**Status: through Phase 3.0.** The engine has the targeted edit tool (2.1, `apply_patch`),
context selection (2.2), a cache-friendly mode (2.3), and a model router (2.4) — each proven
against the harness baseline so reliability never silently regresses — and now the generated
apps target a **thin backend SDK** (3.0, auth / entities / storage) implemented on Supabase
behind a swappable seam, proven end-to-end against a live project.

- **2.1 — targeted edit tool:** output scales with *change* size, not *file* size. `write_file`
  remains the fallback after repeated failed edits. See `baseline/PHASE-2.1.md`.
- **2.2 — context selection:** instead of re-sending every accumulated file read and patch
  blob each turn, the engine carries a paths-only **manifest** + the **current contents of just
  the relevant files** (seeded from `src/App.jsx` + its direct deps, grown as the model touches
  files) in the regenerated system prompt, and **prunes** the redundant copies out of the
  replayed history. It also tells the model not to re-read files already shown, so it patches
  directly. `runAgent` additionally retries a transient empty (0-token/no-tool) turn once
  before failing. See `baseline/PHASE-2.2.md`.
- **2.3 — prompt caching (verified, situational):** prompt caching IS live on the
  reverse-engineered Codex-OAuth transport — a probe reused **85%** of a stable >1024-token
  prefix, automatically, with no `prompt_cache_key` (setting one *suppressed* hits here). The
  opt-in `--cache` mode keeps the prompt prefix byte-stable (a context block frozen at the
  initial tree) and history append-only so input bills mostly at the cached rate — the opposite
  trade-off to 2.2, which mutates the prefix every turn and gets ~0 hits. On the short harness
  cases caching held 3/3 and cut £/turn but did **not** beat 2.2 on total £ (more turns +
  cache-write propagation latency), so **2.2 stays the default**; `--cache` is the lever for the
  future BYOK adapter (no latency penalty, `prompt_cache_key` works there) and long sessions. The
  Codex-vs-BYOK cost asymmetry is recorded for the Phase 4 credit model. See `baseline/PHASE-2.3.md`.
- **2.4 — model router:** a **selection layer ABOVE the seam** — a routing provider
  (`src/providers/routingProvider.mjs`) that asks the pure policy (`src/router/router.mjs`
  `chooseModel`) which provider+model to use, then delegates `runTurn` to it. `runAgent`, the tools,
  the prompts and the cost model are **untouched**. On the single-model Codex lane it is a thin
  pass-through; on the multi-model Anthropic side it routes **strong→generation**, and for an edit a
  **cost-aware** choice between strong and cheap that **encodes the 2.1/Anthropic finding**: a cheap
  model with weaker `apply_patch` adherence falls back to full `write_file` rewrites, and a rewrite
  emits far more output than a patch — so cheap only pays if it still patches cleanly. The policy is
  a pure function (unit-tested offline, no spend) and the cheap model's real adherence is *measured*
  live and fed back. See `baseline/PHASE-2.4.md`.
- **3.0 — thin backend SDK:** generated apps stopped being static. They now call a small, stable
  SDK — `import { auth, db, storage } from "./lib/backend"` — and never touch Supabase directly. It
  is a **swappable seam** (same idea as the provider seam): Supabase is one implementation behind
  `createSupabaseBackend({url, anonKey})`; a self-hosted Supabase or own-Postgres backend satisfies
  the same shape with no generated-app changes. Data is migration-free — one generic
  `entities(id, type, data jsonb, owner, created_at)` table, so `db.entity("note")` needs no schema.
  The 3/3 regression held (the new dep tree-shakes out of the client-only cases), and a generated
  app was proven end-to-end against a **live** project — not just `npm run build`. See
  `baseline/PHASE-3.md`. **Single-tenant proof only**: per-tenant RLS isolation is a later session.

## Backend SDK (the seam the generated apps call)

```
auth.signUp({email,password})  auth.signIn({email,password})  auth.signOut()  auth.currentUser()
db.entity("<type>").create(data) | .list() | .get(id) | .update(id,patch) | .delete(id)
storage.upload(file, path?) -> {path}   storage.getUrl(path) -> public URL
```

Authored as real files under `src/scaffolds/reactVite/lib/backend/` (single source of truth — the
Node proof imports the same factory the app ships) and read into the scaffold tree. `index.js` wires
Vite env (`VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`); `supabaseBackend.js` is the pure,
config-injected factory. Apps import `./lib/backend` only — never `@supabase/supabase-js`.

## Layout

```
src/
  providers/codexProvider.mjs   The seam: runTurn({systemPrompt,messages,tools})
  providers/auth.mjs              -> {text,toolCalls,usage}. ALL Codex specifics here.
  providers/anthropicProvider.mjs BYOK adapter — Anthropic Messages API behind the same seam.
  providers/routingProvider.mjs  Phase 2.4: seam-compatible wrapper that delegates to the routed model.
  router/router.mjs              Phase 2.4: pure chooseModel policy + per-model adherence catalogue.
  cost.mjs                       Cost-if-metered (ASSUMED gpt-5.5 rates; FREE on the sub).
  scaffolds/reactVite.mjs        The Vite+React+Tailwind target tree (now incl. the backend SDK).
  scaffolds/reactVite/lib/backend/  3.0 SDK: index.js (Vite env wiring) + supabaseBackend.js (pure factory).
  tools/fileTools.mjs            list/read/write_file + apply_patch/edit_file — above the seam.
  tools/edit/*.mjs               the V4A apply_patch + search/replace appliers.
  engine/runAgent.mjs            THE tool-use loop (one copy; deduped from the spike).
  engine/context.mjs             Phase 2.2: manifest + relevant-file block + history pruning.
  engine/fileTree.mjs            tree helpers (fromScaffold/clone/flushDir/concatSource).
  engine/telemetry.mjs           per-turn token/cost accumulation + summary.
  prompts/builder.mjs            proven build/edit system prompts.
harness/
  run.mjs                        driver; --baseline / --edit=<fmt> / --ctx / --cache / --router.
  proveBackend.mjs               3.0 backend proof: generate ▸ build ▸ markers ▸ LIVE Supabase round-trip.
  runEngineCase.mjs              run one case through the engine (shared by run + trial).
  workspace.mjs                  shared-deps install + per-case junction + npm build.
  assertions.mjs                 named-marker presence check.
  _applier-tests.mjs             offline edit-applier tests (no model).
  _context-tests.mjs             offline context-selection helper tests (no model).
  _runagent-tests.mjs            offline empty-turn-retry + cached-token billing tests (fake provider).
  _router-tests.mjs              offline router-policy tests (chooseModel; no model, no spend).
  _cache-probe.mjs               verify prompt caching is live on the Codex transport (2 calls).
  cases/*.mjs + cases/trees/     three archetypes (todo, dashboard, form-validation).
baseline/                        BASELINE.md, PHASE-2.1.md … PHASE-2.4.md (+ .json), ANTHROPIC.md.
```

## The seam (do not break)

Everything provider-specific lives behind one interface:

```
provider.runTurn({ systemPrompt, messages, tools, promptCacheKey? }) -> { text, toolCalls, usage }
```

The engine (`runAgent`) speaks only neutral message/tool/usage shapes. `usage` carries a
`cached` count (cache-read input tokens); `promptCacheKey` is an optional input the engine may
pass (unused on the Codex path — it suppressed hits there — kept for the BYOK adapter). A future
BYOK official-API adapter satisfies the same interface without touching the engine.

## Run

```
node harness/run.mjs                        # write-only baseline path; green/red + cost
node harness/run.mjs --baseline             # also (re)write baseline/BASELINE.md + .json
node harness/run.mjs --edit=apply_patch     # 2.1 edit tool; writes baseline/PHASE-2.1.*
node harness/run.mjs --edit=apply_patch --ctx    # + 2.2 context selection; writes PHASE-2.2.*
node harness/run.mjs --edit=apply_patch --cache  # 2.3 cache-friendly shaping; writes PHASE-2.3.*

# 2.4 model router (Anthropic, REAL money — needs ANTHROPIC_API_KEY in env). The A/B:
node harness/run.mjs --router --edit=apply_patch --ctx --route=strong       # A: all-strong (Sonnet)
node harness/run.mjs --router --edit=apply_patch --ctx --route=cheap-edits  # B: edits->cheap (Haiku)
#   writes baseline/PHASE-2.4.<strategy>.json each run; PHASE-2.4.md once both A+B exist.
#   --route=auto      cost-aware (strong gen; cheap edit only if its adherence makes it cheaper)
#   --strong=<model> / --cheap=<model>   override the pair (default Sonnet 4.6 / Haiku 4.5)

# offline (no model, no quota):
node harness/_applier-tests.mjs
node harness/_context-tests.mjs
node harness/_runagent-tests.mjs
node harness/_router-tests.mjs

# tiny quota (2 calls): confirm prompt caching is live on the Codex-OAuth transport:
node harness/_cache-probe.mjs

# 3.0 backend proof — generate an app that uses auth + entity CRUD + file upload, then drive it
# against a LIVE Supabase project (Codex generation free; Supabase free tier). Creds via env:
#   SUPABASE_URL / SUPABASE_ANON_KEY (anon public key only — never the service_role key)
# Without creds it runs generate+build+markers and reports the live step as SKIPPED.
SUPABASE_URL=... SUPABASE_ANON_KEY=... node harness/proveBackend.mjs
```

`--ctx` (2.2, cache-hostile: minimise raw input) and `--cache` (2.3, cache-friendly: stable
prefix + append-only) are **alternative** input strategies — `--ctx` wins if both are passed.
Both are opt-in so each phase stays reproducible for a clean A/B. First run lazily installs the
shared scaffold deps into `harness/.deps/` (one-time), then junctions them into each case's
working copy under `harness/.work/`.

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
