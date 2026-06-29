// Context selection (Phase 2.2) — the input-side lever. Pure, provider-agnostic helpers
// the engine uses to send LESS input per turn without the model ever editing blind.
//
// The problem: with store:false the engine re-sends the whole message history every turn,
// so accumulated read_file outputs and apply_patch/write_file argument blobs are
// re-transmitted forever, growing input unboundedly.
//
// The fix, in three parts (all here, all above the provider seam):
//   1. buildManifest(tree)            — paths-only listing, so the model knows what exists.
//   2. directDeps / renderContextBlock — carry the CURRENT contents of just the relevant
//                                        files (read live from the tree) — one fresh copy.
//   3. pruneHistory(messages)         — collapse the now-redundant historical read/patch
//                                        payloads to stubs, so they stop piling up.
//
// Net per-turn input ≈ base system + manifest + current contents of touched files
// (bounded by tree size) instead of base + an ever-growing pile of reads and patches.

import path from "node:path";

const CODE_EXTS = ["", ".jsx", ".js", ".mjs", ".ts", ".tsx", ".css", ".json"];
const INDEX_BASES = ["/index.jsx", "/index.js", "/index.mjs", "/index.ts", "/index.tsx"];

// Paths-only manifest of the whole tree (no contents) — cheap, lets the model `read_file`
// anything it wants that isn't already in the rendered context.
export function buildManifest(tree) {
  return Object.keys(tree).sort().join("\n");
}

// One-hop local dependencies of `fromPath`: the tree paths it imports/exports via RELATIVE
// specifiers (./ or ../). Bare-package imports (react, etc.) are ignored — they aren't files
// in the tree. Returns existing tree paths only, deduped.
export function directDeps(tree, fromPath) {
  const src = tree[fromPath];
  if (typeof src !== "string") return [];
  const baseDir = path.posix.dirname(toPosix(fromPath));
  const out = new Set();

  // import ... from "X"  ·  export ... from "X"  ·  import("X")  ·  require("X")
  const re = /(?:from|import|require)\s*\(?\s*["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const spec = m[1];
    if (!spec.startsWith("./") && !spec.startsWith("../")) continue; // skip bare packages
    const resolved = resolveInTree(tree, baseDir, spec);
    if (resolved && resolved !== fromPath) out.add(resolved);
  }
  return [...out];
}

// Resolve a relative specifier against the tree, trying common extensions + /index.*.
function resolveInTree(tree, baseDir, spec) {
  const joined = path.posix.normalize(path.posix.join(baseDir, spec));
  for (const ext of CODE_EXTS) {
    const cand = joined + ext;
    if (cand in tree) return cand;
  }
  for (const idx of INDEX_BASES) {
    const cand = joined + idx;
    if (cand in tree) return cand;
  }
  return null;
}

// The context block appended to the system prompt each turn: the manifest + the CURRENT
// contents of the relevant files. Always regenerated from the authoritative tree, so it is
// one fresh copy — never the stale, accumulating copies that live in message history.
export function renderContextBlock(tree, relevantPaths) {
  const present = [...new Set(relevantPaths)].filter((p) => p in tree).sort();
  const parts = [
    "# Project files",
    "Manifest of every path. Call read_file ONLY for a path NOT shown in full below:",
    buildManifest(tree),
    "",
    "# Current contents of the relevant files (live & authoritative)",
    "These are the CURRENT contents of the files you are most likely to edit. Do NOT call",
    "read_file for any file shown here — it is already up to date; edit it directly. Trust",
    "these over anything earlier in the conversation.",
  ];
  for (const p of present) {
    parts.push("", `## ${p}`, "```" + fence(p), tree[p], "```");
  }
  return parts.join("\n");
}

function fence(p) {
  const ext = path.posix.extname(p).slice(1);
  if (ext === "jsx" || ext === "tsx") return "jsx";
  if (ext === "mjs" || ext === "cjs") return "js";
  return ext || "";
}

// Return a re-sendable COPY of `messages` with the heavy, now-redundant payloads collapsed
// to stubs — the current contents always also live in the context block, so nothing the
// model needs to act on is lost. The function_call <-> function_call_output id pairing is
// preserved (the Responses API requires it); store:false makes rewriting replayed content
// safe. The most recent tool turn is kept verbatim (belt-and-suspenders).
const MUTATORS = new Set(["write_file", "apply_patch", "edit_file"]);

export function pruneHistory(messages, { keepLastTurn = true } = {}) {
  const lastTurnStart = keepLastTurn ? lastAssistantToolCallIndex(messages) : messages.length;

  return messages.map((msg, i) => {
    if (i >= lastTurnStart) return msg; // keep the most recent tool turn intact

    if (msg.role === "assistant" && Array.isArray(msg.toolCalls)) {
      return { ...msg, toolCalls: msg.toolCalls.map(stubToolCallArgs) };
    }
    if (msg.role === "tool") {
      const stub = stubToolOutput(msg);
      return stub === msg.output ? msg : { ...msg, output: stub };
    }
    return msg;
  });
}

// Index of the last assistant message that carries tool calls — everything from here on is
// "the most recent tool turn" and is kept verbatim.
function lastAssistantToolCallIndex(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "assistant" && Array.isArray(m.toolCalls) && m.toolCalls.length) return i;
  }
  return messages.length;
}

// Shrink a mutator's `arguments` (a JSON string) to a stub; leave read-only calls alone.
function stubToolCallArgs(tc) {
  if (!MUTATORS.has(tc.name)) return tc;
  let pathHint;
  try {
    pathHint = JSON.parse(tc.arguments)?.path;
  } catch {
    /* ignore */
  }
  const stub = { _elided: "applied; current contents in context block" };
  if (pathHint) stub.path = pathHint;
  return { ...tc, arguments: JSON.stringify(stub) };
}

// Shrink a tool result: full read_file bodies become a stub; failure payloads that echoed a
// file back (currentContents/failedHunk/search) get those heavy fields dropped.
function stubToolOutput(msg) {
  let parsed;
  try {
    parsed = JSON.parse(msg.output);
  } catch {
    return msg.output; // non-JSON (shouldn't happen) — leave as-is
  }
  if (parsed && typeof parsed.contents === "string") {
    return JSON.stringify({ _elided: "stale read; current contents in context block" });
  }
  if (parsed && (("currentContents" in parsed) || "failedHunk" in parsed || "search" in parsed)) {
    const { currentContents, failedHunk, search, ...rest } = parsed;
    return JSON.stringify({ ...rest, _elided: "file echo dropped; current contents in context block" });
  }
  return msg.output;
}

function toPosix(p) {
  return p.replace(/\\/g, "/");
}
