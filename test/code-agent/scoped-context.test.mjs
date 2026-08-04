// Selective context, enforced at the tool boundary and tested against the real booking tree.
//
// A small initial context achieves nothing if the model then reads its way back to the whole
// project — which is exactly what produced the 292,652-token Supporting stage.

import { test } from "node:test";
import assert from "node:assert/strict";
import { makeScopedFileTools } from "../../shell/server/lib/appBuild/scopedFileTools.mjs";
import { buildManifest } from "../../shell/server/lib/appBuild/projectManifest.mjs";
import { targetsForStage, buildStageContext } from "../../shell/server/lib/appBuild/contextBuilder.mjs";

const TREE = {
  "package.json": '{"name":"x","type":"module","scripts":{"build":"vite build"}}',
  "src/main.jsx": 'import App from "./App.jsx";',
  "src/App.jsx": 'import { listBookings } from "./data/bookings.js";\nexport default function App(){return null}',
  "src/data/bookings.js": 'import { db } from "../lib/backend";\nexport async function listBookings(){ return db.entity("booking").list(); }',
  "src/lib/backend/index.js": "export const db = {};",
  "src/components/ui/button.jsx": "export function Button(){return null}",
  "src/components/ui/input.jsx": "export function Input(){return null}",
  "src/components/BookingForm.jsx": 'import { Button } from "./ui/button.jsx";\nexport function BookingForm(){return null}',
  "src/components/Newsletter.jsx": "export function Newsletter(){return null}",
};
const CONTRACT = {
  journeys: [
    { id: "book", title: "A visitor books a slot", priority: "primary" },
    { id: "newsletter", title: "A visitor joins the newsletter", priority: "secondary" },
  ],
  entities: [{ name: "booking", fields: [] }],
};

test("OVER-INCLUSION 1 — foundation no longer takes all of src/components/", () => {
  // On the real booking tree this matched 20 of 27 files: the foundation stage would have been
  // handed most of the project just to establish routing.
  const manifest = buildManifest(TREE, { contract: CONTRACT });
  const targets = targetsForStage("foundation", manifest, { contract: CONTRACT });
  assert.ok(!targets.includes("src/components/ui/button.jsx"));
  assert.ok(!targets.includes("src/components/BookingForm.jsx"));
  assert.ok(targets.includes("src/App.jsx"), "but it does get the shell it must build");
});

test("OVER-INCLUSION 2 — supporting no longer takes the design primitives", () => {
  // src/components/ui/ are primitives a supporting-screens stage consumes rather than edits, and
  // they made up most of its 18-file context on the real tree.
  const manifest = buildManifest(TREE, { contract: CONTRACT });
  const targets = targetsForStage("supporting", manifest, { contract: CONTRACT });
  assert.ok(!targets.includes("src/components/ui/button.jsx"));
  assert.ok(!targets.includes("src/components/ui/input.jsx"));
  assert.ok(targets.includes("src/components/Newsletter.jsx"), "but it does get the screens it owns");
});

test("a file outside the change set returns its interface, not its body", () => {
  const manifest = buildManifest(TREE, { contract: CONTRACT });
  const tools = makeScopedFileTools(TREE, { manifest, allowed: ["src/App.jsx"] });

  const open = tools.impls.read_file({ path: "src/App.jsx" });
  assert.ok(String(JSON.stringify(open)).includes("listBookings"), "an allowed file reads in full");

  const closed = tools.impls.read_file({ path: "src/data/bookings.js" });
  assert.ok(closed.interface, "a file outside the set returns an interface");
  assert.ok(!closed.content, "and not its body");
  assert.match(closed.interface, /exports:/);
  assert.equal(tools.telemetry.summaryReads.length, 1);
});

test("an expansion needs a stated reason, and is recorded", () => {
  const manifest = buildManifest(TREE, { contract: CONTRACT });
  const events = [];
  const tools = makeScopedFileTools(TREE, {
    manifest, allowed: ["src/App.jsx"], onEvent: (e) => events.push(e),
  });

  const expanded = tools.impls.read_file({
    path: "src/data/bookings.js",
    reason: "I am changing how App calls listBookings and need its signature",
  });
  assert.ok(String(JSON.stringify(expanded)).includes("db.entity"), "a reasoned expansion is granted");
  assert.equal(tools.telemetry.expansionCount, 1);
  assert.ok(events.some((e) => e.type === "expanded"));
});

test("expansions are capped, so a stage cannot read its way back to the whole tree", () => {
  const manifest = buildManifest(TREE, { contract: CONTRACT });
  const tools = makeScopedFileTools(TREE, {
    manifest, allowed: ["src/App.jsx"], maxExpansions: 2,
  });
  const reason = "I need this file's implementation for the change";
  tools.impls.read_file({ path: "src/data/bookings.js", reason });
  tools.impls.read_file({ path: "src/components/BookingForm.jsx", reason });
  const refused = tools.impls.read_file({ path: "src/components/Newsletter.jsx", reason });

  assert.ok(refused.error, "the third expansion is refused");
  assert.match(refused.error, /Context budget reached/);
  assert.match(refused.error, /Here is the interface instead/, "and it still gets the interface");
  assert.equal(tools.telemetry.refusals.length, 1);
});

test("tree reconstruction is detected rather than assumed", () => {
  const manifest = buildManifest(TREE, { contract: CONTRACT });
  const few = makeScopedFileTools(TREE, { manifest, allowed: ["src/App.jsx"] });
  assert.equal(few.reconstructedTree(Object.keys(TREE).length), false);

  const most = makeScopedFileTools(TREE, { manifest, allowed: Object.keys(TREE) });
  assert.equal(most.reconstructedTree(Object.keys(TREE).length), true);
});

test("every stage context stays inside its budget and omits something", () => {
  const manifest = buildManifest(TREE, { contract: CONTRACT });
  for (const stage of ["foundation", "data", "primary_journey", "supporting"]) {
    const context = buildStageContext({
      tree: TREE, manifest, stageId: stage, contract: CONTRACT,
      objective: "x", systemPrompt: "y", budgetTokens: 40_000,
    });
    assert.equal(context.ok, true, `${stage} exceeded its budget`);
    assert.ok(context.full.every((c) => c.reason), `${stage} included a file with no reason`);
    assert.ok(context.tokens < context.wholeTreeTokens + 1000, `${stage} is not smaller than the whole tree`);
  }
});
