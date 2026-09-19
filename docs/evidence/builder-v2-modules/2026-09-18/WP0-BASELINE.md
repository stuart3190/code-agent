# WP0 — Frozen baseline and coverage ledger (2026-09-18)

Blueprint: `THRALLO-MODULAR-AUDIT` (2026-09-18). Baseline revision `e83d4ef212b08fc2aa9d9ddc0937cd279ad8d042`
on `astra/execution-authority-20260907` — the exact revision the audit inspected. No behaviour changed.

## What WP0 pins

`shell/server/lib/builderV2/platformModules/coverageLedger.mjs` is the machine-readable ledger;
`test/code-agent/builder-v2-module-coverage-ledger.test.mjs` compares it against the live registries.

| Pinned | Value |
| --- | --- |
| Format versions | implementationContract 2, buildProfile 1, buildSpec 3, capabilityGraph 2, scaffoldRegistry 1, scaffoldGraph 3, scaffoldComposition 3, capabilityComposition 1, executionProvenance 2, executionSpec 1, routeResolution 1 |
| Snapshot row | owner, project_id, build_id, parent_snapshot, tree_hash, reason, state, file_count, total_tokens, asset_manifest, created_at |
| Protected write guard | `src/lib/backend/`, `src/lib/visitorSession.js`, `src/lib/capabilities/`, `src/lib/scaffolds/composed/` |
| Runtime refresh seam | `orchestrator.refreshPlatformRuntime()` pattern (audit P1 — to be replaced by a lock-aware upgrade candidate) |
| Prompt literals | contract 12,115 · patch 4,995 · compile-correction 627 · headroom 692 characters (literal text, not wire size) |
| Retained corpora | advanced-20260916, advanced-20260917-fresh, medium-20260917-recessed, medium-20260918-recessed, lumen contract |

## Coverage

Every entry below has one ledger row naming its current status (D/S/P/G), target module and work package.

- 8 registered capabilities (crud, session/auth, roles, booking, wizard, contact, newsletter, interaction-primitives)
- 12 scaffold families
- 30 scaffold-composer primitives (hooks, routing primitives, boundaries, optional shells)
- 13 backend SDK surfaces with every member method (auth, visitor session, entity CRUD, list options, subscribe, storage, payments, notifications, analytics, actions, usage, knowledge, Meta)
- 7 server runtime operation families with every operation
- 8 platform services (app_users mapping, scheduled actions, secrets, assets, teardown, schema availability, runtime preflight, domain analytics)
- 9 requirement signals — `payments`, `file_uploads`, `realtime` are marked as extension seams that MUST resolve to a qualified module or an explicit unavailable result
- 8 execution controls that stay outside application module semantics

Target module catalogue: 37 modules (audit §7), each with its landing work package.

## Compatibility

Nothing removed, renamed or re-versioned. Any later work package that retires or re-versions an
entry updates the ledger in the same commit; the suite fails otherwise.
