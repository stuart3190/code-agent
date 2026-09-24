# WP1 — Manifest, resolver, lock and availability (2026-09-18)

New source root: `shell/server/lib/builderV2/platformModules/` (audit §16 "Proposed new source location").

| File | Responsibility |
| --- | --- |
| `semver.mjs` | dependency-free ranges (`^`, `~`, comparators, wildcards, `||`) |
| `manifest.mjs` | `ModuleManifest` / `OperationDefinition` schema (audit §6.1); `uninstall` must be `retain_data`; server mutations must name an authorization policy; qualified modules record a qualification basis |
| `registry.mjs` | the eight capabilities wrapped as `thrallo.entities`, `thrallo.identity`, `thrallo.authorization`, `thrallo.booking`, `thrallo.workflow`, `thrallo.contact`, `thrallo.newsletter`, `thrallo.forms` plus `thrallo.core`; operations derived from the capability registry's own metadata; legacy `crud.update` declared `concurrency: null` |
| `availability.mjs` | declared deployment services; baseline = backend_sdk, app_auth, entities, realtime; optional services never assumed (`THRALLO_APP_SERVICE_<NAME>=1` to declare) |
| `resolver.mjs` | deterministic, explainable, dependency-complete selection; typed problems (`module_unavailable` with `configurationRequired`, range conflict, declared conflict, capability ownership, deprecated, cycle) |
| `lock.mjs` | `ModuleLock` v1 (versions, artefact sha256 over CRLF-normalised bytes, config/schema/policy/route hashes), `verifyModuleLock(tree, lock)`, `moduleLockDelta`, `lockFromLegacySpec` adapter |

## Architectural change

- `buildSpec.deriveBuildSpec()` (v4) resolves modules from the capability graph's deterministic nodes — the exact set the composer emits — and mints the lock; `verdict.modules` joins the gate. An unavailable required service fails the verdict before generation.
- `orchestrator` blocks with `failureClassification: "module_unavailable"` (`configurationRequired: true`) before any contract correction is spent; passes the lock into composition; verifies the composed tree against the lock (`module_installation_defect` on mismatch); records a lock delta when a resumed snapshot's runtime is refreshed by the worker (the audited refresh behaviour itself is preserved — a versioned upgrade path is a later package).
- `capabilityComposer` ships `src/lib/capabilities/composed/lock.js` (protected) when a lock exists; unlocked trees compose byte-for-byte as before.
- `executionProvenance.sourceContractDigest()` includes the lock when present, so verification evidence does not survive a module change. Legacy digests are unchanged.

## Compatibility

- No public import changed. `src/lib/capabilities/*` bytes and exports are identical.
- v3 specs keep every field; `lockFromLegacySpec(spec, { tree })` adapts a persisted contract or snapshot (basis `snapshot_tree` or `host_scaffold`, flagged `legacy: true`).
- Baseline formats frozen in the ledger; `CURRENT_FORMAT_VERSIONS` records buildSpec 4 and the four new v1 formats.

## Tests

`builder-v2-platform-modules.test.mjs` (12): semver, manifest negatives, registry wrap, deterministic resolution, conflict/dependency negatives, availability block, lock determinism + tampering + CRLF + missing artefact, spec v4, unavailable-before-generation, composition lock file, provenance invalidation, old-spec adapter.
Affected existing suites re-run green (build-spec, composition, execution-spec/projection/provenance, patches, capabilities, tiering, pre-repair pipeline, contract-gate corpus, fresh advanced contract, persistence corpus, orchestrator, runtime composition, entry, edit, scaffolds, lifecycle, retained flow replay).
