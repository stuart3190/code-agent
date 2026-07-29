// The file-edit toolset the model drives. All tools stay ABOVE the provider seam:
// plain JSON-schema tools the model chooses, with no Codex specifics.
//
//   makeFileTools(tree, { editFormat } = {}) -> { schemas, impls, stats }
//
// list_files / read_file / write_file are always present (write_file = the proven
// Phase 1 full-rewrite path — the reliability floor). When `editFormat` is set, a
// targeted edit tool is ALSO declared so output can scale with change size:
//   "apply_patch"     -> Codex-native V4A envelope (tool: apply_patch)
//   "search_replace"  -> exact search/replace pairs (tool: edit_file)
//
// On a failed edit the impl returns a STRUCTURED error plus the current file contents
// (the region to fix) — runAgent feeds that back next turn, which IS the repair loop.
// After N failed edits on a path the error tells the model to write_file the whole file
// instead (fallback to the proven path). impls are bound to the in-memory `tree` and
// mutate it in place. `stats()` reports edit attempts/applies/failures/fallbacks.

import { applyPatchV4A } from "./edit/applyPatchV4A.mjs";
import { applySearchReplace } from "./edit/searchReplace.mjs";

const FALLBACK_AFTER = 2; // N: failed edits on one path before nudging to full rewrite

export function makeFileTools(tree, { editFormat } = {}) {
  const stat = { attempts: 0, applies: 0, failures: 0, fallbacks: 0, writes: 0, failsByPath: {} };
  const bumpFail = (p) => {
    const n = (stat.failsByPath[p] = (stat.failsByPath[p] || 0) + 1);
    return n;
  };
  const fallbackNote = (p) =>
    ` This edit has now failed ${FALLBACK_AFTER}+ times on ${p}. Stop patching and call write_file with the COMPLETE updated contents of ${p} instead.`;

  const impls = {
    list_files: () => ({ files: Object.keys(tree).sort() }),

    read_file: ({ path: p }) =>
      p in tree ? { contents: tree[p] } : { error: `no such file: ${p}` },

    write_file: ({ path: p, contents }) => {
      if (typeof p !== "string" || typeof contents !== "string") {
        return { error: "write_file requires string `path` and string `contents`" };
      }
      const existed = p in tree;
      tree[p] = contents;
      stat.writes += 1;
      delete stat.failsByPath[p]; // a full rewrite clears the failure streak
      return { ok: true, path: p, bytes: Buffer.byteLength(contents), created: !existed };
    },
  };

  const schemas = [
    {
      name: "list_files",
      description: "List every file path currently in the project.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "read_file",
      description: "Read the full contents of one file.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "File path, e.g. src/App.jsx" } },
        required: ["path"],
        additionalProperties: false,
      },
    },
    {
      name: "write_file",
      description:
        "Create or overwrite a file with full contents. Use for new files, or as the fallback when a targeted edit will not apply.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path to write" },
          contents: { type: "string", description: "Complete file contents" },
        },
        required: ["path", "contents"],
        additionalProperties: false,
      },
    },
  ];

  if (editFormat === "apply_patch") {
    impls.apply_patch = ({ input }) => {
      stat.attempts += 1;
      if (typeof input !== "string") {
        stat.failures += 1;
        return { error: "apply_patch requires a string `input` containing the patch envelope" };
      }
      const r = applyPatchV4A(tree, input);
      if (r.ok) {
        for (const p of r.changed) {
          if (p in r.tree) tree[p] = r.tree[p];
          else delete tree[p];
          delete stat.failsByPath[p];
        }
        stat.applies += 1;
        return { ok: true, changed: r.changed };
      }
      stat.failures += 1;
      const p = r.path;
      const n = p ? bumpFail(p) : 0;
      const out = {
        error: r.reason,
        path: p,
        failedHunk: r.failedHunk,
        currentContents: p && p in tree ? tree[p] : undefined,
      };
      if (p && n >= FALLBACK_AFTER) {
        stat.fallbacks += 1;
        out.error += fallbackNote(p);
      }
      return out;
    };
    schemas.push({
      name: "apply_patch",
      description:
        "Apply a targeted patch to existing files (cheaper than rewriting whole files). " +
        "`input` is a patch in this exact format:\n" +
        "*** Begin Patch\n*** Update File: <path>\n@@\n <unchanged context line>\n-<removed line>\n+<added line>\n*** End Patch\n" +
        "Context/removed lines must match the file EXACTLY (whitespace included). Prefer this over write_file for edits to existing files.",
      parameters: {
        type: "object",
        properties: { input: { type: "string", description: "The *** Begin Patch ... *** End Patch envelope" } },
        required: ["input"],
        additionalProperties: false,
      },
    });
  } else if (editFormat === "search_replace") {
    impls.edit_file = ({ path: p, edits }) => {
      stat.attempts += 1;
      if (typeof p !== "string") {
        stat.failures += 1;
        return { error: "edit_file requires a string `path`" };
      }
      if (!(p in tree)) {
        stat.failures += 1;
        return { error: `no such file: ${p}` };
      }
      const r = applySearchReplace(tree[p], edits);
      if (r.ok) {
        tree[p] = r.contents;
        stat.applies += 1;
        delete stat.failsByPath[p];
        return { ok: true, path: p, bytes: Buffer.byteLength(r.contents) };
      }
      stat.failures += 1;
      const n = bumpFail(p);
      const out = { error: r.reason, path: p, search: r.search, currentContents: tree[p] };
      if (n >= FALLBACK_AFTER) {
        stat.fallbacks += 1;
        out.error += fallbackNote(p);
      }
      return out;
    };
    schemas.push({
      name: "edit_file",
      description:
        "Apply targeted edits to one existing file (cheaper than rewriting it). `edits` is an " +
        "ordered list of {search, replace}; each `search` must match the file EXACTLY once " +
        "(include enough surrounding context to be unique). Prefer this over write_file for edits.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File to edit" },
          edits: {
            type: "array",
            description: "Ordered exact-match replacements",
            items: {
              type: "object",
              properties: {
                search: { type: "string", description: "Exact text to find (unique in the file)" },
                replace: { type: "string", description: "Replacement text" },
              },
              required: ["search", "replace"],
              additionalProperties: false,
            },
          },
        },
        required: ["path", "edits"],
        additionalProperties: false,
      },
    });
  }

  return { schemas, impls, stats: () => ({ ...stat, failsByPath: { ...stat.failsByPath } }) };
}
