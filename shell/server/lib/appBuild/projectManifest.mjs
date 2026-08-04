// What is in this project, without reading all of it.
//
// The Supporting stage consumed 292,652 input tokens against 7,920 out. It reached that by
// re-reading the accumulated tree on every turn: by the time it ran, four stages of files existed,
// and nothing distinguished "the file I am about to change" from "a file that happens to exist".
//
// A manifest is the cheap answer to "what exists and what does it do". It is derived from the tree
// by parsing, never by a model — a summary that costs a model call to produce has not saved
// anything — and it is small enough to send in full to every stage.

const SOURCE = /\.(jsx?|tsx?|mjs)$/;
const IS_APP = (path) => path.startsWith("src/") && SOURCE.test(path);

// ── extraction ────────────────────────────────────────────────────────────────────────────────

function stripComments(source) {
  return String(source)
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p) => p + m.slice(p.length).replace(/./g, " "));
}

function exportsOf(code) {
  const names = new Set();
  for (const m of code.matchAll(/export\s+(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)/g)) {
    names.add(`${m[1]}(${m[2].trim().slice(0, 60)})`);
  }
  for (const m of code.matchAll(/export\s+(?:const|let|var|class)\s+(\w+)/g)) names.add(m[1]);
  for (const m of code.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (name) names.add(name);
    }
  }
  if (/export\s+default\s+function\s+(\w+)/.test(code)) {
    names.add(`default:${code.match(/export\s+default\s+function\s+(\w+)/)[1]}`);
  } else if (/export\s+default/.test(code)) names.add("default");
  return [...names];
}

function importsOf(code) {
  return [...new Set([...code.matchAll(/import\s+[^;]*?from\s*["']([^"']+)["']/g)].map((m) => m[1]))];
}

function entitiesOf(code) {
  return [...new Set([...code.matchAll(/db\s*\.\s*entity\s*\(\s*["'`]([^"'`]+)["'`]/g)].map((m) => m[1]))];
}

function routesOf(code) {
  const routes = new Set();
  for (const m of code.matchAll(/(?:path|route)\s*[:=]\s*["'`](\/[^"'`]*)["'`]/g)) routes.add(m[1]);
  for (const m of code.matchAll(/["'`](\/(?:book|admin|manage|visit|about|login|signup)[\w/-]*)["'`]/g)) routes.add(m[1]);
  return [...routes];
}

function envOf(code) {
  return [...new Set([...code.matchAll(/import\.meta\.env\.(\w+)/g)].map((m) => m[1]))];
}

// The functional areas a file belongs to. Shared vocabulary with the verification cache, so the
// impact map answers "what must I re-verify" and "what must I send" with the same words.
export function areasOf(path, code = "") {
  const areas = new Set();
  const text = `${path} ${code.slice(0, 4000)}`;
  if (path.startsWith("src/lib/backend/")) areas.add("backend");
  if (/\.(css|scss)$/.test(path)) areas.add("style");
  if (/auth|login|signup|session|account/i.test(text)) areas.add("auth");
  if (/db\.entity|localStorage|sessionStorage|persist|repository/i.test(text)) areas.add("data");
  if (/booking|reservation|order|checkout|cart|payment/i.test(text)) areas.add("booking");
  if (/newsletter|subscri/i.test(text)) areas.add("newsletter");
  if (/route|router|nav|navigation/i.test(text)) areas.add("routing");
  if (SOURCE.test(path)) areas.add("ui");
  return [...areas];
}

/** Roughly how many tokens a string costs. Four characters per token is close enough to budget on. */
export const tokensOf = (text) => Math.ceil(String(text || "").length / 4);

/**
 * Build the manifest.
 *
 * `stages` optionally maps a path to the stage that last wrote it, from the staged build's own
 * record — the pipeline already knows this and it is what makes "unchanged since it was verified"
 * answerable.
 */
export function buildManifest(tree, { contract = null, stages = {}, verified = {} } = {}) {
  const files = [];
  for (const [path, raw] of Object.entries(tree || {})) {
    const source = String(raw || "");
    const code = IS_APP(path) ? stripComments(source) : "";
    files.push({
      path,
      tokens: tokensOf(source),
      exports: code ? exportsOf(code) : [],
      imports: code ? importsOf(code) : [],
      entities: code ? entitiesOf(code) : [],
      routes: code ? routesOf(code) : [],
      env: code ? envOf(code) : [],
      areas: areasOf(path, code),
      createdStage: stages[path]?.created || null,
      lastChangedStage: stages[path]?.lastChanged || null,
      verifiedAt: verified[path] || null,
    });
  }

  // Who imports whom, resolved to real paths so "direct callers" is answerable without re-reading.
  const byPath = new Map(files.map((f) => [f.path, f]));
  const importers = new Map();
  for (const file of files) {
    for (const specifier of file.imports) {
      if (!specifier.startsWith(".")) continue;
      const resolved = resolveRelative(file.path, specifier, byPath);
      if (!resolved) continue;
      if (!importers.has(resolved)) importers.set(resolved, []);
      importers.get(resolved).push(file.path);
    }
  }
  for (const file of files) file.importedBy = importers.get(file.path) || [];

  return {
    files,
    totalTokens: files.reduce((sum, f) => sum + f.tokens, 0),
    routes: [...new Set(files.flatMap((f) => f.routes))],
    entities: [...new Set(files.flatMap((f) => f.entities))],
    contractEntities: (contract?.entities || []).map((e) => e.name),
    env: [...new Set(files.flatMap((f) => f.env))],
    get(path) { return byPath.get(path) || null; },
  };
}

function resolveRelative(fromPath, specifier, byPath) {
  const base = fromPath.split("/").slice(0, -1);
  const out = [...base];
  for (const part of specifier.split("/")) {
    if (part === "." || part === "") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  const target = out.join("/");
  for (const ext of ["", ".js", ".jsx", ".ts", ".tsx", "/index.js", "/index.jsx"]) {
    if (byPath.has(`${target}${ext}`)) return `${target}${ext}`;
  }
  return null;
}

/**
 * A file's summary: enough to reason about it without its body.
 *
 * Every field is extracted, never described. This is what a stage gets for a green file it is not
 * changing — and it is roughly a fortieth of the file's own token cost.
 */
export function summariseFile(file) {
  const parts = [`${file.path}`];
  if (file.exports.length) parts.push(`  exports: ${file.exports.join(", ")}`);
  if (file.imports.length) parts.push(`  imports: ${file.imports.join(", ")}`);
  if (file.entities.length) parts.push(`  entities: ${file.entities.join(", ")}`);
  if (file.routes.length) parts.push(`  routes: ${file.routes.join(", ")}`);
  if (file.env.length) parts.push(`  env: ${file.env.join(", ")}`);
  if (file.importedBy?.length) parts.push(`  used by: ${file.importedBy.join(", ")}`);
  parts.push(`  areas: ${file.areas.join(", ")}${file.verifiedAt ? " · verified" : ""}`);
  return parts.join("\n");
}

/** The whole manifest, rendered for a prompt. */
export function renderManifest(manifest) {
  return [
    "PROJECT MANIFEST — what exists. Ask for a file only if you need its implementation.",
    ...manifest.files.map(summariseFile),
  ].join("\n");
}
