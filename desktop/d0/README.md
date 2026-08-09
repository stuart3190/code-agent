# D0 desktop foundation contract

This directory is the machine-readable baseline for the Thrallo Desktop-First programme. It
records what exists without changing any product runtime. D0 deliberately contains only
contracts, deterministic fixture definitions, evidence metadata, and guard tooling.

## Contents

- `capability-registry.json` classifies every retirement-critical capability across the web,
  native desktop, embedded web bundle, backend, fixture, runtime-proof, and Builder V2 boundary.
- `protected-paths.json` fixes the desktop branch boundary and paths desktop foundation work must
  not change.
- `buildr101-denylist.json` lists retired Buildr101 routes, libraries, and runtimes that must not
  become desktop shortcuts.
- `provider-contracts.json` defines the provider families and their read/mutation boundary. It is
  not a provider implementation.
- `fixtures/provider-scenarios.json` supplies deterministic states for future provider contract
  tests. It contains no live URL, credential, or network fallback.
- `builder-v2-boundary.json` records integrations blocked on Packages 14R and 15.
- `desktop-evidence.json` separates Code OSS, Thrallo extension, embedded-web, configured-only,
  and runtime-smoke evidence.
- `release-provenance.json` records source pins, package targets, published artifact metadata,
  signing state, and provenance gaps observed for D0.
- `guard.mjs` validates the manifests and fails when the desktop branch touches protected paths,
  imports a retired Buildr101 shortcut, or gives deterministic fixtures a network/mutation
  fallback.

Run the D0 checks from the isolated worktree:

```powershell
npm run test:desktop:d0
```

The guard compares the desktop branch with the immutable fork point recorded in
`protected-paths.json`. It is not a deployment gate and does not call production APIs.

## Fixed boundary

Builder V2 remains authoritative and untouched in the original worktree. D0 does not authorize
desktop integration, merging, production routing, migration, deployment, or customer release.
Fixture-backed success proves only that future desktop foundation work can be independently tested.
