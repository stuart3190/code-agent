// Tier 1: fixes that need no model at all.
//
// The 28-credit repair round was a model reading 355,772 input tokens to make a change that, for
// the most common defect class, is mechanical. Anything checkable without an LLM must never
// consume model credits — and some things are FIXABLE without one too.
//
// Deliberately narrow. Each transform below is one whose correct output is fully determined by the
// input; anything requiring judgement is left to Tier 2. A deterministic fix that guesses would be
// worse than an expensive one that reasons.

/**
 * Rewrite a module that stores records in the browser so it stores them in the database.
 *
 * Only attempted when the shape is the recognisable one: a module whose exported functions read
 * and write a single localStorage/sessionStorage key holding a JSON array. That is exactly what
 * every generated fake-persistence layer has looked like, and its translation to db.entity() is
 * unambiguous.
 *
 * Returns null when the shape is not recognised — which is the answer that keeps this honest.
 */
export function repairFakePersistence(source, { entity }) {
  const text = String(source || "");
  if (!entity) return null;

  // The key this module keeps everything under. Multiple different keys means multiple concerns,
  // and this transform is not smart enough for that.
  const keys = [...new Set([...text.matchAll(/\b(?:localStorage|sessionStorage)\s*\.\s*(?:getItem|setItem|removeItem)\s*\(\s*["'`]([^"'`]+)["'`]/g)]
    .map((m) => m[1]))];
  if (keys.length !== 1) return null;

  // Anything beyond a JSON array in a single key is out of scope.
  if (!/JSON\.parse\s*\(\s*(?:localStorage|sessionStorage)/.test(text)) return null;

  const exported = [...text.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)].map((m) => m[1]);
  if (!exported.length) return null;

  const importLine = /from\s+["'][^"']*lib\/backend["']/.test(text)
    ? ""
    : `import { db } from "../lib/backend";\n\n`;

  // The module is rewritten rather than patched: the point is that no browser storage remains, and
  // surgical edits to this shape reliably leave one call behind.
  const body = [
    `// Rewritten to use the real database. The previous implementation kept "${keys[0]}" in browser`,
    "// storage, which survives a reload on one machine and is invisible everywhere else.",
    "",
    ...exported.map((name) => {
      const lower = name.toLowerCase();
      if (/^(list|get|load|fetch|read|all)/.test(lower)) {
        return `export async function ${name}() {\n  return db.entity("${entity}").list();\n}\n`;
      }
      if (/^(create|add|save|store|insert|new)/.test(lower)) {
        return `export async function ${name}(record) {\n  return db.entity("${entity}").create(record);\n}\n`;
      }
      if (/^(update|edit|modify|patch)/.test(lower)) {
        return `export async function ${name}(id, patch) {\n  return db.entity("${entity}").update(id, patch);\n}\n`;
      }
      if (/^(delete|remove|cancel|destroy)/.test(lower)) {
        return `export async function ${name}(id) {\n  return db.entity("${entity}").delete(id);\n}\n`;
      }
      // An exported function whose purpose is not evident from its name. Bail out entirely rather
      // than emit a stub — a silently wrong function is worse than an unrepaired module.
      return null;
    }),
  ];
  if (body.some((line) => line === null)) return null;

  return `${importLine}${body.join("\n")}`;
}

/**
 * Try every deterministic repair that applies to these findings.
 *
 * Returns `{ tree, repaired, remaining }`. `repaired` lists what was fixed for free; `remaining`
 * is what still needs a model. A build where `remaining` is empty never makes a repair call.
 */
export function deterministicRepairs(tree, { findings = [], contract = null } = {}) {
  const working = { ...tree };
  const repaired = [];
  const remaining = [];
  const entities = contract?.entities || [];

  // Group persistence findings by the file they are in: the transform rewrites whole modules.
  const byFile = new Map();
  for (const finding of findings) {
    if (finding.id !== "fake_persistence" || !finding.file) { remaining.push(finding); continue; }
    if (!byFile.has(finding.file)) byFile.set(finding.file, []);
    byFile.get(finding.file).push(finding);
  }

  for (const [file, fileFindings] of byFile) {
    // Which entity is this module about? Its own name is the best evidence available.
    const entity = entities.find((e) => file.toLowerCase().includes(String(e.name).toLowerCase()))
      || (entities.length === 1 ? entities[0] : null);
    const rewritten = entity ? repairFakePersistence(working[file], { entity: entity.name }) : null;

    if (rewritten) {
      working[file] = rewritten;
      repaired.push({ file, entity: entity.name, findings: fileFindings.length, kind: "fake_persistence" });
    } else {
      remaining.push(...fileFindings);
    }
  }

  return { tree: working, repaired, remaining };
}

/** One line for the log and the profile. */
export function deterministicSummary(result) {
  if (!result.repaired.length) return "no deterministic repair applied";
  return `repaired ${result.repaired.length} module(s) with no model call: `
    + result.repaired.map((r) => `${r.file} → db.entity("${r.entity}")`).join(", ");
}
