// apply_patch context matching (audit R5).
//
// Production logged a recurring `apply_patch FAILED: could not locate the hunk's context in the
// file (exact match failed)`. Every occurrence immediately followed a `read_file` — the model
// reproducing context it had just been shown. The matcher was strictly exact, so a single
// trailing space, one space of indentation, or a stray CR defeated it even though the intent
// was unambiguous. Each failure wasted a turn and could trigger a repair round.
//
// The fix is a graduated fallback, not a loose matcher: exact wins, then trailing-whitespace,
// then whitespace-normalised ONLY when the match is unique. Silently patching the wrong place
// would be far worse than failing and letting the repair loop retry.

import assert from "node:assert/strict";
import test from "node:test";

import { applyPatchV4A } from "../../src/tools/edit/applyPatchV4A.mjs";

const APP = [
  "export default function App() {",
  "  return (",
  '    <div className="app">',
  "      <h1>Hello</h1>",
  "    </div>",
  "  );",
  "}",
  "",
].join("\n");

const patchWith = (context, added = "      <p>New</p>") => [
  "*** Begin Patch",
  "*** Update File: src/App.jsx",
  "@@",
  ` ${context}`,
  `+${added}`,
  "*** End Patch",
].join("\n");

const run = (file, patch) => applyPatchV4A({ "src/App.jsx": file }, patch);

test("an exact context still applies, unchanged", () => {
  const out = run(APP, patchWith("      <h1>Hello</h1>"));
  assert.equal(out.ok, true);
  assert.match(out.tree["src/App.jsx"], /<p>New<\/p>/);
});

test("the near-misses that failed in production now apply", () => {
  for (const [name, context] of [
    ["trailing space", "      <h1>Hello</h1> "],
    ["trailing tab", "      <h1>Hello</h1>\t"],
    ["carriage return", "      <h1>Hello</h1>\r"],
    ["one space less indentation", "     <h1>Hello</h1>"],
    ["no indentation at all", "<h1>Hello</h1>"],
  ]) {
    const out = run(APP, patchWith(context));
    assert.equal(out.ok, true, `${name} should apply: ${out.reason || ""}`);
    assert.match(out.tree["src/App.jsx"], /<p>New<\/p>/, name);
  }
});

test("a tolerant match never reformats the file's own lines", () => {
  // The context line keeps the FILE's six-space indentation, not the model's five.
  const out = run(APP, patchWith("     <h1>Hello</h1>"));
  assert.equal(out.ok, true);
  const lines = out.tree["src/App.jsx"].split("\n");
  assert.equal(lines[3], "      <h1>Hello</h1>", "the file's indentation must survive");
  assert.equal(lines[4], "      <p>New</p>");
});

test("genuinely wrong context still fails rather than guessing", () => {
  const out = run(APP, patchWith("      <h1>Goodbye</h1>"));
  assert.equal(out.ok, false);
  assert.match(out.reason, /could not locate the hunk's context/);
});

test("an ambiguous whitespace-only match is refused, not guessed", () => {
  // Two identical lines differing only in indentation: normalising makes the context match
  // twice, so the patch must refuse rather than pick one.
  const ambiguous = [
    "function a() {",
    "  doThing();",
    "}",
    "function b() {",
    "      doThing();",
    "}",
    "",
  ].join("\n");
  const out = applyPatchV4A({ "src/App.jsx": ambiguous }, patchWith("doThing();", "  extra();"));
  assert.equal(out.ok, false, "an ambiguous match must not be applied");
  assert.match(out.reason, /could not locate the hunk's context/);
});

test("exact matching is preferred when both an exact and a loose match exist", () => {
  // The exact occurrence is SECOND in the file; a whitespace-normalised scan would find the
  // first. Exact must win, so a patch never jumps to a different location than intended.
  const file = [
    "  value = 1;",
    "value = 1;",
    "",
  ].join("\n");
  const out = applyPatchV4A({ "src/App.jsx": file }, patchWith("value = 1;", "after();"));
  assert.equal(out.ok, true);
  const lines = out.tree["src/App.jsx"].split("\n");
  // The addition lands after the EXACT (unindented, second) line.
  assert.deepEqual(lines.slice(0, 3), ["  value = 1;", "value = 1;", "after();"]);
});

test("multi-line hunks tolerate mixed whitespace drift", () => {
  const out = run(APP, [
    "*** Begin Patch",
    "*** Update File: src/App.jsx",
    "@@",
    '     <div className="app">',
    "      <h1>Hello</h1> ",
    "+      <p>New</p>",
    "     </div>",
    "*** End Patch",
  ].join("\n"));
  assert.equal(out.ok, true, out.reason);
  const lines = out.tree["src/App.jsx"].split("\n");
  assert.equal(lines[2], '    <div className="app">', "surrounding lines keep their own formatting");
  assert.equal(lines[4], "      <p>New</p>");
  assert.equal(lines[5], "    </div>");
});

test("removals still work through a tolerant match", () => {
  const out = applyPatchV4A({ "src/App.jsx": APP }, [
    "*** Begin Patch",
    "*** Update File: src/App.jsx",
    "@@",
    "-     <h1>Hello</h1>",
    "+      <h2>Hi</h2>",
    "*** End Patch",
  ].join("\n"));
  assert.equal(out.ok, true, out.reason);
  assert.doesNotMatch(out.tree["src/App.jsx"], /<h1>Hello<\/h1>/);
  assert.match(out.tree["src/App.jsx"], /<h2>Hi<\/h2>/);
});
