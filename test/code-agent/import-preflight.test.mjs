// PR2 — every import resolves before a compile is spent on it.
//
// The production failure: 27 files generated, a full npm install and npm run build spent, then two
// repair rounds (~21 credits), to discover one icon import naming a symbol the pinned package does
// not export. The export surface reads in ~20ms.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  preflightImports, parseImports, substituteFor, preflightSummary,
} from "../../shell/server/lib/appBuild/importPreflight.mjs";
import { exportSurface, installedVersion, resetSurfaceCache } from "../../shell/server/lib/appBuild/moduleSurface.mjs";
import { depsNodeModules } from "../../harness/workspace.mjs";

const nodeModules = depsNodeModules();
const manifest = (deps) => JSON.stringify({ name: "t", dependencies: deps }, null, 2);

test("the export surface is read exactly, without executing the package", async () => {
  resetSurfaceCache();
  const surface = await exportSurface("lucide-react", { nodeModules });
  assert.ok(surface, "lucide-react's surface must be readable");
  // 6 014 exports in the pinned version; the count is not asserted (it moves with the pin) but the
  // two facts that caused the production failure are.
  assert.equal(surface.has("Instagram"), false, "the icon that broke production is genuinely absent");
  assert.equal(surface.has("Camera"), true);
  assert.ok(surface.size > 1_000, `expected a full barrel, got ${surface.size}`);
  assert.match(await installedVersion("lucide-react", { nodeModules }), /^\d+\.\d+\.\d+/);
});

test("a package whose surface cannot be read is UNKNOWN, never empty", async () => {
  // react is CJS: nothing is statically parseable. Reporting "exports nothing" would fail every
  // build in the product. Silence is the only safe answer.
  assert.equal(await exportSurface("react", { nodeModules }), null);
  assert.equal(await exportSurface("no-such-package-at-all", { nodeModules }), null);

  const result = await preflightImports({
    "package.json": manifest({ react: "18.3.1" }),
    "src/App.jsx": `import { useState, useEffect, somethingImaginary } from "react";\n`,
  }, { nodeModules });
  assert.deepEqual(result.problems, [], "an unreadable surface must not produce a single problem");
});

test("FAULT 1 — an invalid lucide icon is caught and corrected before any build", async () => {
  const result = await preflightImports({
    "package.json": manifest({ "lucide-react": "1.28.0" }),
    "src/App.jsx": `import { Instagram, Clock } from "lucide-react";\nexport default () => <Instagram />;\n`,
  }, { nodeModules });

  assert.equal(result.problems.length, 0, "a safe substitution is a correction, not a failure");
  assert.equal(result.corrections.length, 1);
  const [correction] = result.corrections;
  assert.equal(correction.from, "Instagram");
  assert.equal(correction.kind, "substituted_export");
  assert.match(correction.message, /does not export it/);
  assert.match(correction.message, /1\.28\.0/, "the correction records the version it checked against");

  // Aliased, not renamed — the JSX below is untouched and still compiles.
  assert.match(result.tree["src/App.jsx"], /import \{ Camera as Instagram, Clock \} from "lucide-react"/);
  assert.match(result.tree["src/App.jsx"], /<Instagram \/>/);
  assert.notEqual(result.tree, undefined);
});

test("substitution never creates a duplicate binding", async () => {
  // Renaming Instagram to Camera in a file that already imports Camera yields
  // `{ Camera, Camera }` — a SyntaxError, and a new build failure caused by the fix.
  const result = await preflightImports({
    "package.json": manifest({ "lucide-react": "1.28.0" }),
    "src/App.jsx": `import { Instagram, Camera, Facebook } from "lucide-react";\n`,
  }, { nodeModules });

  const line = result.tree["src/App.jsx"];
  assert.match(line, /Camera as Instagram/);
  assert.match(line, /MessageCircle as Facebook/);
  const names = line.match(/\{([^}]*)\}/)[1].split(",").map((s) => s.trim().split(/\s+as\s+/).pop());
  assert.equal(new Set(names).size, names.length, `duplicate local binding in: ${line}`);
});

test("FAULT 2 — a missing local module is caught", async () => {
  const result = await preflightImports({
    "package.json": manifest({ react: "18.3.1" }),
    "src/App.jsx": `import Hero from "./components/Hero.jsx";\nimport { formatDate } from "./lib/format";\n`,
    "src/components/Hero.jsx": "export default function Hero() { return null; }",
  }, { nodeModules });

  assert.equal(result.problems.length, 1, "the file that exists must not be flagged");
  assert.equal(result.problems[0].kind, "missing_local_module");
  assert.equal(result.problems[0].specifier, "./lib/format");
  assert.match(result.problems[0].message, /src\/App\.jsx:2/, "the line number is reported");
  assert.equal(result.ok, false);
});

test("extensionless, index and @/ alias imports all resolve", async () => {
  const result = await preflightImports({
    "package.json": manifest({}),
    "src/App.jsx": [
      `import a from "./lib/format";`,          // format.js
      `import b from "./widgets";`,             // widgets/index.jsx
      `import c from "@/hooks/useCart";`,       // the scaffold alias -> src/
      `import "./styles.css";`,                 // side-effect import
    ].join("\n"),
    "src/lib/format.js": "export default 1;",
    "src/widgets/index.jsx": "export default 1;",
    "src/hooks/useCart.ts": "export default 1;",
    "src/styles.css": "body{}",
  }, { nodeModules });
  assert.deepEqual(result.problems.map((p) => p.specifier), []);
});

test("FAULT 3 — a non-existent named export with no safe substitute is reported, not guessed", async () => {
  const result = await preflightImports({
    "package.json": manifest({ "lucide-react": "1.28.0" }),
    "src/App.jsx": `import { TotallyMadeUpGlyph } from "lucide-react";\n`,
  }, { nodeModules });

  assert.equal(result.corrections.length, 0, "nothing plausible exists, so nothing is invented");
  assert.equal(result.problems.length, 1);
  assert.equal(result.problems[0].kind, "missing_export");
  assert.equal(result.problems[0].name, "TotallyMadeUpGlyph");
  assert.match(result.problems[0].message, /does not export it/);
});

test("an undeclared dependency is caught, and builtins are not", async () => {
  const result = await preflightImports({
    "package.json": manifest({ react: "18.3.1" }),
    "src/App.jsx": `import { debounce } from "lodash";\nimport fs from "node:fs";\nimport React from "react";\n`,
  }, { nodeModules });

  assert.equal(result.problems.length, 1);
  assert.equal(result.problems[0].kind, "missing_dependency");
  assert.equal(result.problems[0].package, "lodash");
  assert.match(result.problems[0].message, /neither in package\.json nor installed/);
});

test("scoped packages resolve to the scope, not the first segment", async () => {
  const result = await preflightImports({
    "package.json": manifest({ "@tanstack/react-query": "5.0.0" }),
    "src/App.jsx": `import { useQuery } from "@tanstack/react-query";\nimport x from "@missing/thing";\n`,
  }, { nodeModules });
  assert.deepEqual(result.problems.map((p) => p.package), ["@missing/thing"]);
});

test("substituteFor only makes moves it is certain about", () => {
  const surface = new Set(["Camera", "CameraIcon", "MessageCircle", "Trash2"]);
  assert.equal(substituteFor("Camera", surface), "CameraIcon", "lucide's own alias is the safest move");
  assert.equal(substituteFor("trash2", surface), "Trash2", "case alone");
  assert.equal(substituteFor("Instagram", surface), "Camera", "the curated brand map");
  // No edit-distance guessing: substituting the wrong icon silently is worse than an honest error.
  assert.equal(substituteFor("Camra", surface), null);
  assert.equal(substituteFor("Whatever", surface), null);
  assert.equal(substituteFor("Instagram", null), null);
});

test("parseImports reads every clause form and reports honest line numbers", () => {
  const found = parseImports([
    `import React from "react";`,
    `import { a, b as c } from "./x";`,
    `import * as utils from "./utils";`,
    `import Default, { named } from "./both";`,
    `import "./side-effect.css";`,
  ].join("\n"));

  assert.equal(found.length, 5);
  assert.equal(found[0].default, "React");
  assert.deepEqual(found[1].named.map((n) => n.name), ["a", "b"]);
  assert.equal(found[1].named[1].local, "c");
  assert.equal(found[2].namespace, "utils");
  assert.equal(found[3].default, "Default");
  assert.deepEqual(found[3].named.map((n) => n.name), ["named"]);
  assert.equal(found[4].sideEffect, true);
  assert.equal(found[4].line, 5);
});

test("a deep import is left alone rather than judged against the root's surface", async () => {
  // `lucide-react/icons/camera` has its own entry and a default-only surface. Checking it against
  // the barrel's names would report a false failure.
  const result = await preflightImports({
    "package.json": manifest({ "lucide-react": "1.28.0" }),
    "src/App.jsx": `import { anything } from "lucide-react/dist/esm/icons/camera";\n`,
  }, { nodeModules });
  assert.deepEqual(result.problems, []);
});

test("a clean project reports clean, and the tree is returned unchanged", async () => {
  const tree = {
    "package.json": manifest({ "lucide-react": "1.28.0" }),
    "src/App.jsx": `import { Camera, Clock } from "lucide-react";\n`,
  };
  const result = await preflightImports(tree, { nodeModules });
  assert.equal(result.ok, true);
  assert.equal(result.tree, tree, "no copy is made when nothing changed");
  assert.match(preflightSummary(result), /All imports resolve/);
});

test("an unparseable manifest fails the preflight instead of throwing", async () => {
  const result = await preflightImports({ "package.json": "{ not json" }, { nodeModules });
  assert.equal(result.ok, false);
  assert.equal(result.problems[0].kind, "manifest_unparseable");
});

test("the summary names what was corrected and what was not", () => {
  assert.match(
    preflightSummary({ checked: 12, corrections: [{ from: "Instagram", to: "Camera" }], problems: [{}] }),
    /Checked 12 imports\. Corrected 1: Instagram → Camera\. Unresolved: 1\./,
  );
});

test("build tooling imported by config files is not reported as a missing dependency", async () => {
  // Caught by ops/prove-pipeline-reliability.mjs, not by a unit test: `vite.config.js` imports
  // `vite` and `@vitejs/plugin-react`, which live in the shared scaffold's node_modules and are
  // deliberately absent from the generated manifest. Flagging them would have failed EVERY real
  // build — the precise failure mode this preflight exists to prevent.
  const result = await preflightImports({
    "package.json": manifest({ react: "18.3.1" }),
    "vite.config.js": `import { defineConfig } from "vite";\nimport react from "@vitejs/plugin-react";\nexport default defineConfig({ plugins: [react()] });\n`,
  }, { nodeModules });
  assert.deepEqual(result.problems, [], "installed-but-undeclared must resolve, not fail");
  assert.equal(result.ok, true);

  // Genuinely absent packages are still caught.
  const absent = await preflightImports({
    "package.json": manifest({}),
    "src/App.jsx": `import x from "definitely-not-installed-anywhere";\n`,
  }, { nodeModules });
  assert.equal(absent.problems[0].kind, "missing_dependency");
});
