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

    let match = locateHunk(lines, oldLines, cursor);
    if (!match && cursor > 0) match = locateHunk(lines, oldLines, 0); // retry from top
    if (!match) {
      return { ok: false, reason: "could not locate the hunk's context in the file (exact match failed)", failedHunk: hunkText(hunk) };
    }
    const at = match.index;

    // When the context matched only after normalising whitespace, the FILE's lines are the
    // truth — reusing the model's copies would silently reformat code it never meant to touch.
    // Context lines are therefore taken from the file, and only `+` lines from the patch.
    const replacement = match.exact
      ? newLines
      : (() => {
        const out = [];
        let offset = 0;
        for (const entry of hunk) {
          if (entry.kind === "+") out.push(entry.text);
          else if (entry.kind === " ") out.push(lines[at + offset++]);
          else offset++; // "-" consumes a file line without contributing one
        }
        return out;
      })();

    lines = [...lines.slice(0, at), ...replacement, ...lines.slice(at + oldLines.length)];
    cursor = at + replacement.length;
  }

  return { ok: true, contents: lines.join("\n") };
}

// Find the start index where `needle` (array of lines) appears contiguously in
// `hay` (array of lines), at or after `from`. -1 if absent.
function findSubsequence(hay, needle, from, equal = (a, b) => a === b) {
  outer: for (let i = from; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (!equal(hay[i + j], needle[j])) continue outer;
    }
    return i;
  }
  return -1;
}

// Every occurrence, so a tolerant match can refuse when it would be a guess.
function findAll(hay, needle, equal) {
  const hits = [];
  for (let i = 0; i <= hay.length - needle.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length && ok; j++) if (!equal(hay[i + j], needle[j])) ok = false;
    if (ok) hits.push(i);
  }
  return hits;
}

const rstrip = (s) => String(s).replace(/[\s﻿ ]+$/, "");
const squash = (s) => String(s).trim().replace(/\s+/g, " ");

// Locate a hunk's context, preferring an exact match and falling back only as far as needed.
//
// The matcher used to be exact-only, which produced the recurring
// "could not locate the hunk's context" failures in production: every one of them followed a
// read_file, i.e. the model reproducing context it had just been shown. Reproduced directly —
// a single trailing space, one space of indentation, or a stray CR each defeated it, while the
// intent was unambiguous.
//
// The fallbacks are deliberately graduated and the loosest one requires a UNIQUE match: silently
// patching the wrong place is far worse than failing and letting the repair loop retry.
function locateHunk(hay, needle, from) {
  const exact = findSubsequence(hay, needle, from);
  if (exact !== -1) return { index: exact, exact: true };

  // 1. Trailing whitespace and line-ending noise only — still positionally anchored.
  const trailing = findSubsequence(hay, needle, from, (a, b) => rstrip(a) === rstrip(b));
  if (trailing !== -1) return { index: trailing, exact: false };

  // 2. Indentation and internal whitespace. Whole-file scan, and only when unambiguous.
  const squashed = findAll(hay, needle, (a, b) => squash(a) === squash(b));
  if (squashed.length === 1) return { index: squashed[0], exact: false };

  return null;
}

function hunkText(hunk) {
  return hunk.map((h) => h.kind + h.text).join("\n");
}
