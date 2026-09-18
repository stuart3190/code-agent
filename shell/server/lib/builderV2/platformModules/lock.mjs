// The immutable module lock (audit §6.1 "ModuleLock").
//
// A resolution says WHICH modules an application needs. The lock records EXACTLY what was built
// with: module versions, the sha256 of every protected runtime artefact, the configuration each
// module was given, the ABIs, and hashes of the schema, policy and route material the modules
// were compiled against. A snapshot that carries a lock can be checked byte-for-byte against it,
// which is what turns "a resumed snapshot may receive different platform bytes" (audit P1) from a
// silent event into a recorded, refusable one.
//
// Line endings are normalised before hashing: the same commit checked out on Windows and copied
// to Linux must produce the same identity.

import crypto from "node:crypto";
import { REACT_VITE } from "../../../../../src/scaffolds/reactVite.mjs";
import { MODULE_REGISTRY, moduleManifest } from "./registry.mjs";
import { resolveModules } from "./resolver.mjs";
import { baselineDeploymentAvailability } from "./availability.mjs";

export const MODULE_LOCK_VERSION = 1;
export const MODULE_COMPILER_VERSION = "platform-modules/1.0.0";

const canonical = (value) => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort()
    .filter((key) => value[key] !== undefined).map((key) => [key, canonical(value[key])])) : value;
export const digestValue = (value) => crypto.createHash("sha256").update(JSON.stringify(canonical(value) ?? null)).digest("hex");
const digestText = (text) => crypto.createHash("sha256").update(String(text).replace(/\r\n/g, "\n")).digest("hex");

/** The platform's canonical artefact bytes: the scaffold the worker ships. */
export function scaffoldArtifactSource(path) {
  const content = REACT_VITE[path];
  return typeof content === "string" ? content : null;
}

/** An artefact source over a generated tree (a snapshot's own bytes). */
export const treeArtifactSource = (tree) => (path) => (typeof tree?.[path] === "string" ? tree[path] : null);

/**
 * Hash a module's protected runtime artefacts through `source`. Composed artefacts (rendered per
 * application by the composer) are listed but not hashed here: their bytes depend on the graph
 * and are verified by the composition validator against the plan.
 */
export function moduleArtifactHash(manifest, source = scaffoldArtifactSource) {
  const rows = [];
  const missing = [];
  for (const artifact of manifest?.runtime?.protectedArtifacts || []) {
    if (artifact.kind === "composed") continue;
    const content = source(artifact.path);
    if (content === null) { missing.push(artifact.path); continue; }
    rows.push(`${artifact.path}\n${digestText(content)}`);
  }
  return { hash: rows.length ? digestText(rows.sort().join("\n")) : null, hashed: rows.length, missing: missing.sort() };
}

/** Hash the contract material a lock is compiled against: the product contract, not derived views. */
export function applicationContractHash(contract) {
  return digestValue({
    entities: contract?.entities || [], operations: contract?.operations || [], routes: contract?.routes || [],
    auth: contract?.auth || null, buildProfile: contract?.buildProfile || null, journeys: contract?.journeys || [],
    workflows: contract?.workflows || [],
  });
}

/**
 * Build the lock for a resolution.
 *
 * @param {object} options
 * @param {object} options.resolution output of resolveModules()
 * @param {object} options.contract the planned product contract
 * @param {Array} options.bindings capability bindings (their configuration becomes configHash)
 * @param {(path:string)=>string|null} options.artifacts artefact byte source
 */
export function buildModuleLock({
  resolution, contract = null, bindings = [], artifacts = scaffoldArtifactSource, registry = MODULE_REGISTRY,
  basis = "host_scaffold", legacy = false,
} = {}) {
  if (!resolution?.ok) throw new Error("a module lock requires a successful resolution");
  const configurationFor = new Map();
  for (const binding of bindings) {
    if (binding?.configuration) configurationFor.set(binding.name, binding.configuration);
  }
  const modules = resolution.modules.map((row) => {
    const manifest = moduleManifest(row.id, [row.version], registry);
    const artifact = moduleArtifactHash(manifest, artifacts);
    const configuration = manifest.legacyCapabilityId ? configurationFor.get(manifest.legacyCapabilityId) || null : null;
    return {
      id: row.id, version: row.version,
      artifactHash: artifact.hash, artifactCount: artifact.hashed, missingArtifacts: artifact.missing,
      configHash: digestValue(configuration), clientAbi: manifest.compatibility.clientAbi,
      serverAbi: manifest.compatibility.serverAbi,
      migrationVersion: (manifest.migrations || []).at(-1)?.id || "0",
    };
  });
  const policy = {
    auth: contract?.auth || null,
    permissions: resolution.modules.flatMap((row) => (moduleManifest(row.id, [row.version], registry)?.permissions || []).map((permission) => `${row.id}:${permission.id}`)).sort(),
  };
  return {
    version: MODULE_LOCK_VERSION,
    compilerVersion: MODULE_COMPILER_VERSION,
    basis,
    legacy,
    applicationContractHash: applicationContractHash(contract),
    modules,
    schemaHash: digestValue(contract?.entities || []),
    policyHash: digestValue(policy),
    routeHash: digestValue(contract?.routes || []),
  };
}

export function moduleLockDigest(lock) {
  return digestValue({
    version: lock?.version, compilerVersion: lock?.compilerVersion, applicationContractHash: lock?.applicationContractHash,
    modules: (lock?.modules || []).map(({ id, version, artifactHash, configHash, clientAbi, serverAbi, migrationVersion }) => (
      { id, version, artifactHash, configHash, clientAbi, serverAbi, migrationVersion })),
    schemaHash: lock?.schemaHash, policyHash: lock?.policyHash, routeHash: lock?.routeHash,
  });
}

/**
 * Verify a generated tree against its lock: every locked runtime artefact must be present and
 * byte-identical (modulo line endings). Missing or altered artefacts are reported per module so
 * repair attribution can name the platform, never the generated application.
 */
export function verifyModuleLock(tree, lock, { registry = MODULE_REGISTRY } = {}) {
  const problems = [];
  if (!lock || lock.version !== MODULE_LOCK_VERSION) {
    return { ok: false, problems: [{ code: "module_lock_missing", message: "the snapshot carries no module lock" }] };
  }
  const source = treeArtifactSource(tree);
  for (const locked of lock.modules || []) {
    const manifest = moduleManifest(locked.id, [locked.version], registry);
    if (!manifest) {
      problems.push({ code: "module_unregistered", module: locked.id, version: locked.version,
        message: `${locked.id}@${locked.version} is locked but no longer registered` });
      continue;
    }
    if (locked.artifactHash === null) continue; // nothing was hashed (no runtime artefacts)
    const actual = moduleArtifactHash(manifest, source);
    for (const path of actual.missing) {
      problems.push({ code: "module_artifact_missing", module: locked.id, path, message: `${locked.id}: locked artefact ${path} is absent from the tree` });
    }
    if (actual.hash !== locked.artifactHash) {
      const changed = (manifest.runtime.protectedArtifacts || []).filter((artifact) => artifact.kind !== "composed" && source(artifact.path) !== null)
        .filter((artifact) => digestText(source(artifact.path)) !== digestText(scaffoldArtifactSource(artifact.path) ?? "")).map((artifact) => artifact.path);
      problems.push({ code: "module_artifact_mismatch", module: locked.id, version: locked.version,
        expected: locked.artifactHash, actual: actual.hash, paths: changed,
        message: `${locked.id}@${locked.version}: protected runtime bytes differ from the lock` });
    }
  }
  return { ok: problems.length === 0, problems };
}

/** What changed between two locks — the record an upgrade candidate must carry. */
export function moduleLockDelta(previous, next) {
  const before = new Map((previous?.modules || []).map((row) => [row.id, row]));
  const after = new Map((next?.modules || []).map((row) => [row.id, row]));
  const ids = [...new Set([...before.keys(), ...after.keys()])].sort();
  const changes = [];
  for (const id of ids) {
    const a = before.get(id);
    const b = after.get(id);
    if (!a) changes.push({ id, change: "added", to: b.version });
    else if (!b) changes.push({ id, change: "removed", from: a.version });
    else if (a.version !== b.version) changes.push({ id, change: "version", from: a.version, to: b.version });
    else if (a.artifactHash !== b.artifactHash) changes.push({ id, change: "artifact", from: a.artifactHash, to: b.artifactHash });
    else if (a.configHash !== b.configHash) changes.push({ id, change: "configuration", from: a.configHash, to: b.configHash });
  }
  return { identical: changes.length === 0, changes };
}

/**
 * Old-spec adapter: a build specification (or persisted contract) that predates locks receives
 * one derived from its capability bindings, flagged legacy. With a tree, the artefact hashes are
 * the snapshot's own bytes (basis "snapshot_tree"); without one they are the host scaffold's.
 */
export function lockFromLegacySpec(spec, { tree = null, availability = baselineDeploymentAvailability(), registry = MODULE_REGISTRY } = {}) {
  if (spec?.moduleLock) return spec.moduleLock;
  const contract = spec?.contract || spec;
  // The capability graph's deterministic nodes are the exact set the composer emitted for that
  // build (interaction primitives always, plus anything a structured responsibility pulled in);
  // raw bindings are the fallback for a contract persisted without its graph.
  const graphNodes = (spec?.capabilityGraph?.nodes || contract?.capabilityGraph?.nodes || [])
    .filter((node) => node.type === "deterministic_capability");
  const bindings = graphNodes.length
    ? graphNodes.map((node) => ({ name: node.capabilityId, version: node.version, configuration: node.configuration || null }))
    : (spec?.bindings || contract?.bindings || []);
  const resolution = resolveModules({ bindings, availability, registry });
  if (!resolution.ok) return null;
  return buildModuleLock({
    resolution, contract, bindings, registry,
    artifacts: tree ? treeArtifactSource(tree) : scaffoldArtifactSource,
    basis: tree ? "snapshot_tree" : "host_scaffold", legacy: true,
  });
}

/** Read the lock a composed tree ships, if any. */
export function moduleLockFromTree(tree) {
  const source = tree?.["src/lib/capabilities/composed/lock.js"];
  if (typeof source !== "string") return null;
  const match = /export const MODULE_LOCK = Object\.freeze\(([\s\S]*)\);\s*$/.exec(source);
  if (!match) return null;
  try { return JSON.parse(match[1]); } catch { return null; }
}
