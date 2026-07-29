// Format B applier — Aider-style exact search/replace.
//
// Applies an ordered list of { search, replace } edits to a single file's contents.
// Each `search` must match EXACTLY once: zero matches or multiple matches are a
// structured failure (whitespace/misremembered context is the common cause). Edits
// apply sequentially, so later searches see the result of earlier replaces.
//
//   applySearchReplace(contents, edits) -> { ok, contents } | { ok:false, reason, search }

export function applySearchReplace(contents, edits) {
  if (!Array.isArray(edits) || edits.length === 0) {
    return { ok: false, reason: "edits must be a non-empty array of {search, replace}" };
  }

  let out = contents;
  for (const edit of edits) {
    const { search, replace } = edit ?? {};
    if (typeof search !== "string" || typeof replace !== "string") {
      return { ok: false, reason: "each edit needs string `search` and string `replace`", search };
    }
    if (search === "") {
      return { ok: false, reason: "`search` must not be empty", search };
    }

    const first = out.indexOf(search);
    if (first === -1) {
      return { ok: false, reason: "search text not found (check exact whitespace/quotes)", search };
    }
    if (out.indexOf(search, first + 1) !== -1) {
      return {
        ok: false,
        reason: "search text is ambiguous — it matches more than once; include more surrounding context",
        search,
      };
    }
    out = out.slice(0, first) + replace + out.slice(first + search.length);
  }

  return { ok: true, contents: out };
}
