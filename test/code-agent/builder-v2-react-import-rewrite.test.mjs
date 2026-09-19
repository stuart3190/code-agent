// A generated file that uses React.* without binding React is corrected deterministically before
// the static verdict, never by a paid correction call. Retained evidence: the recessed-light rerun
// (675d2a73) candidate core:4, whose estimate screen carried three such references.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { lintUndefinedIdentifiers, rewriteMissingReactImports } from "../../shell/server/lib/builderV2/staticApplicationGate.mjs";
import { preprocessCandidateTree } from "../../shell/server/lib/builderV2/preRepairPipeline.mjs";

const RETAINED = new URL("./fixtures/retained/medium-20260917-recessed/", import.meta.url);
const SCREEN = "src/screens/scaffold/EstimateAndProjectSummaryScreen.jsx";

test("the retained candidate's estimate screen gains its React import and the finding disappears", async () => {
  const tree = JSON.parse(await readFile(new URL("tree-candidate-core-4-e1b99789.json", RETAINED), "utf8"));
  const before = lintUndefinedIdentifiers(tree).filter((row) => row.identifier === "React");
  assert.equal(before.length, 3, "three React references without a binding");
  assert.ok(before.every((row) => row.file === SCREEN));
  const { tree: fixed, rewrites } = preprocessCandidateTree(tree);
  assert.deepEqual(rewrites.map((row) => [row.file, row.rewrite, row.lines]), [[SCREEN, "react_default_import", [24, 25, 26]]]);
  assert.ok(fixed[SCREEN].startsWith("import React from \"react\";\n"));
  assert.deepEqual(lintUndefinedIdentifiers(fixed).filter((row) => row.identifier === "React"), []);
  // Nothing else changed, and the rewrite is idempotent.
  for (const path of Object.keys(tree)) if (path !== SCREEN) assert.equal(fixed[path], tree[path]);
  const again = preprocessCandidateTree(fixed);
  assert.deepEqual(again.rewrites, []);
  assert.equal(again.tree[SCREEN], fixed[SCREEN]);
});

test("files that bind React, or never reference it, are left exactly as they are", () => {
  const tree = {
    "src/components/A.jsx": "import React from \"react\";\nexport function A() { return React.createElement(\"div\"); }\n",
    "src/components/B.jsx": "import * as React from \"react\";\nexport function B() { const [x] = React.useState(0); return x; }\n",
    "src/components/C.jsx": "import { useState } from \"react\";\nexport function C() { const [x] = useState(0); return <div>{x}</div>; }\n",
    "src/components/D.jsx": "const React = { useState: () => [1] };\nexport function D() { const [x] = React.useState(); return x; }\n",
    "src/lib/notes.js": "export const note = \"React. is just prose here\";\n",
  };
  const { tree: fixed, rewrites } = rewriteMissingReactImports(tree);
  assert.deepEqual(rewrites, []);
  assert.deepEqual(fixed, tree);
});

test("a named react import plus a bare React.* reference receives the default import without duplicating the named one", () => {
  const source = "import { useMemo } from \"react\";\nexport function E() { const [x] = React.useState(0); return useMemo(() => x, [x]); }\n";
  const { tree: fixed, rewrites } = rewriteMissingReactImports({ "src/components/E.jsx": source });
  assert.equal(rewrites.length, 1);
  assert.equal(fixed["src/components/E.jsx"], `import React from "react";\n${source}`);
  assert.deepEqual(lintUndefinedIdentifiers(fixed), []);
});

test("a leading directive stays first, platform files and unparsable files are never rewritten", () => {
  const directive = "\"use client\";\nexport function F() { return React.useMemo(() => 1, []); }\n";
  const { tree: fixed, rewrites } = rewriteMissingReactImports({
    "src/components/F.jsx": directive,
    "src/lib/scaffolds/composed/primitives.jsx": "export const P = () => React.createElement(\"span\");\n",
    "src/components/Broken.jsx": "export function Broken() { return React.useState( ; }\n",
  });
  assert.deepEqual(rewrites.map((row) => row.file), ["src/components/F.jsx"]);
  assert.equal(fixed["src/components/F.jsx"], "\"use client\";\nimport React from \"react\";\nexport function F() { return React.useMemo(() => 1, []); }\n");
  assert.equal(fixed["src/lib/scaffolds/composed/primitives.jsx"], "export const P = () => React.createElement(\"span\");\n");
  assert.equal(fixed["src/components/Broken.jsx"], "export function Broken() { return React.useState( ; }\n");
});
