// Temporarily authorize the production-dark worker to lease Builder V2 pipeline jobs for the
// single Package 14S internal qualification. This does not enable shell/customer dispatch.

import { chmod, chown, readFile, rename, stat, writeFile } from "node:fs/promises";

const targetPath = "/etc/thrallo/build-worker.env";
const target = await readFile(targetPath, "utf8");
const targetStat = await stat(targetPath);
const required = ["builder_pipeline", "proof_slow", "publish_package"];
let found = false;
const output = target.split(/\r?\n/).map((line) => {
  if (!line || line.trimStart().startsWith("#") || !line.includes("=")) return line;
  const name = line.slice(0, line.indexOf("=")).trim();
  if (name !== "THRALLO_BUILD_JOB_TYPES") return line;
  found = true;
  return `THRALLO_BUILD_JOB_TYPES=${required.join(",")}`;
});
if (!found) output.push(`THRALLO_BUILD_JOB_TYPES=${required.join(",")}`);

const temporary = `${targetPath}.package14s.tmp`;
await writeFile(temporary, `${output.filter((line, index, rows) => index < rows.length - 1 || line).join("\n")}\n`, {
  encoding: "utf8", mode: 0o640,
});
await chown(temporary, targetStat.uid, targetStat.gid);
await chmod(temporary, 0o640);
await rename(temporary, targetPath);
console.log(JSON.stringify({ configured: true, jobTypes: required }));
