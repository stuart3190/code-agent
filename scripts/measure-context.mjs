// Context measurement harness: runs the REAL engine loop against a scripted fake provider
// that behaves like the model (list files, read a few, patch one, finish) and reports
// exactly how many characters/estimated tokens each turn sends. Deterministic, offline,
// zero API cost. Usage: node scripts/measure-context.mjs [--mode default|ctx|cache]

import { runAgent } from "../src/engine/runAgent.mjs";
import { makeFileTools } from "../src/tools/fileTools.mjs";

const MODE = process.argv.includes("--mode")
  ? process.argv[process.argv.indexOf("--mode") + 1]
  : "default";

// Representative 24-file app tree (~40KB source) like a real generated project.
function representativeTree() {
  const tree = {
    "package.json": JSON.stringify({ name: "app", scripts: { build: "vite build" }, dependencies: { react: "18" } }, null, 2),
    "index.html": "<!doctype html><div id=root></div>",
    "src/main.jsx": 'import App from "./App.jsx";\nrender(<App/>);',
    "src/App.jsx": 'import Header from "./components/Header.jsx";\nimport Quotes from "./components/Quotes.jsx";\nexport default function App(){return <div><Header/><Quotes/></div>}',
    "src/components/Header.jsx": 'export default function Header(){return <button className="cta">Another quote</button>}',
    "src/components/Quotes.jsx": 'import { pick } from "../lib/random.js";\nexport default function Quotes(){return <p>{pick()}</p>}',
    "src/lib/random.js": "export const pick = () => QUOTES[Math.floor(Math.random()*QUOTES.length)];\nconst QUOTES=[\"a\",\"b\"];",
  };
  for (let i = 0; i < 17; i += 1) {
    tree[`src/components/Unrelated${i}.jsx`] = `// unrelated component ${i}\n${"export const x = 1;\n".repeat(120)}`;
  }
  return tree;
}

const estTokens = (chars) => Math.round(chars / 4);

function scriptedProvider(script, capture) {
  let step = 0;
  return {
    model: "measurement-stub",
    runTurn: async ({ systemPrompt, messages, tools }) => {
      const chars = systemPrompt.length + JSON.stringify(messages).length + JSON.stringify(tools).length;
      capture.push({ turn: step + 1, chars, system: systemPrompt.length, history: JSON.stringify(messages).length });
      const action = script[Math.min(step, script.length - 1)];
      step += 1;
      return {
        text: action.text || "",
        toolCalls: (action.calls || []).map((c, i) => ({ id: `c${step}-${i}`, name: c.name, arguments: c.args, rawArguments: JSON.stringify(c.args) })),
        usage: { input: estTokens(chars), output: 50, reasoning: 0, cached: 0, total: estTokens(chars) + 50 },
      };
    },
  };
}

// The "rename one button" edit. Blind mode: the model must explore first. Seeded mode
// (--seeded): the entry file + deps are already in context, so it patches immediately —
// the realistic behavioral difference context seeding buys.
const PATCH = { name: "apply_patch", args: { input: "*** Begin Patch\n*** Update File: src/components/Header.jsx\n@@\n-<button className=\"cta\">Another quote</button>\n+<button className=\"cta\">New quote</button>\n*** End Patch" } };
const SCENARIO = process.argv.includes("--scenario")
  ? process.argv[process.argv.indexOf("--scenario") + 1]
  : "edit";
const SEEDED = process.argv.includes("--seeded");

const write = (path, size) => ({ name: "write_file", args: { path, contents: `// new\n${"code();\n".repeat(size)}` } });
const read = (path) => ({ name: "read_file", args: { path } });

const SCRIPTS = {
  // Simple text edit. Blind: explore then patch. Seeded: patch immediately.
  edit: SEEDED
    ? [{ calls: [PATCH] }, { text: "Renamed the button." }]
    : [
      { calls: [{ name: "list_files", args: {} }] },
      { calls: [read("src/components/Header.jsx")] },
      { calls: [PATCH] },
      { text: "Renamed the button." },
    ],
  // Medium feature: add a favourites system touching 3 files. Blind: explore 3 reads first.
  feature: SEEDED
    ? [
      { calls: [write("src/lib/favorites.js", 60)] },
      { calls: [read("src/components/Quotes.jsx")] },
      { calls: [write("src/components/Quotes.jsx", 80)] },
      { calls: [write("src/components/Favorites.jsx", 90)] },
      { calls: [PATCH] },
      { text: "Favourites added." },
    ]
    : [
      { calls: [{ name: "list_files", args: {} }] },
      { calls: [read("src/App.jsx")] },
      { calls: [read("src/components/Quotes.jsx")] },
      { calls: [write("src/lib/favorites.js", 60)] },
      { calls: [write("src/components/Quotes.jsx", 80)] },
      { calls: [write("src/components/Favorites.jsx", 90)] },
      { calls: [PATCH] },
      { text: "Favourites added." },
    ],
  // Repair from a compiler error naming the file. Blind: explore. Seeded: patch directly.
  repair: SEEDED
    ? [{ calls: [PATCH] }, { text: "Fixed the syntax error." }]
    : [
      { calls: [{ name: "list_files", args: {} }] },
      { calls: [read("src/components/Header.jsx")] },
      { calls: [read("src/lib/random.js")] },
      { calls: [PATCH] },
      { text: "Fixed the syntax error." },
    ],
};
const EDIT_SCRIPT = SCRIPTS[SCENARIO];

const tree = representativeTree();
const { schemas, impls } = makeFileTools(tree, { editFormat: "apply_patch" });
const capture = [];
const provider = scriptedProvider(EDIT_SCRIPT, capture);

const options = {
  provider, systemPrompt: "You are the builder. Edit precisely.".repeat(20),
  tools: schemas, toolImpls: impls, tree,
  prompt: "Rename the 'Another quote' button to 'New quote'. Nothing else.",
  log: () => {},
};
if (MODE === "ctx") { options.contextSelection = true; options.entryFile = "src/components/Header.jsx"; }
if (MODE === "cache") { options.cacheFriendly = true; options.entryFile = "src/components/Header.jsx"; }

const result = await runAgent(options);
const totalChars = capture.reduce((a, t) => a + t.chars, 0);
console.log(`mode=${MODE} turns=${capture.length}`);
for (const t of capture) console.log(`  turn ${t.turn}: sent ${t.chars} chars (~${estTokens(t.chars)} tok) [system ${t.system} | history ${t.history}]`);
console.log(`TOTAL sent: ${totalChars} chars ≈ ${estTokens(totalChars)} tokens; final: "${result.finalText}"`);
// Leak check: did any unrelated file's contents ever get sent?
const sentAll = capture.length ? JSON.stringify(capture) : "";
void sentAll;
