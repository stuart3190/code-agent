import { createHash } from "node:crypto";

export const RELEASE_SCHEMA_VERSION = 1;
export const PRODUCT_ID = "thrallo-desktop";
export const RELEASE_CHANNELS = Object.freeze(["internal", "canary", "opt_in_stable", "stable"]);
export const D15_ALLOWED_CHANNELS = Object.freeze(["internal"]);
export const ARCHITECTURES = Object.freeze([
  "win32-x64", "win32-arm64", "darwin-x64", "darwin-arm64", "linux-x64", "linux-arm64",
]);

export const SIGNING_POLICY = Object.freeze({
  windows: Object.freeze({ scheme: "authenticode", requiredForCustomerRelease: true, material: "protected_ci_credential" }),
  macos: Object.freeze({ scheme: "developer_id_hardened_runtime_notarization", requiredForCustomerRelease: true, material: "protected_ci_credential" }),
  linux: Object.freeze({ scheme: "package_repository_signature", requiredForCustomerRelease: true, material: "protected_ci_credential" }),
  privateKeysInRepository: false,
  unsignedDisposition: "private_not_release_eligible",
});

export const UPDATE_STATES = Object.freeze([
  "no_update", "upgrade_available", "mandatory_compatibility_update", "staged_rollout_unavailable",
  "incompatible_client", "incompatible_server_contract", "bad_signature", "bad_hash",
  "withdrawn_release", "rollback_available", "downgrade_blocked", "offline", "manifest_unavailable",
]);

export const ATOMIC_UPDATE_STATES = Object.freeze([
  "idle", "downloading", "verifying", "staged", "restart_required", "applying",
  "validating_startup", "succeeded", "failed_apply", "startup_failed", "rolled_back",
]);

const SECRET_PATTERNS = [
  /\b(?:sk|rk)-(?:live|test|proj)-[A-Za-z0-9_-]{8,}\b/g,
  /\b(?:ghp|github_pat)_[A-Za-z0-9_]{8,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi,
  /\b(?:password|token|secret|api[_-]?key)=([^\s&]+)/gi,
  /\b(?:postgres(?:ql)?):\/\/[^\s]+/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function redactCrashValue(value) {
  let output = typeof value === "string" ? value : stableJson(value);
  for (const pattern of SECRET_PATTERNS) output = output.replace(pattern, (match, captured) => captured ? match.replace(captured, "[REDACTED]") : "[REDACTED]");
  output = output.replace(/(?:file:\/\/\/|[A-Za-z]:\\)[^\s)]+/gi, "[LOCAL_PATH]");
  return output;
}

export function createBuildInputManifest(input) {
  const required = ["sourceCommit", "sourceTree", "desktopBranch", "codeOssCommit", "desktopVersion", "nodeVersion", "packageManager", "lockfileSha256", "target", "architecture", "operatingSystem", "overlaySha256", "extensionSha256"];
  for (const key of required) if (!input?.[key]) throw new TypeError(`Missing reproducible build input: ${key}`);
  if (!ARCHITECTURES.includes(`${input.target}-${input.architecture}`)) throw new TypeError("Unsupported build target/architecture");
  const manifest = {
    schemaVersion: RELEASE_SCHEMA_VERSION,
    product: PRODUCT_ID,
    sourceCommit: input.sourceCommit,
    sourceTree: input.sourceTree,
    sourceDirty: Boolean(input.sourceDirty),
    desktopBranch: input.desktopBranch,
    codeOssCommit: input.codeOssCommit,
    desktopVersion: input.desktopVersion,
    nodeVersion: input.nodeVersion,
    packageManager: input.packageManager,
    lockfileSha256: input.lockfileSha256,
    target: input.target,
    architecture: input.architecture,
    operatingSystem: input.operatingSystem,
    buildTools: Object.freeze({ ...(input.buildTools || {}) }),
    overlaySha256: input.overlaySha256,
    extensionSha256: input.extensionSha256,
  };
  return Object.freeze({ ...manifest, inputIdentity: sha256(stableJson(manifest)) });
}

export function verifyArtifactSignature({ artifactHash, expectedHash, signatureState, identity, expectedIdentity }) {
  if (artifactHash !== expectedHash) return unavailable("hash_mismatch");
  if (identity !== expectedIdentity) return unavailable("identity_mismatch");
  if (signatureState === "unsigned") return unavailable("unsigned");
  if (signatureState !== "signed_valid") return unavailable("signed_invalid");
  return Object.freeze({ ok: true, state: "signed_valid", sideEffects: false });
}

export function createPrivateUpdateManifest(input) {
  if (!D15_ALLOWED_CHANNELS.includes(input?.releaseChannel)) throw new TypeError("D15 permits internal update manifests only");
  if (!ARCHITECTURES.includes(`${input.platform}-${input.architecture}`)) throw new TypeError("Unsupported update platform/architecture");
  const manifest = {
    schemaVersion: RELEASE_SCHEMA_VERSION,
    product: PRODUCT_ID,
    version: input.version,
    platform: input.platform,
    architecture: input.architecture,
    releaseChannel: input.releaseChannel,
    artifact: Object.freeze({ uri: input.artifactUri, sha256: input.artifactSha256, signatureState: input.artifactSignatureState }),
    manifestSignature: input.manifestSignature || null,
    signatureAlgorithm: input.signatureAlgorithm || "unavailable",
    releaseNotesRef: input.releaseNotesRef || null,
    minimumCompatibleClient: input.minimumCompatibleClient,
    minimumCompatibleServerContract: input.minimumCompatibleServerContract,
    rollbackEligible: Boolean(input.rollbackEligible),
    publicationTimestamp: input.publicationTimestamp,
    provenanceRef: input.provenanceRef,
    withdrawn: Boolean(input.withdrawn),
    rolloutEligible: input.rolloutEligible !== false,
    classification: "PRIVATE_NOT_CUSTOMER_RELEASED",
  };
  return Object.freeze(manifest);
}

export function manifestPayload(manifest) {
  const { manifestSignature: _signature, ...payload } = manifest;
  return stableJson(payload);
}

export function validateUpdateManifest(manifest, { verifyManifestSignature } = {}) {
  if (!manifest || manifest.schemaVersion !== RELEASE_SCHEMA_VERSION || manifest.product !== PRODUCT_ID) return unavailable("manifest_unavailable");
  if (!D15_ALLOWED_CHANNELS.includes(manifest.releaseChannel)) return unavailable("staged_rollout_unavailable");
  if (!/^[a-f0-9]{64}$/.test(manifest.artifact?.sha256 || "")) return unavailable("bad_hash");
  if (typeof verifyManifestSignature !== "function" || !verifyManifestSignature(manifestPayload(manifest), manifest.manifestSignature, manifest.signatureAlgorithm)) return unavailable("bad_signature");
  return Object.freeze({ ok: true, state: "manifest_valid", sideEffects: false });
}

export function decideUpdate({ currentVersion, platform, architecture, clientContract, serverContract, online = true, manifest, signatureValid = true, artifactHashValid = true, previousCompatibleVersion = null }) {
  if (!online) return decision("offline");
  if (!manifest) return decision("manifest_unavailable");
  if (!signatureValid) return decision("bad_signature");
  if (!artifactHashValid) return decision("bad_hash");
  if (manifest.platform !== platform || manifest.architecture !== architecture) return decision("incompatible_client");
  if (manifest.withdrawn) return decision(previousCompatibleVersion ? "rollback_available" : "withdrawn_release", { rollbackVersion: previousCompatibleVersion });
  if (!manifest.rolloutEligible) return decision("staged_rollout_unavailable");
  if (compareVersions(currentVersion, manifest.minimumCompatibleClient) < 0) return decision("mandatory_compatibility_update", { targetVersion: manifest.version });
  if (serverContract !== manifest.minimumCompatibleServerContract) return decision("incompatible_server_contract");
  if (clientContract !== manifest.minimumCompatibleClient && compareVersions(clientContract, manifest.minimumCompatibleClient) < 0) return decision("incompatible_client");
  const comparison = compareVersions(manifest.version, currentVersion);
  if (comparison < 0) return decision("downgrade_blocked");
  if (comparison === 0) return decision("no_update");
  return decision("upgrade_available", { targetVersion: manifest.version });
}

export function verifyPrivateDownload({ manifest, bytes, expectedProduct = PRODUCT_ID, platform, architecture, allowedArtifactRoot, signatureState, signatureIdentity, expectedSignatureIdentity }) {
  if (manifest.product !== expectedProduct || manifest.platform !== platform || manifest.architecture !== architecture) return unavailable("identity_mismatch");
  const uri = String(manifest.artifact?.uri || "");
  if (!uri.startsWith(`${allowedArtifactRoot.replace(/[\\/]$/, "")}/`) || /[?#]/.test(uri)) return unavailable("artifact_reference_rejected");
  const actualHash = sha256(bytes);
  return verifyArtifactSignature({ artifactHash: actualHash, expectedHash: manifest.artifact.sha256, signatureState, identity: signatureIdentity, expectedIdentity: expectedSignatureIdentity });
}

export function createAtomicUpdater({ previousVersion, targetVersion, stateCompatibility = "compatible" }) {
  let state = "idle";
  const history = [];
  const allowed = {
    idle: ["downloading"], downloading: ["verifying", "failed_apply"], verifying: ["staged", "failed_apply"],
    staged: ["restart_required"], restart_required: ["applying"], applying: ["validating_startup", "failed_apply"],
    validating_startup: ["succeeded", "startup_failed"], startup_failed: ["rolled_back"], failed_apply: ["rolled_back"],
  };
  function transition(next, detail = null) {
    if (!(allowed[state] || []).includes(next)) throw new TypeError(`Invalid update transition ${state} -> ${next}`);
    state = next;
    history.push(Object.freeze({ sequence: history.length + 1, state, detail: redactCrashValue(detail || "") }));
    return snapshot();
  }
  function snapshot() {
    return Object.freeze({ state, previousVersion, targetVersion, priorReleaseRetained: state !== "succeeded", rollbackAllowed: stateCompatibility === "compatible", history: Object.freeze([...history]) });
  }
  function rollback(reason) {
    if (!snapshot().rollbackAllowed || !["startup_failed", "failed_apply"].includes(state)) return unavailable("rollback_incompatible");
    return transition("rolled_back", reason);
  }
  return Object.freeze({ transition, rollback, snapshot });
}

export function selectRollback({ currentVersion, candidates, stateFormatVersion }) {
  const candidate = (candidates || []).find((item) => item.version !== currentVersion && !item.withdrawn && item.stateFormatVersion === stateFormatVersion && item.signatureState === "signed_valid");
  return candidate ? Object.freeze({ ok: true, state: "rollback_available", version: candidate.version, confirmationRequired: true }) : unavailable("rollback_unavailable");
}

export function recoverDesktopState(input = {}) {
  const result = {
    workspace: input.workspaceExists === false ? "missing_requires_user" : "restore_safe",
    terminal: input.terminalWasRunning ? "stale_cleared" : "none",
    preview: input.previewWasRunning ? "stale_cleared" : "none",
    update: input.updateState === "applying" || input.updateState === "validating_startup" ? "rollback_previous_release" : "none",
    metadata: input.metadataCorrupt ? "quarantine_and_recreate" : "valid",
    projectSourceModified: false,
  };
  return Object.freeze(result);
}

export function createCrashReport(input = {}) {
  const allowed = ["desktopVersion", "codeOssVersion", "platform", "architecture", "workspaceMode", "component", "classification", "correlationId"];
  const report = { schemaVersion: 1, consent: input.consent === true, uploadEnabled: false };
  for (const key of allowed) if (input[key] != null) report[key] = redactCrashValue(String(input[key]));
  if (input.stack) report.sanitizedStack = redactCrashValue(input.stack).split(/\r?\n/).slice(0, 20).join("\n");
  return Object.freeze(report);
}

export function validatePackagedDeepLink(raw) {
  try {
    const url = new URL(raw);
    if (url.protocol !== "thrallo:" || url.hostname !== "auth" || url.pathname !== "/callback") return unavailable("unsupported_deep_link");
    const allowed = new Set(["code", "state"]);
    for (const key of url.searchParams.keys()) if (!allowed.has(key)) return unavailable("malformed_callback");
    if (!url.searchParams.get("code") || !url.searchParams.get("state")) return unavailable("malformed_callback");
    return Object.freeze({ ok: true, state: "forward_to_d2_controller", callback: "thrallo://auth/callback", credentialsLogged: false });
  } catch { return unavailable("malformed_callback"); }
}

export function evaluateReleaseEligibility(gates) {
  const required = ["sourceProvenance", "protectedPaths", "build", "tests", "packageSmoke", "artifactHash", "signing", "updateManifest", "securityRedaction", "platformQualification", "rollbackArtifact", "noBlockingDefect"];
  const failed = required.filter((key) => gates?.[key] !== true);
  return Object.freeze({ eligible: failed.length === 0, classification: failed.length ? "PRIVATE_NOT_RELEASE_ELIGIBLE" : "CUSTOMER_RELEASE_ELIGIBLE_PENDING_APPROVAL", failedGates: Object.freeze(failed), publicationAuthorized: false });
}

export function architectureMatrix(overrides = {}) {
  const base = Object.fromEntries(ARCHITECTURES.map((id) => [id, { configured: true, buildAttempted: false, built: false, packaged: false, smokeTested: false, signed: false, notarized: false, releaseEligible: false }]));
  for (const [id, value] of Object.entries(overrides)) {
    if (!base[id]) throw new TypeError(`Unknown architecture: ${id}`);
    base[id] = { ...base[id], ...value };
  }
  return Object.freeze(Object.fromEntries(Object.entries(base).map(([id, value]) => [id, Object.freeze(value)])));
}

export function privateUpdateService(seed = "d15-private-update") {
  const calls = [];
  return Object.freeze({
    request(operation, payload = {}) {
      calls.push(Object.freeze({ sequence: calls.length + 1, operation, payloadHash: sha256(stableJson(payload)), seed }));
      if (operation === "publish" || operation === "activate_customer_channel") return unavailable("production_publication_forbidden");
      return Object.freeze({ ok: true, state: "fixture_recorded", sideEffects: false });
    },
    calls: () => Object.freeze([...calls]),
  });
}

function compareVersions(left, right) {
  const a = String(left || "0").split(".").map(Number);
  const b = String(right || "0").split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const difference = (a[i] || 0) - (b[i] || 0);
    if (difference) return Math.sign(difference);
  }
  return 0;
}

function decision(state, detail = {}) {
  if (!UPDATE_STATES.includes(state)) throw new TypeError(`Unknown update decision: ${state}`);
  return Object.freeze({ state, ...detail, sideEffects: false });
}

function unavailable(code) {
  return Object.freeze({ ok: false, code, state: "capability_unavailable", sideEffects: false, correlationId: `d15-${sha256(code).slice(0, 12)}` });
}
