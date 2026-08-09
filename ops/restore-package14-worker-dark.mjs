// Restore the production build worker to its dark, least-privilege authority after Package 14R.
// Values are never logged. The qualification-only credential and preview authority is removed,
// while the original synthetic/publish-package job allowlist is restored atomically.

import { chmod, chown, readFile, rename, stat, writeFile } from "node:fs/promises";

const targetPath = "/etc/thrallo/build-worker.env";
const remove = new Set([
  "CODE_AGENT_STORE",
  "PLATFORM_ENC_KEY",
  "BYOK_ENC_KEY",
  "PREVIEW_MODE",
  "PROVISIOND_URL",
  "PROVISIOND_TOKEN",
]);
const target = await readFile(targetPath, "utf8");
const targetStat = await stat(targetPath);
let jobTypesSeen = false;
const output = [];
for (const line of target.split(/\r?\n/)) {
  if (!line || line.trimStart().startsWith("#") || !line.includes("=")) {
    output.push(line);
    continue;
  }
  const name = line.slice(0, line.indexOf("=")).trim();
  if (remove.has(name)) continue;
  if (name === "THRALLO_BUILD_JOB_TYPES") {
    output.push("THRALLO_BUILD_JOB_TYPES=proof_slow,publish_package");
    jobTypesSeen = true;
  } else output.push(line);
}
if (!jobTypesSeen) output.push("THRALLO_BUILD_JOB_TYPES=proof_slow,publish_package");

const temporary = `${targetPath}.package14r-dark.tmp`;
await writeFile(temporary, `${output.filter((line, index, rows) => index < rows.length - 1 || line).join("\n")}\n`, {
  encoding: "utf8", mode: 0o640,
});
await chown(temporary, targetStat.uid, targetStat.gid);
await chmod(temporary, 0o640);
await rename(temporary, targetPath);
console.log(JSON.stringify({ restored: true, jobTypes: ["proof_slow", "publish_package"],
  removedQualificationAuthority: [...remove].sort() }));
