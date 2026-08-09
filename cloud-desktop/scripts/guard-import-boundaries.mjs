import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const denylist = JSON.parse(readFileSync(path.join(packageRoot, "guardrails", "import-denylist.json"), "utf8"));
const packageJson = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8"));
const dependencyNames = Object.keys({ ...packageJson.dependencies, ...packageJson.devDependencies });
const forbiddenDependencies = dependencyNames.filter((name) => denylist.forbiddenDependencies.includes(name));

if (forbiddenDependencies.length) {
  console.error(`Forbidden dependencies: ${forbiddenDependencies.join(", ")}`);
  process.exit(1);
}

const scanRoots = ["src", "test", "vite.config.js", "vitest.config.js", "playwright.config.js"];
const sourceFiles = [];

function collect(target) {
  const absolute = path.join(packageRoot, target);
  const info = statSync(absolute);
  if (info.isDirectory()) {
    for (const child of readdirSync(absolute)) collect(path.join(target, child));
  } else if (/\.(?:[cm]?[jt]sx?)$/.test(target)) {
    sourceFiles.push(absolute);
  }
}

for (const root of scanRoots) collect(root);

const importPattern = /(?:\bfrom\s*|\bimport\s*\(|\brequire\s*\()\s*["']([^"']+)["']/g;
const violations = [];

for (const file of sourceFiles) {
  const source = readFileSync(file, "utf8");
  for (const match of source.matchAll(importPattern)) {
    const specifier = match[1].replaceAll("\\", "/");
    if (denylist.forbiddenImportFragments.some((fragment) => specifier.includes(fragment))) {
      violations.push(`${path.relative(packageRoot, file)} imports forbidden boundary ${specifier}`);
    }
    if (specifier.startsWith(".")) {
      const resolved = path.resolve(path.dirname(file), specifier);
      if (resolved !== packageRoot && !resolved.startsWith(`${packageRoot}${path.sep}`)) {
        violations.push(`${path.relative(packageRoot, file)} imports outside cloud-desktop/: ${specifier}`);
      }
    }
  }
}

if (violations.length) {
  console.error("C0 import-boundary guard failed:");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log(`C0 import-boundary guard passed (${sourceFiles.length} source/config/test files checked).`);
