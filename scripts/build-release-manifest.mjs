// Builds manifest.json for a Thrallo Desktop release directory. Run after copying the
// artifacts in:  node scripts/build-release-manifest.mjs <dir> <version> "<notes>"
// Hashes and sizes are computed from the actual files so the manifest can never drift.

import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const [dir, versionArg, notes] = process.argv.slice(2);
if (!dir) {
  console.error('usage: node scripts/build-release-manifest.mjs <dir> [version] "<notes>"');
  process.exit(1);
}

// The RELEASE version must be the one the packaged app knows about itself, or the desktop
// update notice cannot work: the first release was published as "1.131.0" — the Code-OSS pin,
// which never changes between Thrallo releases — while the packaged extension carries its own
// increasing version. Comparing the two made the notice fire permanently.
//
// Defaulting to the extension's version keeps one source of truth; an explicit argument still
// wins for a one-off.
const packagedVersion = JSON.parse(
  await readFile(new URL("../editor/vscode/package.json", import.meta.url), "utf8"),
).version;
const version = versionArg || packagedVersion;
if (versionArg && versionArg !== packagedVersion) {
  console.warn(`WARNING: publishing ${versionArg} but the packaged app reports ${packagedVersion} — `
    + "the update notice compares these, so they should match.");
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
