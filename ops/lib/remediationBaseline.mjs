import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export const AUDITED_MAIN_COMMIT = "92e4c9fe5c864799eee228f304849064bacb0190";
export const SAFETY_ENV_KEYS = Object.freeze([
  "THRALLO_MANAGED_SETTLEMENT_PAUSED",
  "THRALLO_BV2_KILL",
]);
export const SAFETY_FLAG_KEYS = Object.freeze(["bv2.enabled", "bv2.owners", "bv2.shadow"]);

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** Read-only git evidence. Nothing here fetches, switches branches, tags, commits, or pushes. */
export function collectGitBaseline(cwd) {
  const head = git(cwd, "rev-parse", "HEAD");
  const originMain = git(cwd, "rev-parse", "origin/main");
  const status = git(cwd, "status", "--porcelain");
  return {
    head,
    originMain,
    branch: git(cwd, "branch", "--show-current"),
    clean: status.length === 0,
    matchesOriginMain: head === originMain,
    matchesAuditedCommit: originMain === AUDITED_MAIN_COMMIT,
  };
}

/**
 * Inventory runnable Supabase migrations without connecting to a database. Duplicate versions are
 * intentionally preserved in the report: hiding them would turn PR-02's prerequisite into a false
 * green. The aggregate hash is stable across machines because it excludes absolute paths/mtimes.
 */
export function collectMigrationBaseline(migrationsDir) {
  const files = readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => {
      const match = /^(\d+)_/.exec(name);
      const bytes = readFileSync(path.join(migrationsDir, name));
      return { name, version: match?.[1] || null, sha256: sha256(bytes), bytes: bytes.length };
    });
  const byVersion = new Map();
  for (const file of files) {
    if (!file.version) continue;
    const names = byVersion.get(file.version) || [];
    names.push(file.name);
    byVersion.set(file.version, names);
  }
  const duplicateVersions = [...byVersion.entries()]
    .filter(([, names]) => names.length > 1)
    .map(([version, names]) => ({ version, names }))
    .sort((a, b) => a.version.localeCompare(b.version));
  const manifestHash = sha256(files.map(({ name, sha256: digest }) => `${name} ${digest}`).join("\n"));
  return { count: files.length, manifestHash, duplicateVersions, files };
}

function flagValue(flags, key) {
  if (flags instanceof Map) return flags.has(key) ? flags.get(key) : undefined;
  return flags && Object.prototype.hasOwnProperty.call(flags, key) ? flags[key] : undefined;
}

/** Return only interpreted booleans/counts. Raw environment values and owner ids never leave here. */
export function classifySafetyState({ env = {}, flags = null } = {}) {
  const pauseObserved = Object.prototype.hasOwnProperty.call(env, "THRALLO_MANAGED_SETTLEMENT_PAUSED");
  const killObserved = Object.prototype.hasOwnProperty.call(env, "THRALLO_BV2_KILL");
  const enabled = flagValue(flags, "bv2.enabled");
  const owners = flagValue(flags, "bv2.owners");
  const shadow = flagValue(flags, "bv2.shadow");
  const ownersCount = Array.isArray(owners) ? owners.length : owners === false || owners == null ? 0 : null;
  const observations = {
    settlementPause: { observed: pauseObserved, safe: pauseObserved && env.THRALLO_MANAGED_SETTLEMENT_PAUSED === "1" },
    v2Kill: { observed: killObserved, safe: killObserved && env.THRALLO_BV2_KILL === "1" },
    v2Enabled: { observed: enabled !== undefined, safe: enabled === false, value: enabled === undefined ? null : Boolean(enabled) },
    v2Owners: { observed: owners !== undefined, safe: owners !== undefined && ownersCount === 0, count: ownersCount },
    v2Shadow: { observed: shadow !== undefined, value: shadow === undefined ? null : Boolean(shadow) },
  };
  const required = [observations.settlementPause, observations.v2Kill, observations.v2Enabled, observations.v2Owners];
  return {
    observations,
    complete: required.every((item) => item.observed),
    safe: required.every((item) => item.observed && item.safe),
  };
}

export function baselineViolations({ git: gitState, migrations, safety }) {
  const violations = [];
  if (!gitState.matchesOriginMain) violations.push("working HEAD does not match origin/main");
  if (!gitState.matchesAuditedCommit) violations.push("origin/main differs from the audited commit");
  if (migrations.duplicateVersions.length) violations.push("runnable Supabase migration versions are duplicated");
  if (safety.complete && !safety.safe) violations.push("one or more live rollout safety controls are not armed");
  return violations;
}

export function collectLocalRemediationBaseline(repoRoot, { env = process.env, flags = null } = {}) {
  const gitState = collectGitBaseline(repoRoot);
  const migrations = collectMigrationBaseline(path.join(repoRoot, "supabase", "migrations"));
  const safety = classifySafetyState({ env, flags });
  return {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    scope: flags == null ? "local_only" : "local_and_approved_flag_read",
    git: gitState,
    migrations,
    safety,
    violations: baselineViolations({ git: gitState, migrations, safety }),
    productionEvidence: {
      deployedArtifactIds: "not_collected",
      activeReleasePointers: "not_collected",
      backupAge: "not_collected",
      v1RollbackArtifact: "not_collected",
      serviceVersions: "not_collected",
    },
  };
}
