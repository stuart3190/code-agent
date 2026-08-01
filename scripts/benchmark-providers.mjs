// Provider benchmark suite: the same controlled tasks across providers, judged by TOTAL
// COST TO A VERIFIED RESULT (local npm build must pass), never by price-per-token alone.
//
//   node scripts/benchmark-providers.mjs --providers openai,xai --tasks edit,bugfix --stub
//
// Providers run through the real engine seam (runTurn) with the real tool loop and a real
// local compile check. --stub uses a scripted fake (offline harness verification, £0).
// Real runs require the relevant API keys in env (OPENAI_API_KEY, XAI_API_KEY,
// ANTHROPIC_API_KEY); missing keys are skipped with an honest note. Results print as a
// table and save to benchmark-results.json for the completion report.

import { writeFile } from "node:fs/promises";
import { runAgent } from "../src/engine/runAgent.mjs";
import { makeFileTools } from "../src/tools/fileTools.mjs";
import { buildTree, ensureDeps } from "../harness/workspace.mjs";
import { creditsForUsage } from "../src/billing/costModel.mjs";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};
const STUB = process.argv.includes("--stub");
const PROVIDERS = arg("providers", "openai,xai").split(",");
const TASKS = arg("tasks", "edit,component,bugfix").split(",");

// ── Tasks: identical prompts + starting trees for every provider ────────────────────────

function baseTree() {
  return {
    "package.json": JSON.stringify({ name: "bench", private: true, scripts: { build: "vite build" }, dependencies: { react: "^18.3.0", "react-dom": "^18.3.0" }, devDependencies: { vite: "^5.4.0", "@vitejs/plugin-react": "^4.3.0" } }, null, 2),
    "vite.config.js": 'import react from "@vitejs/plugin-react";\nexport default { plugins: [react()] };',
    "index.html": '<!doctype html><html><body><div id="root"></div><script type="module" src="/src/main.jsx"></script></body></html>',
    "src/main.jsx": 'import React from "react";\nimport { createRoot } from "react-dom/client";\nimport App from "./App.jsx";\ncreateRoot(document.getElementById("root")).render(<App/>);',
    "src/App.jsx": 'import React from "react";\nimport Header from "./Header.jsx";\nexport default function App(){ return <div><Header/><p>Welcome</p></div>; }',
    "src/Header.jsx": 'import React from "react";\nexport default function Header(){ return <button>Another quote</button>; }',
  };
}

const TASKS_DEF = {
  edit: {
    label: "simple text edit", taskType: "simple_edit", mode: "iterate",
    prompt: "Rename the 'Another quote' button text to 'New quote'. Change nothing else.",
    verify: (tree) => tree["src/Header.jsx"]?.includes("New quote"),
  },
  component: {
    label: "component edit", taskType: "component_edit", mode: "iterate",
    prompt: "Add a Footer component (src/Footer.jsx) showing '© Bench 2026' and render it at the bottom of App. Keep everything else unchanged.",
    verify: (tree) => Boolean(tree["src/Footer.jsx"]) && tree["src/App.jsx"]?.includes("Footer"),
  },
  bugfix: {
    label: "bug fix", taskType: "bug_repair", mode: "iterate",
    mutate: (tree) => { tree["src/Header.jsx"] = tree["src/Header.jsx"].replace("return", "retrun"); },
    prompt: "The build fails with: src/Header.jsx: 'retrun' is not defined. Fix the syntax error only.",
    verify: (tree) => !tree["src/Header.jsx"].includes("retrun"),
  },
  feature: {
    label: "medium feature", taskType: "feature", mode: "iterate",
    prompt: "Add a favourites feature: a src/lib/favorites.js store (add/list in memory), a Favorites component listing them, and a 'Save' button in Header that adds the current quote text. Wire it into App.",
    verify: (tree) => Boolean(tree["src/lib/favorites.js"]),
  },
  build: {
    label: "full application generation", taskType: "full_build", mode: "build",
    prompt: "Build a single-page pomodoro timer app: 25-minute countdown, start/pause/reset, a session counter, clean styling. React + Vite, no backend.",
    verify: (tree) => Object.keys(tree).some((p) => p.startsWith("src/")),
  },
  verifyrepair: {
    label: "verification repair", taskType: "verification_repair", mode: "iterate",
    mutate: (tree) => { tree["src/App.jsx"] = tree["src/App.jsx"].replace("<Header/>", ""); },
    prompt: "VERIFICATION FAILED: the page renders no button — the Header component is not mounted. Repair by rendering Header in App again. Minimum change.",
    verify: (tree) => tree["src/App.jsx"].includes("Header/>"),
  },
};

// ── Providers through the engine seam ───────────────────────────────────────────────────

async function makeProvider(name, taskType) {
  if (STUB) {
    let step = 0;
    return {
      model: `${name}-stub`,
      runTurn: async ({ messages }) => {
        step += 1;
        if (step === 1) {
          return { text: "", toolCalls: [{ id: "s1", name: "write_file", arguments: { path: "src/Header.jsx", contents: 'import React from "react";\nexport default function Header(){ return <button>New quote</button>; }' }, rawArguments: "{}" }], usage: { input: 900, output: 120, reasoning: 0, cached: 0, total: 1020 } };
        }
        void messages;
        return { text: "Done.", toolCalls: [], usage: { input: 400, output: 30, reasoning: 0, cached: 200, total: 430 } };
      },
    };
  }
  if (name === "openai") {
    if (!process.env.OPENAI_API_KEY) return null;
    const { createOpenAIEngineProvider } = await import("../shell/server/lib/appBuild/openaiEngineProvider.mjs");
    return createOpenAIEngineProvider({ model: taskType === "full_build" ? (process.env.OPENAI_QUALITY_MODEL || "gpt-5.6-sol") : (process.env.OPENAI_BALANCED_MODEL || "gpt-5.6-terra") });
  }
  if (name === "xai") {
    if (!process.env.XAI_API_KEY) return null;
    const { createXaiEngineProvider, xaiReasoningForTask } = await import("../shell/server/lib/xaiProvider.mjs");
    return createXaiEngineProvider({
      model: taskType === "full_build" ? (process.env.XAI_QUALITY_MODEL || "grok-4.5") : (process.env.XAI_BALANCED_MODEL || "grok-build-0.1"),
      reasoningEffort: xaiReasoningForTask(taskType),
    });
  }
  if (name === "anthropic") {
    if (!process.env.ANTHROPIC_API_KEY) return null;
    const { createRoutingProvider } = await import("../src/providers/routingProvider.mjs");
    return createRoutingProvider({ config: { provider: "anthropic", strong: process.env.ANTHROPIC_MODEL || "claude-sonnet-5", apiKey: process.env.ANTHROPIC_API_KEY }, turnMeta: { intent: taskType === "full_build" ? "generate" : "edit" } });
  }
  return null; // gemini has no engine-seam adapter yet — noted in the report
}

// ── Run ─────────────────────────────────────────────────────────────────────────────────

const results = [];
if (!STUB) await ensureDeps(() => {});
for (const taskName of TASKS) {
  const task = TASKS_DEF[taskName];
  if (!task) { console.log(`skip unknown task ${taskName}`); continue; }
  for (const providerName of PROVIDERS) {
    const provider = await makeProvider(providerName, task.taskType);
    if (!provider) { console.log(`SKIP ${providerName}/${taskName}: no API key configured`); continue; }
    const tree = task.mode === "build" ? {} : baseTree();
    if (task.mutate) task.mutate(tree);
    const { schemas, impls } = makeFileTools(tree, { editFormat: task.mode === "iterate" ? "apply_patch" : undefined });
    const started = Date.now();
    let telemetry = null; let steps = 0; let error = null;
    try {
      const out = await runAgent({
        provider, systemPrompt: "You are an expert React engineer. Use the file tools. Make the requested change precisely.",
        tools: schemas, toolImpls: impls, tree, prompt: task.prompt,
        log: () => { steps += 1; },
      });
      telemetry = out.telemetry;
    } catch (e) { error = e.message; }
    const latencyMs = Date.now() - started;
    const goalMet = !error && task.verify(tree);
    let compileOk = null;
    if (!STUB && goalMet && tree["package.json"]) {
      try { compileOk = (await buildTree(tree, `bench-${providerName}-${taskName}`, () => {})).ok; }
      catch { compileOk = false; }
    }
    const credits = telemetry ? creditsForUsage({ usage: telemetry, model: provider.model }) : null;
    const row = {
      provider: providerName, model: provider.model, task: task.label,
      success: goalMet && compileOk !== false, compileOk, error,
      latencyMs, steps,
      inputTokens: telemetry?.input || 0, outputTokens: telemetry?.output || 0,
      cachedTokens: telemetry?.cached || 0, totalTokens: telemetry?.total || 0,
      credits: credits == null ? null : Number(credits.toFixed(4)),
    };
    results.push(row);
    console.log(`${providerName.padEnd(10)} ${task.label.padEnd(28)} ${row.success ? "PASS" : "FAIL"}  ${row.totalTokens} tok  ${row.credits ?? "?"} cr  ${Math.round(latencyMs / 1000)}s  ${steps} steps${error ? `  ERROR: ${error}` : ""}`);
  }
}
await writeFile("benchmark-results.json", JSON.stringify({ generatedAt: new Date().toISOString(), stub: STUB, results }, null, 2));
console.log(`\n${results.length} result(s) -> benchmark-results.json`);
console.log("Judge by 'success' + credits together — total cost to a verified result, not price per token.");
