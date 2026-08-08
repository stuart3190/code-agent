// Production-only, secret-safe worker credential authority repair for Package 14.
// Copies only the credential-store selector and encryption key from the shell's existing
// private environment into the worker's private EnvironmentFile. Values are never logged.

import { chmod, chown, readFile, rename, stat, writeFile } from "node:fs/promises";

const sourcePath = "/home/ubuntu/code-agent/shell/.env";
const targetPath = "/etc/thrallo/build-worker.env";

function parse(text) {
  const rows = [];
  const values = new Map();
  for (const line of text.split(/\r?\n/)) {
    rows.push(line);
    if (!line || line.trimStart().startsWith("#") || !line.includes("=")) continue;
    const index = line.indexOf("=");
    values.set(line.slice(0, index).trim(), line.slice(index + 1));
  }
  return { rows, values };
}

const source = parse(await readFile(sourcePath, "utf8"));
const target = parse(await readFile(targetPath, "utf8"));
const targetStat = await stat(targetPath);
const encryptionName = source.values.has("PLATFORM_ENC_KEY") ? "PLATFORM_ENC_KEY"
  : source.values.has("BYOK_ENC_KEY") ? "BYOK_ENC_KEY" : null;
if (!encryptionName || !source.values.get(encryptionName)) {
  throw new Error("shell credential encryption key is unavailable");
}

const updates = new Map([
  ["CODE_AGENT_STORE", "supabase"],
  [encryptionName, source.values.get(encryptionName)],
]);
const seen = new Set();
const output = target.rows.map((line) => {
  if (!line || line.trimStart().startsWith("#") || !line.includes("=")) return line;
  const name = line.slice(0, line.indexOf("=")).trim();
  if (!updates.has(name)) return line;
  seen.add(name);
  return `${name}=${updates.get(name)}`;
});
for (const [name, value] of updates) if (!seen.has(name)) output.push(`${name}=${value}`);

const temporary = `${targetPath}.package14.tmp`;
await writeFile(temporary, `${output.filter((line, index, rows) => index < rows.length - 1 || line).join("\n")}\n`, {
  encoding: "utf8", mode: 0o640,
});
await chown(temporary, targetStat.uid, targetStat.gid);
await chmod(temporary, 0o640);
await rename(temporary, targetPath);
console.log(JSON.stringify({ configured: true, store: "supabase", encryptionKeyPresent: true }));
