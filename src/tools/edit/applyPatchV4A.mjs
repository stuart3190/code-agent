// Format A applier — Codex's native `apply_patch` V4A envelope.
//
//   *** Begin Patch
//   *** Update File: src/App.jsx
//   @@ optional locator hint
//    context line (leading space)
//   -removed line
//   +added line
//   *** End Patch
//
// Also supports `*** Add File: <path>` (followed by `+` lines) and
// `*** Delete File: <path>`. Location is found by EXACT match of each hunk's
// context+removed lines — no line numbers (they drift). A hunk whose context can't be
// found is a structured failure so the model can repair.
//
//   applyPatchV4A(tree, patchText) -> { ok, tree, changed } | { ok:false, reason, path?, failedHunk? }
//
// `tree` is a { [path]: contents } map; the returned `tree` is a new object (the input
// is not mutated). All-or-nothing: the first failing op aborts the whole patch.

const H_UPDATE = "*** Update File:";
const H_ADD = "*** Add File:";
const H_DELETE = "*** Delete File:";

export function applyPatchV4A(tree, patchText) {
  if (typeof patchText !== "string" || patchText.trim() === "") {
    return { ok: false, reason: "patch is empty" };
  }

  let ops;
  try {
    ops = parseV4A(patchText);
  } catch (e) {
    return { ok: false, reason: `patch parse error: ${e.message}` };
  }
  if (ops.length === 0) {
    return { ok: false, reason: "no file operations found (expected *** Update/Add/Delete File:)" };
  }

  const next = { ...tree };
  const changed = [];
  for (const op of ops) {
    if (op.type === "update") {
      if (!(op.path in next)) {
        return { ok: false, reason: `update target does not exist: ${op.path}`, path: op.path };
      }
      const r = applyUpdate(next[op.path], op.hunks);
      if (!r.ok) return { ok: false, reason: r.reason, path: op.path, failedHunk: r.failedHunk };
      next[op.path] = r.contents;
      changed.push(op.path);
    } else if (op.type === "add") {
      next[op.path] = op.addLines.join("\n");
      changed.push(op.path);
    } else if (op.type === "delete") {
      delete next[op.path];
      changed.push(op.path);
    }
  }
  return { ok: true, tree: next, changed };
}

// ---- parsing ------------------------------------------------------------------------
function parseV4A(patch) {
  const lines = patch.split("\n");
  const ops = [];
  let cur = null;
  let hunk = null;

  for (const raw of lines) {
    if (raw.startsWith("*** Begin Patch") || raw.startsWith("*** End Patch")) continue;

    if (raw.startsWith(H_UPDATE)) {
      cur = { type: "update", path: raw.slice(H_UPDATE.length).trim(), hunks: [] };
      hunk = null;
      ops.push(cur);
      continue;
    }
    if (raw.startsWith(H_ADD)) {
      cur = { type: "add", path: raw.slice(H_ADD.length).trim(), addLines: [] };
      hunk = null;
      ops.push(cur);
      continue;
    }
    if (raw.startsWith(H_DELETE)) {
      ops.push({ type: "delete", path: raw.slice(H_DELETE.length).trim() });
      cur = null;
      hunk = null;
      continue;
    }
    if (raw.startsWith("*** ")) continue; // ignore other markers (e.g. *** End of File)
    if (!cur) continue; // stray line outside any section

    if (cur.type === "update") {
      if (raw.startsWith("@@")) {
        hunk = [];
        cur.hunks.push(hunk);
        continue; // the @@ locator hint is not file content in simple V4A
      }
      if (!hunk) {
        hunk = [];
        cur.hunks.push(hunk);
      }
      const k = raw[0];
      if (k === " " || k === "+" || k === "-") {
        hunk.push({ kind: k, text: raw.slice(1) });
      } else {
        // No prefix — treat as a blank/context line (lenient: models sometimes drop the
        // leading space on blank context lines).
        hunk.push({ kind: " ", text: raw });
      }
    } else if (cur.type === "add") {
      cur.addLines.push(raw.startsWith("+") ? raw.slice(1) : raw);
    }
  }
  return ops;
}

// ---- applying an update -------------------------------------------------------------
function applyUpdate(contents, hunks) {
  let lines = contents.split("\n");
  let cursor = 0;

  for (const hunk of hunks) {
    const oldLines = hunk.filter((h) => h.kind === " " || h.kind === "-").map((h) => h.text);
    const newLines = hunk.filter((h) => h.kind === " " || h.kind === "+").map((h) => h.text);

    if (oldLines.length === 0) {
      return { ok: false, reason: "hunk has no context or removed lines to locate the edit", failedHunk: hunkText(hunk) };
    }

    let at = findSubsequence(lines, oldLines, cursor);
    if (at === -1 && cursor > 0) at = findSubsequence(lines, oldLines, 0); // retry from top
    if (at === -1) {
      return { ok: false, reason: "could not locate the hunk's context in the file (exact match failed)", failedHunk: hunkText(hunk) };
    }

    lines = [...lines.slice(0, at), ...newLines, ...lines.slice(at + oldLines.length)];
    cursor = at + newLines.length;
  }

  return { ok: true, contents: lines.join("\n") };
}

// Find the start index where `needle` (array of lines) appears contiguously in
// `hay` (array of lines), at or after `from`. -1 if absent.
function findSubsequence(hay, needle, from) {
  outer: for (let i = from; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function hunkText(hunk) {
  return hunk.map((h) => h.kind + h.text).join("\n");
}
