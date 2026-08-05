// First-green cost reduction (recommendations 1–5), proven against the 24.26-credit Codex
// booking build (run cf130c23 / build 94ad0b0f). The fixtures are that build's stored tree and
// stored contract, byte-for-byte.
//
// The evidence each fix answers:
//   R1  data stage turns 1-2 (23,040 tok) read App.jsx and listed files the pipeline knew about;
//       supporting turn 1 read four files, all of them written by earlier stages.
//   R2  those reads then RODE in history for every later turn of the stage — after the model had
//       patched the same files, so the copies were both large and wrong.
//   R3  every stage opened with cached=0: no two stages shared a byte-identical prefix.
//   R4  journeys failed on wording ("selected", "confirmation") the builder was never told the
//       verifier would literally look for — and use-responsive-navigation was assigned to the
//       skipped polish stage, so NO stage ever received its expectations.
//   R5  localStorage persistence written in stage 2 was first reported at final verification.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildStageContext } from "../../shell/server/lib/appBuild/contextBuilder.mjs";
import { buildManifest, tokensOf } from "../../shell/server/lib/appBuild/projectManifest.mjs";
import { planStages, stagePrompt, acceptanceCoverage, STAGE_RUNTIME_CONTRACT, STAGE_GLOBAL_INVARIANTS } from "../../shell/server/lib/appBuild/stagePlan.mjs";
import { expectationKeywords } from "../../shell/server/lib/appBuild/journeyVerifier.mjs";
import { runStageGate } from "../../shell/server/lib/appBuild/stageGate.mjs";
import { contractBrief } from "../../shell/shared/implementationContract.mjs";
import { runAgent } from "../../src/engine/runAgent.mjs";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "cf130c23");
const read = (name) => readFileSync(path.join(FIXTURES, name), "utf8");
const CONTRACT = JSON.parse(read("contract.json"));

// The booking tree at its stored (final) state; stage-time states are derived by removing what
// later stages created.
function bookingTree() {
  const ui = (name) => `export const ${name} = () => null;\n`;
  return {
    "package.json": JSON.stringify({
      name: "x", type: "module", scripts: { build: "vite build" },
      dependencies: { react: "^18", "react-dom": "^18", "lucide-react": "^0.4", vite: "^5" },
    }),
    "index.html": '<div id="root"></div>',
    "vite.config.js": "export default {}",
    "src/main.jsx": 'import "./index.css";\nimport App from "./App";\n',
    "src/index.css": ":root { --x: 1; }",
    "src/App.jsx": read("App.jsx"),
    "src/data/booking.js": read("booking.js"),
    "src/data/newsletterSignup.js": read("newsletterSignup.js"),
    "src/lib/backend/index.js": "export const auth = {}; export const db = {};",
    "src/lib/utils.js": "export const cn = (...a) => a.filter(Boolean).join(' ');",
    "src/components/ui/button.jsx": ui("Button"),
    "src/components/ui/badge.jsx": ui("Badge"),
    "src/components/ui/card.jsx": ui("Card") + ui("CardContent"),
    "src/components/ui/input.jsx": ui("Input"),
    "src/components/ui/label.jsx": ui("Label"),
    "src/components/ui/checkbox.jsx": ui("Checkbox"),
  };
}

// ── R1: no discovery-turn tax ─────────────────────────────────────────────────────────────────

test("R1 — the data stage opens with the files it previously spent two turns discovering", () => {
  // The tree as the data stage saw it: foundation's output exists, src/data does not yet.
  const tree = bookingTree();
  delete tree["src/data/booking.js"];
  delete tree["src/data/newsletterSignup.js"];
  const priorFiles = ["src/App.jsx", "src/index.css", "src/main.jsx"]; // foundation's changed files

  const context = buildStageContext({
    tree, manifest: buildManifest(tree, { contract: CONTRACT }),
    stageId: "data", contract: CONTRACT, priorFiles, budgetTokens: 40_000,
  });
  // In run cf130c23 the model paid turns 1-3 (23k tokens + an expansion) to see App.jsx. It now
  // opens the stage — SLICED, because a 46KB prior file resent whole is the 46.10-credit
  // run's over-inclusion defect. The slice is real file text, and a full read is free.
  const opened = [...context.full, ...context.slices].map((c) => c.path);
  assert.ok(opened.includes("src/App.jsx"), `data stage must open with App.jsx; got ${opened.join(", ")}`);
  const app = context.slices.find((c) => c.path === "src/App.jsx");
  assert.ok(app, "a large prior file arrives as a slice, not a whole body");
  assert.ok(app.tokens < tokensOf(tree["src/App.jsx"]) * 0.8, `slice (${app.tokens}) materially under full`);
});

test("R1 — the supporting stage opens with every file it manually expanded in the real run", () => {
  const tree = bookingTree();
  // What the earlier green stages had changed by then (from the run's own checkpoint trail).
  const priorFiles = ["src/App.jsx", "src/index.css", "src/main.jsx", "src/data/booking.js", "src/data/newsletterSignup.js"];
  const context = buildStageContext({
    tree, manifest: buildManifest(tree, { contract: CONTRACT }),
    stageId: "supporting", contract: CONTRACT, priorFiles, budgetTokens: 40_000,
  });
  const opened = [...context.full, ...context.slices].map((c) => c.path);
  // The run expanded exactly these, one costed turn at a time. Small priors arrive whole; the
  // big App.jsx arrives sliced to this stage's journeys.
  for (const file of ["src/App.jsx", "src/data/booking.js", "src/index.css"]) {
    assert.ok(opened.includes(file), `supporting stage must open with ${file}; got ${opened.join(", ")}`);
  }
  const app = context.slices.find((c) => c.path === "src/App.jsx");
  assert.ok(app && app.kept.length, "the slice keeps the symbols this stage's journeys touch");
});

test("R1 — no broad preload: prior files are the only addition and the budget still binds", () => {
  const tree = bookingTree();
  const context = buildStageContext({
    tree, manifest: buildManifest(tree, { contract: CONTRACT }),
    stageId: "data", contract: CONTRACT,
    priorFiles: ["src/App.jsx"], budgetTokens: 40_000,
  });
  // Nothing outside the reasoned set arrives: every full file carries a reason, and files outside
  // the change set + one hop + priors stay summaries or omitted.
  assert.ok(context.full.every((c) => c.reason), "every inclusion has a reason");
  assert.ok(context.tokens <= context.budget, "the budget still binds");
  assert.ok(context.omitted.length > 0 || context.summaries.length > 0, "the whole tree is NOT preloaded");
});

// ── R2: stale reads are compacted out of active history ───────────────────────────────────────

test("R2 — a read superseded by the model's own patch is compacted before the next turn", async () => {
  const tree = { "src/a.js": "export const a = 1;\n".repeat(200), "src/b.js": "export const b = 2;" };
  const sent = []; // what the provider actually receives each turn

  const provider = {
    model: "fake",
    runTurn: async ({ messages }) => {
      sent.push(JSON.parse(JSON.stringify(messages)));
      const turn = sent.length;
      if (turn === 1) {
        return { text: "", toolCalls: [
          { id: "r1", name: "read_file", rawArguments: "{}", arguments: { path: "src/a.js" } },
          { id: "r2", name: "read_file", rawArguments: "{}", arguments: { path: "src/b.js" } },
        ], usage: { input: 10, output: 1, reasoning: 0, cached: 0, total: 11 } };
      }
      if (turn === 2) {
        return { text: "", toolCalls: [
          { id: "w1", name: "write_file", rawArguments: "{}", arguments: { path: "src/a.js", contents: "export const a = 99;" } },
        ], usage: { input: 10, output: 1, reasoning: 0, cached: 0, total: 11 } };
      }
      return { text: "done", toolCalls: [], usage: { input: 10, output: 1, reasoning: 0, cached: 0, total: 11 } };
    },
  };

  const impls = {
    read_file: ({ path: p }) => ({ contents: tree[p] }),
    write_file: ({ path: p, contents }) => { tree[p] = contents; return { bytes: contents.length, created: false }; },
  };

  const result = await runAgent({
    provider, systemPrompt: "s", tools: [], toolImpls: impls,
    tree, prompt: "p", maxTurns: 5, log: () => {}, compactStaleReads: true,
  });

  // Turn 3's history: the read of a.js (patched at turn 2) is a stub; the read of b.js (never
  // patched) is intact.
  const turn3 = sent[2];
  const readA = turn3.find((m) => m.role === "tool" && m.toolCallId === "r1");
  const readB = turn3.find((m) => m.role === "tool" && m.toolCallId === "r2");
  const stubbed = JSON.parse(readA.output);
  assert.ok(stubbed._superseded, "the stale read is replaced with a deterministic stub");
  assert.ok(stubbed.readHash && stubbed.currentHash && stubbed.readHash !== stubbed.currentHash);
  assert.deepEqual(stubbed.currentExports, ["a"], "the stub names the current exports");
  assert.ok(!readA.output.includes("export const a = 1;"), "the old body is GONE from active history");
  assert.ok(JSON.parse(readB.output).contents.includes("export const b"), "an unpatched read survives verbatim");
  assert.ok(result.telemetry.prunedTokens > 500, `tokens pruned: ${result.telemetry.prunedTokens}`);
});

// ── R3: the shared stage prefix is byte-stable ────────────────────────────────────────────────

test("R3 — the shared prefix blocks are static and contract rendering is deterministic", () => {
  assert.equal(contractBrief(CONTRACT), contractBrief(CONTRACT), "contract brief is byte-stable");
  assert.ok(!/\d{4}-\d{2}-\d{2}|Date\.now|Math\.random/.test(STAGE_RUNTIME_CONTRACT + STAGE_GLOBAL_INVARIANTS),
    "nothing dynamic in the static blocks");
  // The shared system a post-foundation stage receives, assembled twice, is identical.
  const assemble = () => ["edit-system", STAGE_RUNTIME_CONTRACT, contractBrief(CONTRACT), STAGE_GLOBAL_INVARIANTS].join("\n\n");
  assert.equal(assemble(), assemble());
});

test("R3 — buildJobs uses ONE shared system for every post-foundation stage call and logs its hash", () => {
  const source = readFileSync("shell/server/lib/buildJobs.mjs", "utf8");
  assert.match(source, /systemPrompt: first \? systemPrompt : stageSharedSystem/,
    "the runAgent system prompt is the shared prefix, not a per-stage assembly");
  assert.ok(!/systemPromptForEdit\("apply_patch"\)\}\\n\\n\$\{designProfile/.test(source),
    "the old per-call assembly is gone");
  assert.match(source, /prefix \$\{prefixHash\}/, "the prefix hash is logged for every stage call");
  assert.match(source, /frozenDesignBrief/, "the design brief is frozen so mid-build photo searches cannot bust the prefix");
  // Stage-varying content (manifest, objective) goes in the USER message, after the prefix.
  assert.match(source, /prompt: `\$\{renderContext\(selected/, "changing content stays out of the system prompt");
});

// ── R4: acceptance expectations reach the builder, and every journey is owned ─────────────────

test("R4 — a skipped polish stage no longer orphans its journeys (the real coverage hole)", () => {
  // The booking run: design profile present → polish skipped → use-responsive-navigation owned
  // by NO stage. Now it lands on supporting.
  const without = planStages(CONTRACT, { includePolish: false });
  const supporting = without.find((s) => s.id === "supporting");
  assert.ok(supporting.journeys.some((j) => j.id === "use-responsive-navigation"),
    "the navigation journey is reassigned to supporting");
  assert.equal(acceptanceCoverage(CONTRACT, without).ok, true, "all five journeys owned without polish");

  const withPolish = planStages(CONTRACT, { includePolish: true });
  const polish = withPolish.find((s) => s.id === "polish");
  assert.ok(polish.journeys.some((j) => j.id === "use-responsive-navigation"),
    "with polish present it keeps its declared stage");
  assert.equal(acceptanceCoverage(CONTRACT, withPolish).ok, true);
});

test("R4 — coverage fails loudly when a journey is owned by no stage", () => {
  const coverage = acceptanceCoverage(CONTRACT, planStages(CONTRACT, { includePolish: false })
    .filter((s) => s.id !== "supporting" && s.id !== "polish"));
  assert.equal(coverage.ok, false);
  assert.ok(coverage.missing.some((m) => m.journey === "use-responsive-navigation"));
});

test("R4 — the stage prompt demands state TRANSITIONS, and names the verifier's freshness rule", () => {
  const stages = planStages(CONTRACT, { includePolish: false });
  const primary = stages.find((s) => s.id === "primary_journey");
  const prompt = stagePrompt(primary, CONTRACT, { request: "booking site" });

  // The exact step that failed in production: "choose an available date".
  const step = CONTRACT.journeys[0].steps.find((s) => s.action.includes("choose an available date"));
  const wanted = expectationKeywords(step.expect);
  assert.ok(wanted.includes("selected") && wanted.includes("highlighted"), wanted.join(","));
  // v2: initial state → action → resulting state, with the anti-gaming rule stated plainly —
  // the 46.10-credit run answered a keyword list with static copy and correctly failed.
  assert.ok(prompt.includes(`before: ${wanted.join(", ")} absent (or in their pre-action state) · after: they newly appear or visibly change`));
  assert.match(prompt, /snapshots the page BEFORE each action/);
  assert.match(prompt, /static copy count for NOTHING/);
  assert.match(prompt, /a real state transition/);
  assert.ok(!prompt.includes("verifier looks for on-page text:"), "the keyword-list phrasing that invited static copy is gone");
});

// ── R5: deterministic checks run inside the stage gate ────────────────────────────────────────

const okCompile = async () => ({ ok: true, stderr: "" });

test("R5 — the monolithic production tree now fails the gate at MODULARITY, before anything else", async () => {
  // The exact 94ad0b0f tree: one 11.5k-token App.jsx owning every journey. That shape is now a
  // structural stage-gate failure — the gate that keeps the 46.10-credit economics from recurring.
  const gate = await runStageGate(bookingTree(), {
    contract: CONTRACT, stage: { id: "data", journeys: [] }, compile: okCompile,
  });
  assert.equal(gate.ok, false);
  assert.ok(gate.checks.some((c) => c.name === "modularity" && !c.ok));
  assert.ok(gate.problems.some((p) => /src\/App\.jsx is \d+ tokens/.test(p) && /src\/routes\//.test(p)),
    JSON.stringify(gate.problems));
});

test("R5 — the localStorage defect is caught and FIXED by the gate of the stage that wrote it", async () => {
  // A MODULAR data-stage tree containing the exact production newsletter guest branch.
  const tree = {
    ...bookingTree(),
    "src/App.jsx": "import HomePage from \"./routes/HomePage\";\nexport default function App() { return <HomePage />; }",
    "src/routes/HomePage.jsx": "export default function HomePage() { return <main>Berry Brook</main>; }",
  };
  const gate = await runStageGate(tree, {
    contract: CONTRACT, stage: { id: "data", journeys: [] }, compile: okCompile,
  });
  assert.equal(gate.ok, true, JSON.stringify(gate.problems));
  assert.ok(gate.deterministicRepair, "the safe transform was applied in-stage at zero credits");
  assert.ok(gate.tree["src/lib/visitorSession.js"], "the SCAFFOLD session module backs the fix — nothing hand-written");
  assert.ok(gate.checks.some((c) => c.name === "honesty" && c.ok));
  assert.ok(!gate.tree["src/data/newsletterSignup.js"].includes("localStorage.setItem(\"berry-brook-newsletter-signups\""));
});

test("R5 — an untransformable persistence defect fails the stage gate, feeding the cheap in-stage repair", async () => {
  const tree = {
    ...bookingTree(),
    // No bootstrap anywhere and a shape the transform cannot prove.
    "src/App.jsx": "export default function App() { return <div/>; }",
    "src/data/newsletterSignup.js": 'export function weird() { localStorage.setItem("x", JSON.stringify(window.everything)); }',
  };
  const gate = await runStageGate(tree, {
    contract: CONTRACT, stage: { id: "data", journeys: [] }, compile: okCompile,
  });
  assert.equal(gate.ok, false);
  assert.ok(gate.checks.some((c) => c.name === "honesty" && !c.ok));
  assert.ok(gate.problems.some((p) => /records stored in the browser/.test(p)));
});

test("R5 — the stage-scoped scan does not fail the foundation for not yet calling the backend", async () => {
  const tree = {
    ...bookingTree(),
    "src/App.jsx": "export default function App() { return <div>Berry Brook</div>; }",
    "src/data/booking.js": undefined, "src/data/newsletterSignup.js": undefined,
  };
  delete tree["src/data/booking.js"];
  delete tree["src/data/newsletterSignup.js"];
  const gate = await runStageGate(tree, {
    contract: CONTRACT, stage: { id: "foundation", journeys: [] }, compile: okCompile,
  });
  // Entities are declared and nothing calls db.entity yet — that is CORRECT at stage one.
  assert.equal(gate.ok, true, JSON.stringify(gate.problems));
});

test("R5 — a journey outcome with zero trace in any screen fails the owning stage's gate", async () => {
  const newsletter = CONTRACT.journeys.find((j) => j.id === "newsletter-signup");
  const bare = {
    ...bookingTree(),
    "src/App.jsx": "export default function App() { return <div>Berry Brook Farm booking</div>; }",
  };
  delete bare["src/data/newsletterSignup.js"];
  const gate = await runStageGate(bare, {
    contract: CONTRACT, stage: { id: "supporting", journeys: [newsletter] }, compile: okCompile,
  });
  assert.equal(gate.ok, false);
  assert.ok(gate.checks.some((c) => c.name === "expectations" && !c.ok));
  assert.ok(gate.problems.some((p) => /newsletter/.test(p) && /verifier will look for/.test(p)));

  // And with the journey's OWN module present — where the newsletter UI exists — it passes.
  const modular = {
    ...bare,
    "src/components/NewsletterSignup.jsx":
      "export default function NewsletterSignup() { return <section>Newsletter signup — a success message confirms you joined.</section>; }",
  };
  const real = await runStageGate(modular, {
    contract: CONTRACT, stage: { id: "supporting", journeys: [newsletter] }, compile: okCompile,
  });
  assert.ok(real.checks.some((c) => c.name === "expectations" && c.ok), JSON.stringify(real.problems));
});
