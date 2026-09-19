#!/usr/bin/env node

// Zero-provider release operation. The migration only installs the compatibility boundary; this
// command binds platform-connected Codex recovery to the exact deployment manifest at restricted
// activation. The prior managed policy record remains immutable historical evidence.

import { readFile } from "node:fs/promises";
import path from "node:path";

import { loadEnv } from "../shell/server/lib/env.mjs";
import { validateDeploymentIdentity } from "../shell/server/lib/deploymentIdentity.mjs";
import { serviceClient } from "../shell/server/lib/supabase.mjs";

const args = process.argv.slice(2);
const value = (name, fallback = null) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

loadEnv();
const manifestPath = path.resolve(value("manifest", "shell/DEPLOYMENT.json"));
const manifest = validateDeploymentIdentity(JSON.parse(await readFile(manifestPath, "utf8")));
const expectedCommit = value("commit");
if (expectedCommit && expectedCommit !== manifest.gitCommit) {
  throw new Error(`requested commit ${expectedCommit} differs from deployment manifest ${manifest.gitCommit}`);
}

const client = serviceClient();
const actor = value("actor", "restricted_release_activation");
const { data, error } = await client.rpc("activate_bv2_owner_connected_recovery_policy", {
  p_deployment_commit: manifest.gitCommit,
  p_deployment_manifest_sha256: manifest.manifestSha256,
  p_actor: actor,
});
if (error) throw error;
const activation = Array.isArray(data) ? data[0] : data;
if (activation?.state !== "active"
    || activation?.policyVersion !== "owner_connected_recovery_v1"
    || activation?.executionTransport !== "platform_connected_codex"
    || activation?.fundingSource !== "thrallo"
    || activation?.deploymentCommit !== manifest.gitCommit
    || activation?.deploymentManifestSha256 !== manifest.manifestSha256) {
  throw new Error("database recovery policy activation differs from deployment manifest");
}

console.log(JSON.stringify({
  ok: true,
  zeroModel: true,
  policyVersion: activation.policyVersion,
  executionTransport: activation.executionTransport,
  fundingSource: activation.fundingSource,
  deploymentCommit: activation.deploymentCommit,
  deploymentManifestSha256: activation.deploymentManifestSha256,
  activatedAt: activation.activatedAt,
  updatedBy: activation.updatedBy,
}));
