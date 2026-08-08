import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { validateDeploymentIdentity } from "../shell/server/lib/deploymentIdentity.mjs";

const manifestPath = path.resolve(process.argv[2] || "shell/DEPLOYMENT.json");
const manifest = validateDeploymentIdentity(JSON.parse(await readFile(manifestPath, "utf8")));
const pairs = [
  ["sourceArchiveSha256", process.env.THRALLO_SOURCE_ARCHIVE],
  ["webArtifactSha256", process.env.THRALLO_WEB_ARTIFACT],
  ["shellArtifactSha256", process.env.THRALLO_SHELL_ARTIFACT],
  ["workerArtifactSha256", process.env.THRALLO_WORKER_ARTIFACT],
];
for (const [field, file] of pairs) {
  if (!file) throw new Error(`${field} verification path is missing`);
  const actual = createHash("sha256").update(await readFile(path.resolve(file))).digest("hex");
  if (actual !== manifest[field]) throw new Error(`${field} differs from deployment manifest`);
}
console.log(JSON.stringify({ ok: true, gitCommit: manifest.gitCommit, manifestSha256: manifest.manifestSha256,
  migrationLedgerCount: manifest.migrationLedgerCount }));
