// Scoped context pipeline: proves small changes never carry the project, previews never
// wake the model, identical failures stop the repair loop, old chat is summarised, and
// context diagnostics match what was actually sent.

process.env.CODE_AGENT_STORE = "memory";

import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { runAgent } from "../../src/engine/runAgent.mjs";
import { makeFileTools } from "../../src/tools/fileTools.mjs";
import {
  classifyTask, taskBudget, inferEntryFile, scopeForJob,
  fingerprintFailure, fingerprintPrompt, costGuard, estTokens,
} from "../../shell/server/lib/appBuild/contextScope.mjs";
import { planEndAction, MAX_AUTO_ROUNDS } from "../../shell/server/lib/appBuild/appBuildService.mjs";
import { assembleInput } from "../../shell/server/lib/leadAgentService.mjs";
import { MemoryConversationStore } from "../../shell/server/lib/conversationStore.mjs";

function tree() {
  const t = {
    "src/App.jsx": 'import Header from "./components/Header.jsx";\nexport default function App(){return <Header/>}',
    "src/components/Header.jsx": 'import { label } from "../lib/labels.js";\nexport default function Header(){return <button>{label}</button>}',
    "src/lib/labels.js": 'export const label = "Another quote";',
  };
  for (let i = 0; i < 15; i += 1) t[`src/components/Unrelated${i}.jsx`] = `UNRELATED_SECRET_${i} ${"x".repeat(500)}`;
  return t;
}

function capturingProvider(script) {
  const sent = [];
  let step = 0;
  return {
    sent,
    model: "stub",
    runTurn: async ({ systemPrompt, messages }) => {
      sent.push(systemPrompt + JSON.stringify(messages));
      const action = script[Math.min(step, script.length - 1)];
      step += 1;
      return {
        text: action.text || "",
        toolCalls: (action.calls || []).map((c, i) => ({ id: `t${step}-${i}`, name: c.name, arguments: c.args, rawArguments: JSON.stringify(c.args) })),
        usage: { input: 100, output: 20, reasoning: 0, cached: 0, total: 120 },
      };
    },
  };
}

test("renaming one button never sends unrelated file contents to the model", async () => {
  const t = tree();
  const { schemas, impls } = makeFileTools(t, { editFormat: "apply_patch" });
  const provider = capturingProvider([
    { calls: [{ name: "apply_patch", args: { input: "*** Begin Patch\n*** Update File: src/components/Header.jsx\n@@\n-<button>{label}</button>\n+<button>{label}!</button>\n*** End Patch" } }] },
    { text: "Done." },
  ]);
  const scope = scopeForJob({ mode: "iterate", prompt: "Rename the button label on the Header", tree: t });
  assert.equal(scope.contextSelection, true);
  assert.equal(scope.entryFile, "src/components/Header.jsx");
  await runAgent({
    provider, systemPrompt: "edit precisely", tools: schemas, toolImpls: impls, tree: t,
    prompt: "Rename the button", log: () => {},
    contextSelection: scope.contextSelection, entryFile: scope.entryFile,
  });
  const everything = provider.sent.join("\n");
  assert.equal(/UNRELATED_SECRET_/.test(everything), false, "unrelated contents never sent");
  assert.match(everything, /Another quote/, "the seeded entry dependency IS in context");
});

test("scope seeds only the entry file and its direct imports, with reasons", () => {
  const scope = scopeForJob({ mode: "iterate", prompt: "fix the Header button", tree: tree() });
  const paths = scope.files.map((f) => f.path);
  assert.deepEqual(paths.sort(), ["src/components/Header.jsx", "src/lib/labels.js"]);
  assert.ok(scope.files.every((f) => f.reason.length > 5), "every file carries its inclusion reason");
});

test("a single-file compile error retrieves only that file's dependency scope", () => {
  const stderr = "src/components/Header.jsx: Unexpected token (3:7)\n  at compile";
  const entry = inferEntryFile(tree(), stderr);
  assert.equal(entry, "src/components/Header.jsx");
  const scope = scopeForJob({ mode: "iterate", prompt: stderr, trigger: "autonomous_repair", tree: tree() });
  assert.equal(scope.taskType, "debugging");
  assert.ok(scope.files.every((f) => !f.path.includes("Unrelated")), "no unrelated files seeded");
});

test("task classification and budgets behave and are configurable", () => {
  assert.equal(classifyTask({ mode: "iterate", prompt: "Change the title text to Hello" }), "quick_edit");
  assert.equal(classifyTask({ mode: "iterate", prompt: "Add a feature: a booking page with a calendar flow" }), "feature");
  assert.equal(classifyTask({ mode: "build", prompt: "anything" }), "full_build");
  assert.equal(classifyTask({ mode: "iterate", prompt: "x", trigger: "verification_repair" }), "verification_repair");
  assert.ok(taskBudget("quick_edit") < taskBudget("feature"));
  process.env.THRALLO_CTX_BUDGET_SIMPLE = "1234";
  assert.equal(taskBudget("quick_edit"), 1234);
  delete process.env.THRALLO_CTX_BUDGET_SIMPLE;
  // Over-budget scope carries an explicit warning instead of silently sending.
  const bigTree = { "src/components/Titlebar.jsx": `titlebar ${"x".repeat(200_000)}` };
  process.env.THRALLO_CTX_BUDGET_SIMPLE = "100";
  const scope = scopeForJob({ mode: "iterate", prompt: "change the Titlebar text wording", tree: bigTree });
  delete process.env.THRALLO_CTX_BUDGET_SIMPLE;
  assert.equal(scope.entryFile, "src/components/Titlebar.jsx");
  assert.ok(scope.warnings.some((w) => /exceeds/.test(w)), "oversized context warns");
});

test("restarting a preview makes zero AI calls (structural guarantee)", async () => {
  const service = await readFile(fileURLToPath(new URL("../../shell/server/lib/appBuild/appBuildService.mjs", import.meta.url)), "utf8");
  const showPreview = /export async function showPreview[\s\S]*?\n\}/.exec(service)?.[0] || "";
  const recover = /async function recoverPreview[\s\S]*?\n\}/.exec(service)?.[0] || "";
  for (const [name, src] of [["showPreview", showPreview], ["recoverPreview", recover]]) {
    assert.ok(src.length > 100, `${name} found`);
    assert.doesNotMatch(src, /model|provider\.turn|runAgent|createJob|createRouted/i, `${name} contains no AI or build dispatch`);
  }
  const verifier = await readFile(fileURLToPath(new URL("../../shell/server/lib/appBuild/verificationAgent.mjs", import.meta.url)), "utf8");
  assert.doesNotMatch(verifier, /modelGateway|createRouted|runAgent\(/, "verification itself is Playwright-local, no AI");
});

test("identical repair failures change the approach instead of burning rounds", () => {
  const failed = { status: "complete", result: { buildOk: false, qualityWarnings: ["Backend runtime unavailable: app-auth 404"] } };
  const first = planEndAction(failed, { attempt: 1 });
  assert.equal(first.kind, "repair");
  assert.ok(first.fingerprint, "failure fingerprinted");

  // PR3: the same failure twice no longer ends the run. It ends the STRATEGY. Repeating the same
  // approach was never the goal — but neither was stopping at attempt 2 of 3 with rounds to spare,
  // which is what production did on four builds with fingerprint ac60a9b42a79f171.
  const second = planEndAction(failed, {
    attempt: 2, previousFingerprints: [first.fingerprint], strategyId: first.strategy,
  });
  assert.equal(second.kind, "repair");
  assert.notEqual(second.strategy, first.strategy, "a repeated failure must change the approach");
  assert.match(second.announcement, /changing approach/);
  assert.ok(2 < MAX_AUTO_ROUNDS + 1, "and it did so without exhausting the rounds");

  // Different failure still repairs — the fingerprint guard is specific, not a blanket stop.
  const other = planEndAction(
    { status: "complete", result: { buildOk: false, qualityWarnings: ["a completely different check failed"] } },
    { attempt: 2, previousFingerprints: [first.fingerprint] },
  );
  assert.equal(other.kind, "repair");
  // A crash whose cause would reproduce identically is NOT retried any more: "npm ENOENT"
  // means a file is genuinely missing, so a second identical run wastes the user's budget.
  const enoent = planEndAction({ status: "failed", error: "npm ENOENT" }, { attempt: 2, previousFingerprints: [] });
  assert.equal(enoent.kind, "blocked");
  // Fingerprints normalize ids/numbers so cosmetic differences don't defeat the stop.
  assert.equal(fingerprintFailure(["error at line 14 in build 17e00fd2"]), fingerprintFailure(["error at line 99 in build 5442ed76"]));
  assert.notEqual(fingerprintPrompt("fix A"), fingerprintPrompt("fix B"));
});

test("old chat history is summarised, not replayed; fresh runs carry no raw history", async () => {
  const store = new MemoryConversationStore();
  const conversation = await store.createConversation("o1", { title: "long chat" });
  for (let i = 0; i < 30; i += 1) {
    await store.appendTurn(conversation, { role: i % 2 ? "lead" : "user", content: `MESSAGE_${i} ${"pad ".repeat(50)}` });
  }
  const input = await assembleInput(store, conversation);
  assert.ok(input.length <= 17, `recent window bounded (got ${input.length})`);
  assert.match(input[0].content, /Conversation summary/, "older turns collapsed into a summary");
  assert.match(input[0].content, /MESSAGE_0/, "summary covers the oldest message");
  assert.equal(input[0].content.includes("pad pad pad pad pad pad pad pad pad pad pad pad pad pad pad pad pad pad pad pad pad pad pad pad pad pad pad pad pad pad pad pad pad pad pad pad pad pad pad pad pad pad pad pad pad pad pad pad pad pad"), false, "summary is condensed, not verbatim");
  const lastFull = input[input.length - 1].content;
  assert.match(lastFull, /MESSAGE_29/, "recent turns ride in full");
  // Oversized turns are capped.
  const conversation2 = await store.createConversation("o1", { title: "big turn" });
  await store.appendTurn(conversation2, { role: "user", content: "E".repeat(20_000) });
  const capped = await assembleInput(store, conversation2);
  assert.ok(capped[0].content.length < 7_000, "giant turns truncated with a note");
  assert.match(capped[0].content, /truncated for context economy/);
});

test("context diagnostics match the actual request composition", async () => {
  const t = tree();
  const scope = scopeForJob({ mode: "iterate", prompt: "fix the Header button", tree: t, systemPromptChars: 4000 });
  const seededChars = scope.files.reduce((a, f) => a + (t[f.path] || "").length, 0);
  const expected = estTokens("fix the Header button") + 1000 + Math.round(seededChars / 4);
  assert.equal(scope.estContextTokens, expected, "recorded estimate equals what the request carries");
});

test("cost guard blocks pathological autonomous requests but never user ones", () => {
  process.env.THRALLO_COST_APPROVAL_CREDITS = "5";
  const auto = costGuard({ estContextTokens: 500_000, model: "gpt-5.6-sol", trigger: "autonomous_repair" });
  assert.equal(auto.blocked, true);
  const user = costGuard({ estContextTokens: 500_000, model: "gpt-5.6-sol", trigger: "user" });
  assert.equal(user.blocked, false, "user-triggered work is warned, never silently blocked");
  delete process.env.THRALLO_COST_APPROVAL_CREDITS;
  const small = costGuard({ estContextTokens: 2_000, model: "gpt-5.6-sol", trigger: "autonomous_repair" });
  assert.equal(small.blocked, false);
});

test("task classification uses the user's words, not a capability wrapper", () => {
  const wrapper = [
    'REPAIR MODE — fix ONLY this reported problem in the existing app "DiagProof":',
    "rename the New quote button label to Next",
    "Hard rules: preserve the existing design, layout, colours, branding, UX...",
  ].join("\n");
  // The wrapper alone reads as debugging…
  assert.equal(classifyTask({ mode: "iterate", prompt: wrapper }), "debugging");
  // …but the scope classifies from the user's own request when it is supplied.
  const scope = scopeForJob({
    mode: "iterate", prompt: wrapper,
    classifyPrompt: "rename the New quote button label to Next",
    tree: { "src/Header.jsx": "export default function Header(){return <button>New quote</button>}" },
  });
  assert.equal(scope.taskType, "quick_edit", "per-task learning sees the real task");
});
