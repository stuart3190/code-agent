// File tools that will not let a stage rediscover the whole project.
//
// Selecting a small initial context achieves nothing if the model then calls read_file thirty
// times and rebuilds the tree anyway. That is exactly what happened: the Supporting stage's
// 292,652 input tokens were overwhelmingly repeated reads, 81% of them cached, of files it had
// already been shown or did not need.
//
// So the selection is enforced at the tool boundary, not merely suggested in a prompt. Files in the
// selected set read freely. Everything else returns its manifest summary — exports, imports,
// entities, routes, who uses it — which is usually the actual question, and offers an explicit
// expansion path for when it is not. Expansions are counted, budgeted and recorded.

import { makeFileTools } from "../../../../src/tools/fileTools.mjs";
import { summariseFile, tokensOf } from "./projectManifest.mjs";

// A stage that needs more than this many extra files was given the wrong scope; the fix is the
// selection, not a bigger allowance.
const DEFAULT_MAX_EXPANSIONS = 6;

/**
 * Wrap the ordinary file tools with a scope.
 *
 * `allowed` is the selected set. `manifest` answers everything else. Writes are unrestricted:
 * refusing a write would make a stage fail rather than overreach, and the stage gate already
 * checks what it produced.
 */
export function makeScopedFileTools(tree, {
  manifest, allowed = [], editFormat, maxExpansions = DEFAULT_MAX_EXPANSIONS, maxExpansionTokens = 12_000,
  onEvent = () => {},
} = {}) {
  const base = makeFileTools(tree, { editFormat });
  const open = new Set(allowed);
  const telemetry = {
    fullReads: [], summaryReads: [], expansions: [], refusals: [],
    expansionTokens: 0,
    get expansionCount() { return this.expansions.length; },
  };

  const schemas = base.schemas.map((schema) => {
    if (schema.name === "read_file") {
      return {
        ...schema,
        description: "Read a file you have been given. For a file you have NOT been given, this "
          + "returns its interface summary (exports, imports, entities, routes, callers), which is "
          + "usually what you need. If you genuinely need its implementation, call it again with "
          + "`reason` explaining which of your changes depends on it.",
        parameters: {
          ...schema.parameters,
          properties: {
            ...schema.parameters.properties,
            reason: { type: "string", description: "Why this file's implementation is required for the change you are making." },
          },
        },
      };
    }
    if (schema.name === "list_files") {
      return {
        ...schema,
        description: "List the project's file paths. Use the manifest in your instructions for what "
          + "each one contains — do not read files just to find out what they are.",
      };
    }
    return schema;
  });

  const impls = {
    ...base.impls,

    // Unchanged: knowing the paths is cheap and the manifest already describes them.
    list_files: base.impls.list_files,

    read_file: ({ path, reason }) => {
      if (!(path in tree)) return base.impls.read_file({ path });

      if (open.has(path)) {
        telemetry.fullReads.push(path);
        return base.impls.read_file({ path });
      }

      const file = manifest?.get?.(path);
      const summary = file ? summariseFile(file) : null;

      // A stated reason buys the implementation, within budget. Without one, the summary is the
      // answer — and for "what does this export" it is the better answer.
      if (reason && String(reason).trim().length > 12) {
        const cost = tokensOf(tree[path]);
        if (telemetry.expansionCount >= maxExpansions || telemetry.expansionTokens + cost > maxExpansionTokens) {
          telemetry.refusals.push({ path, reason: "expansion budget exhausted" });
          onEvent({ type: "refused", path, why: "expansion budget exhausted" });
          return {
            error: `Context budget reached (${telemetry.expansionCount} expansions, ${telemetry.expansionTokens} tokens). `
              + `Here is the interface instead:\n${summary || "(no summary available)"}`,
          };
        }
        open.add(path);
        telemetry.expansions.push({ path, reason: String(reason).slice(0, 200), tokens: cost });
        telemetry.expansionTokens += cost;
        onEvent({ type: "expanded", path, tokens: cost, reason });
        return base.impls.read_file({ path });
      }

      telemetry.summaryReads.push(path);
      onEvent({ type: "summary", path });
      return {
        path,
        interface: summary || "(not in the manifest)",
        note: "This file is outside your change set, so you have its interface rather than its body. "
          + "If you need the implementation, call read_file again with `reason`.",
      };
    },
  };

  return {
    schemas,
    impls,
    telemetry,
    stats: base.stats,

    /**
     * Did this stage rebuild the project through tools?
     *
     * The failure this whole mechanism exists to prevent, checked rather than assumed.
     */
    reconstructedTree(totalFiles) {
      const seen = new Set([...open]);
      return totalFiles > 0 && seen.size > totalFiles * 0.5;
    },
  };
}
