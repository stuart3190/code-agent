// Builds manifest.json for a Thrallo Desktop release directory. Run after copying the
// artifacts in:  node scripts/build-release-manifest.mjs <dir> <version> "<notes>"
// Hashes and sizes are computed from the actual files so the manifest can never drift.

import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const [dir, version, notes] = process.argv.slice(2);
if (!dir || !version) {
  console.error('usage: node scripts/build-release-manifest.mjs <dir> <version> "<notes>"');
  process.exit(1);
}

const FILES = {
  setup: { name: "Thrallo-Setup-x64.exe", label: "Windows installer" },
  portable: { name: "Thrallo-Portable-x64.zip", label: "Portable ZIP" },
};

const files = {};
for (const [key, spec] of Object.entries(FILES)) {
  const filePath = path.join(dir, spec.name);
  const info = await stat(filePath);
  const sha256 = createHash("sha256").update(await readFile(filePath)).digest("hex");
  files[key] = { ...spec, sizeBytes: info.size, sha256 };
  console.log(`${spec.name}  ${(info.size / 1048576).toFixed(1)} MB  sha256:${sha256.slice(0, 16)}…`);
}

const manifest = {
  product: "Thrallo Desktop",
  version,
  platform: "Windows 10/11 x64",
  releasedAt: new Date().toISOString(),
  notes: notes || "",
  files,
};
await writeFile(path.join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`manifest.json written for v${version}`);
