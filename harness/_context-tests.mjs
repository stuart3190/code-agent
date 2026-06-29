// Offline context-selection tests — NO model. De-risks the Phase 2.2 helpers (directDeps,
// renderContextBlock, pruneHistory) before spending Codex turns.
// Run: node harness/_context-tests.mjs   (exit 0 = all pass)

import { buildManifest, directDeps, renderContextBlock, pruneHistory } from "../src/engine/context.mjs";

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); }
}

const TREE = {
  "package.json": "{}",
  "src/main.jsx": `import App from "./App.jsx";\nimport "./index.css";`,
  "src/App.jsx": `import { useState } from "react";\nimport Header from "./components/Header.jsx";\nimport { fmt } from "./util";\nexport default function App() { return <Header/>; }`,
  "src/util.js": `export const fmt = (x) => x;`,
  "src/components/Header.jsx": `export default function Header(){ return <h1/>; }`,
};

// ---- buildManifest ------------------------------------------------------------------
console.log("buildManifest:");
{
  const m = buildManifest(TREE);
  check("lists every path", Object.keys(TREE).every((p) => m.includes(p)));
  check("paths only — no file contents", !m.includes("useState") && !m.includes("function App"));
  check("sorted", m.split("\n")[0] === "package.json");
}

// ---- directDeps ---------------------------------------------------------------------
console.log("directDeps:");
{
  const deps = directDeps(TREE, "src/App.jsx");
  check("resolves ./components/Header.jsx", deps.includes("src/components/Header.jsx"));
  check("resolves extensionless ./util -> src/util.js", deps.includes("src/util.js"));
  check("skips bare package import (react)", !deps.some((d) => d.includes("react")));
  check("does not include itself", !deps.includes("src/App.jsx"));
}
{
  check("missing file yields no deps", directDeps(TREE, "nope.jsx").length === 0);
  check("resolves ../ correctly", directDeps(TREE, "src/components/Header.jsx").length === 0); // Header imports nothing local
}

// ---- renderContextBlock -------------------------------------------------------------
console.log("renderContextBlock:");
{
  const block = renderContextBlock(TREE, ["src/App.jsx", "src/util.js", "ghost.js"]);
  check("includes the manifest", block.includes("src/components/Header.jsx"));
  check("includes contents of requested files", block.includes("export default function App") && block.includes("export const fmt"));
  check("omits contents of unrequested files", !block.includes("function Header"));
  check("skips nonexistent requested paths silently", !block.includes("ghost.js\n```"));
  check("dedupes relevant paths", renderContextBlock(TREE, ["src/util.js", "src/util.js"]).split("## src/util.js").length === 2);
}

// ---- pruneHistory -------------------------------------------------------------------
console.log("pruneHistory:");
{
  // A 2-turn history: turn 1 reads App.jsx + patches it; turn 2 patches again (latest).
  const bigBody = JSON.stringify({ contents: TREE["src/App.jsx"] });
  const messages = [
    { role: "user", content: "edit prompt" },
    { role: "assistant", toolCalls: [{ id: "c1", name: "read_file", arguments: '{"path":"src/App.jsx"}' }] },
    { role: "tool", toolCallId: "c1", name: "read_file", output: bigBody },
    { role: "assistant", toolCalls: [{ id: "c2", name: "apply_patch", arguments: '{"input":"*** Begin Patch\\n...huge..."}' }] },
    { role: "tool", toolCallId: "c2", name: "apply_patch", output: JSON.stringify({ ok: true, changed: ["src/App.jsx"] }) },
    { role: "assistant", toolCalls: [{ id: "c3", name: "apply_patch", arguments: '{"input":"*** latest patch ..."}' }] },
    { role: "tool", toolCallId: "c3", name: "apply_patch", output: JSON.stringify({ ok: true, changed: ["src/App.jsx"] }) },
  ];
  const pruned = pruneHistory(messages, { keepLastTurn: true });

  check("returns a new array (no mutation)", pruned !== messages && messages[2].output === bigBody);
  check("same length / structure preserved", pruned.length === messages.length);
  check("stale read_file body collapsed", !pruned[2].output.includes("function App") && pruned[2].output.includes("_elided"));
  check("stale read still pairs to its call id", pruned[2].toolCallId === "c1" && pruned[1].toolCalls[0].id === "c1");
  check("old patch args collapsed to stub", !pruned[3].toolCalls[0].arguments.includes("huge") && pruned[3].toolCalls[0].arguments.includes("_elided"));
  check("latest turn kept verbatim (args)", pruned[5].toolCalls[0].arguments.includes("latest patch"));
  check("user prompt untouched", pruned[0].content === "edit prompt");
  check("read-only call args untouched", pruned[1].toolCalls[0].arguments === '{"path":"src/App.jsx"}');
}
{
  // failure echo (currentContents) gets its heavy field dropped, structured fields kept
  const messages = [
    { role: "user", content: "p" },
    { role: "assistant", toolCalls: [{ id: "f1", name: "apply_patch", arguments: '{"input":"x"}' }] },
    { role: "tool", toolCallId: "f1", name: "apply_patch", output: JSON.stringify({ error: "could not locate", path: "src/App.jsx", currentContents: TREE["src/App.jsx"], failedHunk: "..." }) },
    { role: "assistant", toolCalls: [{ id: "f2", name: "apply_patch", arguments: '{"input":"y"}' }] },
    { role: "tool", toolCallId: "f2", name: "apply_patch", output: JSON.stringify({ ok: true, changed: [] }) },
  ];
  const pruned = pruneHistory(messages, { keepLastTurn: true });
  const out = JSON.parse(pruned[2].output);
  check("failure echo: currentContents dropped", !("currentContents" in out) && !pruned[2].output.includes("function App"));
  check("failure echo: error message kept", out.error === "could not locate" && out.path === "src/App.jsx");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
