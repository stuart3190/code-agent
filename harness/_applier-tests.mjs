// Offline applier tests — NO model. De-risks the appliers before spending Codex turns.
// Run: node harness/_applier-tests.mjs   (exit 0 = all pass)

import { applyPatchV4A } from "../src/tools/edit/applyPatchV4A.mjs";
import { applySearchReplace } from "../src/tools/edit/searchReplace.mjs";

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); }
}

const FILE = `import { useState } from 'react';

export default function App() {
  const [count, setCount] = useState(0);
  return <button onClick={() => setCount(count + 1)}>{count}</button>;
}
`;

// ---- V4A apply_patch ----------------------------------------------------------------
console.log("apply_patch (V4A):");

{
  // clean single-hunk update: change initial count 0 -> 10
  const patch = `*** Begin Patch
*** Update File: src/App.jsx
@@
-  const [count, setCount] = useState(0);
+  const [count, setCount] = useState(10);
*** End Patch`;
  const r = applyPatchV4A({ "src/App.jsx": FILE }, patch);
  check("update applies & changes only the target line", r.ok && r.tree["src/App.jsx"].includes("useState(10)") && !r.tree["src/App.jsx"].includes("useState(0)"));
  check("update preserves the rest of the file", r.ok && r.tree["src/App.jsx"].includes("export default function App"));
}

{
  // context-anchored insertion (add a line using surrounding context)
  const patch = `*** Begin Patch
*** Update File: src/App.jsx
@@
 export default function App() {
   const [count, setCount] = useState(0);
+  const [name, setName] = useState('');
*** End Patch`;
  const r = applyPatchV4A({ "src/App.jsx": FILE }, patch);
  check("context-anchored add inserts new line", r.ok && r.tree["src/App.jsx"].includes("const [name, setName]"));
  check("context-anchored add keeps original line", r.ok && r.tree["src/App.jsx"].includes("const [count, setCount] = useState(0)"));
}

{
  // anchor not found -> structured failure
  const patch = `*** Begin Patch
*** Update File: src/App.jsx
@@
-  const [count, setCount] = useState(999);
+  const [count, setCount] = useState(1);
*** End Patch`;
  const r = applyPatchV4A({ "src/App.jsx": FILE }, patch);
  check("missing anchor fails structurally", r.ok === false && /locate|context/.test(r.reason) && r.path === "src/App.jsx");
}

{
  // update to a nonexistent file -> structured failure
  const patch = `*** Begin Patch
*** Update File: src/Missing.jsx
@@
-foo
+bar
*** End Patch`;
  const r = applyPatchV4A({ "src/App.jsx": FILE }, patch);
  check("update on missing file fails structurally", r.ok === false && /does not exist/.test(r.reason));
}

{
  // Add File
  const patch = `*** Begin Patch
*** Add File: src/util.js
+export const ok = true;
*** End Patch`;
  const r = applyPatchV4A({ "src/App.jsx": FILE }, patch);
  check("add file creates a new file", r.ok && r.tree["src/util.js"] === "export const ok = true;");
}

{
  // empty / junk patch
  const r = applyPatchV4A({ "src/App.jsx": FILE }, "not a patch at all");
  check("junk patch yields no-ops failure", r.ok === false);
}

{
  // input tree is not mutated
  const tree = { "src/App.jsx": FILE };
  const patch = `*** Update File: src/App.jsx
@@
-  const [count, setCount] = useState(0);
+  const [count, setCount] = useState(2);
*** End Patch`;
  const r = applyPatchV4A(tree, patch);
  check("does not mutate the input tree", r.ok && tree["src/App.jsx"] === FILE && r.tree["src/App.jsx"] !== FILE);
}

// ---- search/replace -----------------------------------------------------------------
console.log("search/replace:");

{
  const r = applySearchReplace(FILE, [{ search: "useState(0)", replace: "useState(5)" }]);
  check("single exact replace applies", r.ok && r.contents.includes("useState(5)"));
}

{
  // sequential edits, second sees first's result
  const r = applySearchReplace(FILE, [
    { search: "useState(0)", replace: "useState(5)" },
    { search: "useState(5)", replace: "useState(7)" },
  ]);
  check("sequential edits chain", r.ok && r.contents.includes("useState(7)"));
}

{
  const r = applySearchReplace(FILE, [{ search: "useState(123)", replace: "x" }]);
  check("not found fails structurally", r.ok === false && /not found/.test(r.reason));
}

{
  // ambiguous: "count" appears multiple times
  const r = applySearchReplace(FILE, [{ search: "count", replace: "tally" }]);
  check("ambiguous match fails structurally", r.ok === false && /ambiguous/.test(r.reason));
}

{
  const r = applySearchReplace(FILE, [{ search: "", replace: "x" }]);
  check("empty search rejected", r.ok === false);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
