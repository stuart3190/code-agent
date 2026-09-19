import crypto from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { canonicalDeploymentIdentity, validateDeploymentIdentity } from "../shell/server/lib/deploymentIdentity.mjs";

function arg(name) {
  const index = process.argv.indexOf(`--${name}`); return index === -1 ? null : process.argv[index + 1];
}
async function sha256File(file) {
  return crypto.createHash("sha256").update(await readFile(path.resolve(file))).digest("hex");
}

const output = path.resolve(arg("output") || "shell/DEPLOYMENT.json");
let migrationLedgerCount;
let migrationLedgerSha256;
if (arg("ledger")) {
  const ledger = JSON.parse(await readFile(path.resolve(arg("ledger")), "utf8"));
  const migrations = ledger.migrations || ledger;
  if (!Array.isArray(migrations) || !migrations.length) throw new Error("--ledger must contain the applied production migration list");
  const ledgerCanonical = JSON.stringify(migrations.map((row) => ({ version: String(row.version), name: String(row.name || "") })));
  migrationLedgerCount = migrations.length;
  migrationLedgerSha256 = crypto.createHash("sha256").update(ledgerCanonical).digest("hex");
} else if (arg("previous-manifest")) {
  const previous = validateDeploymentIdentity(JSON.parse(await readFile(path.resolve(arg("previous-manifest")), "utf8")));
  migrationLedgerCount = previous.migrationLedgerCount;
  migrationLedgerSha256 = previous.migrationLedgerSha256;
} else {
  throw new Error("either --ledger or --previous-manifest is required");
}
const value = {
  schemaVersion: 1,
  gitCommit: arg("commit") || execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  sourceArchiveSha256: await sha256File(arg("source-archive")),
  webArtifactSha256: await sha256File(arg("web-artifact")),
  shellArtifactSha256: await sha256File(arg("shell-artifact")),
  workerArtifactSha256: await sha256File(arg("worker-artifact")),
  migrationLedgerCount,
  migrationLedgerSha256,
  deployedAt: arg("deployed-at") || new Date().toISOString(),
};
value.manifestSha256 = crypto.createHash("sha256").update(canonicalDeploymentIdentity(value)).digest("hex");
validateDeploymentIdentity(value);
await writeFile(output, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o444 });
console.log(JSON.stringify({ output, manifestSha256: value.manifestSha256, gitCommit: value.gitCommit, migrationLedgerCount: value.migrationLedgerCount }));
