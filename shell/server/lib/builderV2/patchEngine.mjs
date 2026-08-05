// Structured Patch Engine (finish plan WP-2; master plan Part 2 §7 / Part 8).
//
// The model emits OPERATIONS on symbols, not whole files: outputs shrink to what changed,
// and every operation is VALIDATED against the deterministic index before it touches the
// tree. A rejected op rejects with a machine reason the model can act on; two rejections of
// the same op escalate that FILE to whole-file regeneration — never a silent partial write,
// never a guessed anchor.

import { indexFile } from "./indexerV0.mjs";
import { modularityCheck } from "../appBuild/modularity.mjs";

export const PROTECTED_PATHS = Object.freeze([
  /^src\/lib\/backend\//,
  /^src\/lib\/visitorSession\.js$/,
  /^src\/lib\/capabilities\//,
]);

// The strict tool schema the orchestrator will register (strict tools proven since P18:
// every property required, optionals nullable).
export const EMIT_PATCHES_SCHEMA = Object.freeze({
  name: "emit_patches",
  description: "Apply your changes as symbol-level operations. Every op is validated against "
    + "the code index; a rejected op comes back with the exact reason. Use newFile for files "
    + "that do not exist yet; never rewrite a whole existing file through newFile.",
  strict: true,
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["patches"],
    properties: {
      patches: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["file", "ops", "newFile", "content", "deleteFile"],
          properties: {
            file: { type: ["string", "null"], description: "Existing file to modify with ops" },
            ops: {
              type: ["array", "null"],
              items: {
                type: "object",
                additionalProperties: false,
                required: ["op", "symbol", "content"],
                properties: {
                  op: { type: "string", enum: ["replace_symbol", "insert_after_symbol", "insert_before_symbol", "delete_symbol", "append"] },
                  symbol: { type: ["string", "null"] },
                  content: { type: ["string", "null"] },
                },
              },
            },
            newFile: { type: ["string", "null"], description: "Path of a file to CREATE" },
            content: { type: ["string", "null"], description: "Content for newFile" },
            deleteFile: { type: ["string", "null"], description: "Path of a file to DELETE" },
          },
        },
      },
    },
  },
});

const isProtected = (path) => PROTECTED_PATHS.some((re) => re.test(path));

function opSignature(patch, op) {
  if (patch.newFile) return `new:${patch.newFile}`;
  if (patch.deleteFile) return `del:${patch.deleteFile}`;
  return `${patch.file}:${op.op}:${op.symbol || ""}`;
}

/**
 * Apply a batch of patches to a tree, validating every operation against the CURRENT index
 * of the file it touches. Returns the new tree plus applied/rejected lists; the input tree
 * is never mutated. `contract` enables the modularity re-check on every changed file.
 */
export function applyPatches(tree, patches, { contract = null } = {}) {
  const working = { ...tree };
  const applied = [];
  const rejected = [];
  const reject = (patch, op, reason) => rejected.push({ signature: opSignature(patch, op || {}), reason });

  for (const patch of patches || []) {
    // ── create ───────────────────────────────────────────────────────────────────────────
    if (patch.newFile) {
      if (patch.newFile in working) { reject(patch, null, `newFile: ${patch.newFile} already exists — use ops to modify it`); continue; }
      if (isProtected(patch.newFile)) { reject(patch, null, `newFile: ${patch.newFile} is protected platform infrastructure`); continue; }
      const probe = indexFile(patch.newFile, patch.content || "");
      if (probe.opaque && /\.(jsx?|tsx?|mjs|cjs)$/.test(patch.newFile)) {
        reject(patch, null, `newFile: content for ${patch.newFile} does not parse (unbalanced braces or no structure)`);
        continue;
      }
      working[patch.newFile] = String(patch.content || "");
      applied.push({ signature: opSignature(patch, {}), file: patch.newFile, kind: "newFile" });
      continue;
    }

    // ── delete ───────────────────────────────────────────────────────────────────────────
    if (patch.deleteFile) {
      if (!(patch.deleteFile in working)) { reject(patch, null, `deleteFile: ${patch.deleteFile} does not exist`); continue; }
      if (isProtected(patch.deleteFile)) { reject(patch, null, `deleteFile: ${patch.deleteFile} is protected platform infrastructure`); continue; }
      if (/^src\/(routes|data)\//.test(patch.deleteFile)) {
        reject(patch, null, `deleteFile: ${patch.deleteFile} — route/data modules from earlier stages are never deleted by a patch (anti-collapse)`);
        continue;
      }
      delete working[patch.deleteFile];
      applied.push({ signature: opSignature(patch, {}), file: patch.deleteFile, kind: "deleteFile" });
      continue;
    }

    // ── symbol ops on an existing file ───────────────────────────────────────────────────
    const file = patch.file;
    if (!file || !(file in working)) { reject(patch, null, `file ${file} does not exist — use newFile to create files`); continue; }
    if (isProtected(file)) { reject(patch, null, `${file} is protected platform infrastructure and cannot be patched`); continue; }

    for (const op of patch.ops || []) {
      const current = String(working[file]);
      const index = indexFile(file, current);
      if (index.opaque) { reject(patch, op, `${file} is opaque to the index — only whole-file regeneration can change it`); continue; }

      if (op.op === "append") {
        const candidate = `${current}\n${op.content || ""}`;
        const probe = indexFile(file, candidate);
        if (probe.opaque) { reject(patch, op, "append: resulting file does not parse"); continue; }
        working[file] = candidate;
        applied.push({ signature: opSignature(patch, op), file, kind: op.op });
        continue;
      }

      const symbol = index.symbols.find((s) => s.name === op.symbol);
      if (!symbol) {
        const known = index.symbols.map((s) => s.name).join(", ");
        reject(patch, op, `symbol "${op.symbol}" not found in ${file} — present symbols: ${known}`);
        continue;
      }

      let candidate;
      if (op.op === "replace_symbol") {
        candidate = current.slice(0, symbol.start) + String(op.content || "") + current.slice(symbol.end);
      } else if (op.op === "delete_symbol") {
        candidate = current.slice(0, symbol.start) + current.slice(symbol.end);
      } else if (op.op === "insert_after_symbol") {
        candidate = `${current.slice(0, symbol.end)}\n${op.content || ""}\n${current.slice(symbol.end)}`;
      } else if (op.op === "insert_before_symbol") {
        candidate = `${current.slice(0, symbol.start)}${op.content || ""}\n${current.slice(symbol.start)}`;
      } else {
        reject(patch, op, `unknown op ${op.op}`);
        continue;
      }

      const probe = indexFile(file, candidate);
      if (probe.opaque) { reject(patch, op, `${op.op} on ${op.symbol}: resulting file does not parse — check braces in your content`); continue; }
      working[file] = candidate;
      applied.push({ signature: opSignature(patch, op), file, kind: op.op });
    }
  }

  // ── modularity re-check over every changed file (the gate that stops re-monolith) ────────
  const changedFiles = [...new Set(applied.map((a) => a.file))].filter((f) => f in working);
  if (changedFiles.length) {
    const scope = Object.fromEntries(changedFiles.map((f) => [f, working[f]]));
    const modular = modularityCheck(scope, { contract });
    if (!modular.ok) {
      // The batch violated a structural invariant: the WHOLE batch is rejected — a tree that
      // half-applied its way into a monolith would be worse than a clean refusal.
      return {
        tree, applied: [], rejected: [
          ...rejected,
          ...modular.problems.map((p) => ({ signature: "modularity", reason: p })),
        ],
        modularityFailed: true,
      };
    }
  }

  return { tree: working, applied, rejected, modularityFailed: false };
}

/**
 * Escalation rule (Part 8): the same op rejected twice means the model cannot land it —
 * that FILE moves to whole-file regeneration. Pure over the accumulated rejection history.
 */
export function escalationPlan(rejectionHistory) {
  const counts = new Map();
  for (const rejection of rejectionHistory) {
    counts.set(rejection.signature, (counts.get(rejection.signature) || 0) + 1);
  }
  const files = new Set();
  for (const [signature, count] of counts) {
    if (count >= 2) {
      const file = signature.startsWith("new:") || signature.startsWith("del:")
        ? signature.slice(4)
        : signature.split(":")[0];
      files.add(file);
    }
  }
  return { regenerateFiles: [...files].sort() };
}

/** Persist a patch outcome to bv2_patches (audit trail; failures never block the build). */
export async function recordPatch({ owner, buildId, step, modelCallId = null, patch, outcome, rejectReason = null, filesChanged = [] }, { client } = {}) {
  if (!client) return;
  try {
    const { error } = await client.from("bv2_patches").insert({
      owner, build_id: buildId, step, model_call_id: modelCallId,
      patch, outcome, reject_reason: rejectReason, files_changed: filesChanged,
    });
    if (error) throw new Error(error.message);
  } catch (error) {
    console.error(`[bv2] patch record failed (build continues): ${error.message}`);
  }
}
