// Production-only, secret-safe worker credential authority repair for Package 14.
// Copies only the credential-store selector, encryption key, preview authority and PUBLIC
// generated-runtime configuration from the shell's existing private environment into the
// worker's private EnvironmentFile. Values are never logged. Service-role values already used by
// the queue remain server-only and are never copied into a generated tree.

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

function jwtRole(value) {
  const parts = String(value || "").split(".");
  if (parts.length !== 3) return null;
  try { return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"))?.role || null; }
  catch { return null; }
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
// The worker's private EnvironmentFile is bind-mounted over shell/.env. Builder-pipeline work
// therefore needs its own preview authority as well as credential authority; otherwise the
// production runtime safely resolves to local preview and stops before dispatch. Copy only the
// established preview fields and never print their values.
for (const name of ["PREVIEW_MODE", "PROVISIOND_URL", "PROVISIOND_TOKEN"]) {
  if (source.values.get(name)) updates.set(name, source.values.get(name));
}
for (const name of ["SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY", "SUPABASE_ANON_KEY"]) {
  if (source.values.get(name)) updates.set(name, source.values.get(name));
}
const publicKey = updates.get("SUPABASE_PUBLISHABLE_KEY") || updates.get("SUPABASE_ANON_KEY");
if (!updates.get("SUPABASE_URL") || !publicKey) {
  throw new Error("shell public generated-runtime configuration is unavailable");
}
const privileged = [source.values.get("SUPABASE_SERVICE_ROLE_KEY"), source.values.get("SUPABASE_SERVICE_ROLE"),
  source.values.get("SUPABASE_SECRET_KEY")].filter(Boolean);
if (publicKey.startsWith("sb_secret_") || jwtRole(publicKey) === "service_role"
    || privileged.includes(publicKey)) {
  throw new Error("refusing to install a privileged Supabase key as generated-browser configuration");
}
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
console.log(JSON.stringify({ configured: true, store: "supabase", encryptionKeyPresent: true,
  previewAuthorityPresent: ["PREVIEW_MODE", "PROVISIOND_URL", "PROVISIOND_TOKEN"]
    .every((name) => updates.has(name)), publicRuntimePresent: true }));
