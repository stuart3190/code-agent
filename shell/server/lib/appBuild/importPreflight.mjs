// Resolve every import before spending a build on it.
//
// PR2 of docs/PIPELINE-REDESIGN.md. In production, 27 files were generated, a full `npm install`
// and `npm run build` were spent, and two repair rounds burned ~21 credits — to discover that one
// icon import named a symbol the pinned package does not export. The export surface is readable in
// 23 milliseconds. There is no reason for that failure to ever reach a compiler.
//
// This checks three things, in the order they can be wrong:
//
//   1. a relative import that resolves to no file in the generated tree
//   2. a bare import of a package that is not in the manifest
//   3. a NAMED import of a symbol the installed package does not export
//
// The governing rule is that a preflight which is confidently wrong is worse than no preflight,
// because it fails builds that would have succeeded. So every check is asymmetric: it reports a
// problem only when it is CERTAIN, and stays silent whenever the answer is unknown — a package it
// cannot parse, a CJS module, a deep import, a dynamic specifier.

import { access } from "node:fs/promises";
import { join } from "node:path";
import { exportSurface, installedVersion } from "./moduleSurface.mjs";

const installedCache = new Map();

// Is the package actually there to be imported? Cached: a build asks this once per package.
async function isInstalled(packageName, nodeModules) {
  const key = `${nodeModules}::${packageName}`;
  if (installedCache.has(key)) return installedCache.get(key);
  const present = await access(join(nodeModules, ...packageName.split("/"), "package.json"))
    .then(() => true).catch(() => false);
  installedCache.set(key, present);
  return present;
}

const SOURCE = /\.(jsx?|tsx?|mjs)$/;

// ── parsing ──────────────────────────────────────────────────────────────────────────────────
// Static `import ... from "..."` only. A dynamic import() is a runtime concern and is left alone.
const IMPORT = /import\s+(?:([^;'"]*?)\s+from\s+)?["']([^"']+)["']/g;

/**
 * Blank out comments, preserving every newline so reported line numbers stay true.
 *
 * Found in production, on the first build after PR2 shipped: the scaffold's own backend SDK
 * documents its usage in a header comment —
 *
 *   //   import { auth, db, storage, payments } from "./lib/backend";
 *
 * — and preflight reported that as an unresolved import on EVERY build. It did not block anything
 * (problems are logged, not fatal) but a checker that cries wolf on every run is worse than no
 * checker, because people stop reading it.
 *
 * A small scanner rather than a regex: `//` inside a string is not a comment, and "https://x" in an
 * import specifier would otherwise swallow the rest of the line.
 */
function stripComments(source) {
  const text = String(source);
  let out = "";
  let i = 0;
  let quote = null;          // the quote character we are inside, or null
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (quote) {
      if (ch === "\\") { out += text.slice(i, i + 2); i += 2; continue; }
      if (ch === quote) quote = null;
      out += ch; i += 1; continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; out += ch; i += 1; continue; }
    if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      continue;                                   // the newline itself is copied next pass
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) {
        if (text[i] === "\n") out += "\n";        // keep the line count honest
        i += 1;
      }
      i += 2; continue;
    }
    out += ch; i += 1;
  }
  return out;
}

/**
 * The imports in one source file, with the line each sits on.
 *
 * Hand-rolled rather than a parser dependency: the shape being matched is narrow, and a build
 * server should not gain an AST toolchain to read the first ten lines of a file.
 */
export function parseImports(source) {
  const text = stripComments(String(source || ""));
  const found = [];
  for (const match of text.matchAll(IMPORT)) {
    const [whole, clause = "", specifier] = match;
    const line = text.slice(0, match.index).split("\n").length;
    if (!clause) {                       // import "./styles.css" — a side-effect import
      found.push({ specifier, named: [], default: null, namespace: null, line, sideEffect: true });
      continue;
    }
    const named = [];
    let defaultName = null;
    let namespace = null;

    const braces = clause.match(/\{([^}]*)\}/);
    if (braces) {
      for (const part of braces[1].split(",")) {
        const [imported, local] = part.trim().split(/\s+as\s+/).map((s) => s?.trim());
        if (imported && /^[A-Za-z_$][\w$]*$/.test(imported)) named.push({ name: imported, local: local || imported });
      }
    }
    const outside = clause.replace(/\{[^}]*\}/, "").replace(/,/g, " ").trim();
    const star = outside.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
    if (star) namespace = star[1];
    else if (outside && /^[A-Za-z_$][\w$]*$/.test(outside)) defaultName = outside;

    if (!named.length && !defaultName && !namespace) continue;
    found.push({ specifier, named, default: defaultName, namespace, line, raw: whole, sideEffect: false });
  }
  return found;
}

// ── local resolution ─────────────────────────────────────────────────────────────────────────
const EXTENSIONS = ["", ".js", ".jsx", ".ts", ".tsx", ".mjs", ".json", ".css",
  "/index.js", "/index.jsx", "/index.ts", "/index.tsx"];

// Tree paths are POSIX-ish and relative to the project root; resolve without touching node:path so
// this behaves identically on the Windows dev box and the Linux VPS.
function resolveRelative(fromPath, specifier) {
  const base = fromPath.split("/").slice(0, -1);
  const parts = specifier.split("/");
  const out = [...base];
  for (const part of parts) {
    if (part === "." || part === "") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

function resolveInTree(tree, fromPath, specifier) {
  const target = specifier.startsWith("@/") || specifier.startsWith("~/")
    ? `src/${specifier.slice(2)}`        // the scaffold's alias, mirrored by vite and jsconfig
    : resolveRelative(fromPath, specifier);
  for (const extension of EXTENSIONS) {
    if (Object.hasOwn(tree, `${target}${extension}`)) return `${target}${extension}`;
  }
  return null;
}

// ── deterministic substitution ───────────────────────────────────────────────────────────────
// lucide-react removed its brand icons. A generated app that wants an Instagram link is not wrong
// about what it wants, only about what the package still provides — and picking a sensible generic
// icon is a better outcome than failing the build over a decoration. These are curated, not
// guessed: each target is asserted to exist before it is used.
const BRAND_SUBSTITUTES = {
  Instagram: "Camera", Facebook: "MessageCircle", Twitter: "MessageCircle", X: "MessageCircle",
  Linkedin: "Briefcase", LinkedIn: "Briefcase", Github: "Code", GitHub: "Code", Gitlab: "Code",
  Youtube: "Play", YouTube: "Play", Twitch: "Video", Tiktok: "Music", TikTok: "Music",
  Slack: "MessageSquare", Discord: "MessageSquare", Whatsapp: "MessageCircle", WhatsApp: "MessageCircle",
  Figma: "Palette", Dribbble: "Palette", Behance: "Palette", Pinterest: "Image",
  Codepen: "Code", Chrome: "Globe", Firefox: "Globe", Safari: "Compass", Apple: "Smartphone",
};

/**
 * A safe replacement for a name the package does not export, or null.
 *
 * Only three moves are ever made, in descending confidence: lucide's own `XIcon` alias, a
 * difference of case alone, and the curated brand map. Anything cleverer — nearest edit distance
 * over 6 000 names — would silently substitute the wrong icon, which is a worse failure than an
 * honest error because nobody would notice it.
 */
export function substituteFor(name, surface) {
  if (!surface) return null;
  if (surface.has(`${name}Icon`)) return `${name}Icon`;
  const insensitive = [...surface].find((n) => n.toLowerCase() === String(name).toLowerCase());
  if (insensitive) return insensitive;
  const brand = BRAND_SUBSTITUTES[name];
  if (brand && surface.has(brand)) return brand;
  return null;
}

/**
 * Rewrite one named import as an ALIAS of the substitute: `Instagram` becomes `Camera as Instagram`.
 *
 * Aliasing rather than renaming, for two reasons. It touches one token in one line instead of every
 * occurrence across the file, so the diff stays honest about what changed. And renaming would
 * collide: a file importing both `Instagram` and `Camera` and having the first rewritten to the
 * second yields `{ Camera, Clock, Camera }` — a duplicate binding, a SyntaxError, and a brand new
 * build failure caused by the very thing meant to prevent one. `{ Camera, Clock, Camera as
 * Instagram }` is valid, and every existing `<Instagram />` in the JSX keeps working untouched.
 */
function applySubstitution(source, specifier, from, to) {
  const text = String(source);
  // Only inside the import clause for THIS specifier — never anywhere else in the file.
  const statement = new RegExp(
    `(import\\s*\\{[^}]*\\}\\s*from\\s*["']${specifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'])`,
  );
  return text.replace(statement, (clause) => clause.replace(
    new RegExp(`(\\{[^}]*?)\\b${from}\\b(?!\\s+as\\b)`), `$1${to} as ${from}`,
  ));
}

// ── the preflight ────────────────────────────────────────────────────────────────────────────
/**
 * Check every import in the tree.
 *
 * Returns `{ ok, problems, corrections, tree, checked }`. `tree` is the corrected tree when
 * substitutions were applied and the original object otherwise — callers can use it
 * unconditionally. `problems` are only the ones nothing could safely fix.
 */
export async function preflightImports(tree, { nodeModules, autoCorrect = true } = {}) {
  const problems = [];
  const corrections = [];
  let manifest = {};
  try {
    manifest = JSON.parse(tree["package.json"] || "{}");
  } catch {
    problems.push({ kind: "manifest_unparseable", file: "package.json", message: "package.json is not valid JSON." });
    return { ok: false, problems, corrections, tree, checked: 0 };
  }
  const declared = new Set([
    ...Object.keys(manifest.dependencies || {}),
    ...Object.keys(manifest.devDependencies || {}),
    ...Object.keys(manifest.peerDependencies || {}),
  ]);

  let working = tree;
  const edit = (file, next) => {
    if (working === tree) working = { ...tree };
    working[file] = next;
  };

  let checked = 0;
  for (const file of Object.keys(tree)) {
    if (!SOURCE.test(file)) continue;
    for (const statement of parseImports(tree[file])) {
      checked += 1;
      const { specifier, named, line } = statement;

      // 1. relative — must resolve to a file that was actually generated.
      if (specifier.startsWith(".") || specifier.startsWith("@/") || specifier.startsWith("~/")) {
        if (!resolveInTree(tree, file, specifier)) {
          problems.push({
            kind: "missing_local_module", file, line, specifier,
            message: `${file}:${line} imports "${specifier}", which does not exist in the project.`,
          });
        }
        continue;
      }

      // 2. bare — the package must be in the manifest. Node builtins are not.
      const packageName = specifier.startsWith("@")
        ? specifier.split("/").slice(0, 2).join("/")
        : specifier.split("/")[0];
      if (specifier.startsWith("node:")) continue;
      if (!declared.has(packageName)) {
        // Declared is not the same as resolvable. `vite.config.js` imports `vite` and
        // `@vitejs/plugin-react`, which live in the shared scaffold's node_modules and are
        // deliberately absent from the generated manifest — flagging those would fail every real
        // build, which is the exact failure mode this preflight exists to prevent. The honest
        // question is whether the import RESOLVES, so ask node_modules before reporting.
        if (nodeModules && await isInstalled(packageName, nodeModules)) continue;
        problems.push({
          kind: "missing_dependency", file, line, specifier, package: packageName,
          message: `${file}:${line} imports "${specifier}", but "${packageName}" is neither in package.json nor installed.`,
        });
        continue;
      }

      // 3. named imports — only when the surface is KNOWN, and only for the package root.
      if (!named.length || specifier !== packageName || !nodeModules) continue;
      const surface = await exportSurface(packageName, { nodeModules });
      if (!surface) continue; // unreadable or CJS — unknown, so say nothing

      for (const { name } of named) {
        if (surface.has(name)) continue;
        const version = await installedVersion(packageName, { nodeModules });
        const replacement = autoCorrect ? substituteFor(name, surface) : null;

        if (replacement) {
          edit(file, applySubstitution(working[file] ?? tree[file], specifier, name, replacement));
          corrections.push({
            kind: "substituted_export", file, line, package: packageName, version,
            from: name, to: replacement,
            message: `${file}:${line} imported "${name}" from ${packageName}@${version}, which does not export it. Substituted "${replacement} as ${name}".`,
          });
          continue;
        }
        problems.push({
          kind: "missing_export", file, line, package: packageName, version, name,
          // Phrased exactly as the compiler would have, so the fingerprint and the brief match the
          // error a build would have produced — the preflight replaces the build, not the vocabulary.
          message: `${file}:${line} imports "${name}" from "${packageName}", but ${packageName}@${version} does not export it.`,
        });
      }
    }
  }

  return { ok: problems.length === 0, problems, corrections, tree: working, checked };
}

/** One line per finding, for the diagnostics step and the repair brief. */
export function preflightSummary({ problems = [], corrections = [], checked = 0 }) {
  const parts = [`Checked ${checked} import${checked === 1 ? "" : "s"}.`];
  if (corrections.length) parts.push(`Corrected ${corrections.length}: ${corrections.map((c) => `${c.from} → ${c.to}`).join(", ")}.`);
  if (problems.length) parts.push(`Unresolved: ${problems.length}.`);
  else parts.push("All imports resolve.");
  return parts.join(" ");
}
