// Platform modules — the versioned, contract-driven module layer (audit §6, WP1+).
//
// manifest.mjs     schema and validation of ModuleManifest / OperationDefinition
// registry.mjs     the registered modules (the eight legacy capabilities wrapped, plus runtime core)
// availability.mjs what a deployment declares it provides
// resolver.mjs     deterministic, explainable, dependency-complete module selection
// lock.mjs         immutable ModuleLock, verification of a tree against it, legacy adapter
// coverageLedger.mjs the WP0 frozen baseline and per-entry ownership ledger

export * from "./manifest.mjs";
export * from "./registry.mjs";
export * from "./availability.mjs";
export * from "./resolver.mjs";
export * from "./lock.mjs";
export * from "./semver.mjs";
