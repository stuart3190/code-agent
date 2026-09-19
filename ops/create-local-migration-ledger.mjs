import crypto from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const output = path.resolve(process.argv[2] || ".release/local-migration-ledger.json");
const root = path.resolve("supabase/migrations");
const files = (await readdir(root)).filter((name) => /^\d{14}_[a-z0-9_]+\.sql$/.test(name)).sort();
const versions = new Set();
const migrations = [];
for (const [index, file] of files.entries()) {
  const [, version, name] = /^(\d{14})_(.+)\.sql$/.exec(file);
  if (versions.has(version)) throw new Error(`duplicate local migration version ${version}`);
  versions.add(version);
  const sql = await readFile(path.join(root, file));
  migrations.push({ version, name, sourceSha256: crypto.createHash("sha256").update(sql).digest("hex"), appliedOrder: index + 1 });
}
if (!migrations.length) throw new Error("no local migrations found");
await writeFile(output, `${JSON.stringify({ generatedAt: new Date().toISOString(), migrations }, null, 2)}\n`, { flag: "wx", mode: 0o444 });
console.log(JSON.stringify({ output, count: migrations.length, first: migrations[0].version, last: migrations.at(-1).version }));
