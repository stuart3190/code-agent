// The file-edit toolset the model drives — list / read / write_file.
// These stay ABOVE the provider seam: they're plain JSON-schema tools the model
// chooses, with no Codex specifics. `write_file` overwrites whole files (the proven
// Phase 1 full-rewrite path); a targeted edit tool is Phase 2.1, not here.
//
// makeFileTools(tree) -> { schemas, impls } — impls are bound to the given in-memory
// tree (a { [path]: contents } map) and mutate it in place.

export function makeFileTools(tree) {
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
      description: "Create or overwrite a file with full contents.",
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

  return { schemas, impls };
}
