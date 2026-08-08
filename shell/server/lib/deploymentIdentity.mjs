import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { SHELL_DIR } from "./env.mjs";

const REQUIRED_HASHES = ["sourceArchiveSha256", "webArtifactSha256", "shellArtifactSha256", "workerArtifactSha256", "migrationLedgerSha256"];

export function canonicalDeploymentIdentity(value) {
  const copy = { ...value }; delete copy.manifestSha256;
  return JSON.stringify(Object.fromEntries(Object.entries(copy).sort(([a], [b]) => a.localeCompare(b))));
}

export function validateDeploymentIdentity(value) {
  if (!value || typeof value !== "object" || !/^[0-9a-f]{40}$/i.test(String(value.gitCommit || ""))) {
    throw new Error("deployment identity has no exact Git commit");
  }
  for (const field of REQUIRED_HASHES) {
    if (!/^[0-9a-f]{64}$/i.test(String(value[field] || ""))) throw new Error(`deployment identity has invalid ${field}`);
  }
  if (!Number.isInteger(value.migrationLedgerCount) || value.migrationLedgerCount < 1) throw new Error("deployment identity has invalid migration ledger count");
  if (!Number.isFinite(Date.parse(value.deployedAt))) throw new Error("deployment identity has invalid deploy timestamp");
  const expected = crypto.createHash("sha256").update(canonicalDeploymentIdentity(value)).digest("hex");
  if (value.manifestSha256 !== expected) throw new Error("deployment identity manifest hash mismatch");
  const serialized = JSON.stringify(value);
  if (/(?:sb_secret_|service_role|BEGIN [A-Z ]*PRIVATE KEY|sk_live_)/i.test(serialized)) {
    throw new Error("deployment identity contains a secret-like value");
  }
  return Object.freeze({ ...value });
}

export async function readDeploymentIdentity({ file = process.env.THRALLO_DEPLOYMENT_MANIFEST
  || path.join(SHELL_DIR, "DEPLOYMENT.json") } = {}) {
  return validateDeploymentIdentity(JSON.parse(await readFile(file, "utf8")));
}

