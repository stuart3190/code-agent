// WP-10 (V2-18) — the EDIT path, proven hermetically at zero credits: adopt the green
// snapshot → patch → gate → DIFFERENTIAL verification (unchanged owners reuse cached
// verdicts; exactly the touched journey re-drives) → atomic promotion. A failed edit
// promotes nothing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { editTargets, renderPatchPrompt } from "../../shell/server/lib/builderV2/modelLanes.mjs";

// The WP-8 harness builds a real multi-module green (BookPage + NewsletterPanel +
// AboutSection) through the real scaffold, patch engine, gates and snapshot store.
import { createOrchestrator, memoryBuildStore } from "../../shell/server/lib/builderV2/orchestrator.mjs";
import { createSnapshotStore } from "../../shell/server/lib/builderV2/snapshotStore.mjs";
import { memoryVerificationCache } from "../../shell/server/lib/builderV2/verification.mjs";
import { createAssetService } from "../../shell/server/lib/builderV2/assets/assetService.mjs";
import { pexelsProvider } from "../../shell/server/lib/builderV2/assets/pexelsProvider.mjs";
import { REACT_VITE } from "../../src/scaffolds/reactVite.mjs";
import { fromScaffold, clone } from "../../src/engine/fileTree.mjs";

const CONTRACT = {
  summary: "Sunny Acres strawberry farm booking site",
  entities: [{ name: "booking" }, { name: "newslettersignup" }],
  operations: [{ id: "create-booking", description: "create a booking reservation" }],
  routes: [{ path: "/", name: "Home" }, { path: "/book", name: "Booking" }],
  auth: { required: false },
  journeys: [
    { id: "book-a-visit", title: "Book a farm visit", priority: "primary",
      steps: [{ action: "submit the booking form", expect: "booking confirmed" }] },
    { id: "newsletter-signup", title: "Newsletter signup", priority: "secondary",
      steps: [{ action: "enter an email", expect: "newsletter subscribed" }] },
    { id: "browse-info", title: "Browse farm information", priority: "secondary",
      steps: [{ action: "open the about section", expect: "about the farm" }] },
  ],
};

const CORE_PATCH = [{
  newFile: "src/routes/BookPage.jsx",
  content: `import React, { useState } from "react";

export default function BookPage() {
  const [state, setState] = useState("idle");
  return (
    <main>
      <h1>Book a farm visit</h1>
      {state === "confirmed" ? <p role="status">Booking confirmed — reference SA-1</p> : null}
      <button onClick={() => setState("confirmed")}>Submit booking</button>
    </main>
  );
}
`,
}];
const NEWSLETTER_PATCH = [{
  newFile: "src/routes/NewsletterPanel.jsx",
  content: `import React, { useState } from "react";

export default function NewsletterPanel() {
  const [state, setState] = useState("idle");
  return (
    <section>
      {state === "done" ? <p role="status">Newsletter subscribed</p> : null}
      <button onClick={() => setState("done")}>Subscribe</button>
    </section>
  );
}
`,
}];
const BROWSE_PATCH = [{
  newFile: "src/routes/AboutSection.jsx",
  content: `import React from "react";

export default function AboutSection() {
  return <section><h2>About the farm</h2><p>Family-run strawberry fields since 1987.</p></section>;
}
`,
}];

// The edit: reword ONLY the newsletter panel's confirmation.
const EDIT_PATCH = [{
  file: "src/routes/NewsletterPanel.jsx",
  ops: [{
    op: "replace_symbol", symbol: "NewsletterPanel",
    content: `export default function NewsletterPanel() {
  const [state, setState] = useState("idle");
  return (
    <section>
      {state === "done" ? <p role="status">Newsletter subscribed — welcome aboard</p> : null}
      <button onClick={() => setState("done")}>Subscribe</button>
    </section>
  );
}`,
  }],
}];

function recordedAssetService() {
  const rows = [];
  let n = 0;
  const chain = () => {
    const state = { filters: [], op: "select", payload: null, maybe: false, onConflict: null };
    const matches = (r) => state.filters.every(([c, v]) => r[c] === v);
    const run = () => {
      if (state.op === "select") { const out = rows.filter(matches).map((r) => ({ ...r })); return state.maybe ? { data: out[0] || null, error: null } : { data: out, error: null }; }
      if (state.op === "upsert") {
        const keys = (state.onConflict || "").split(",");
        const existing = rows.find((r) => keys.every((k) => r[k] === state.payload[k]));
        if (existing) Object.assign(existing, state.payload); else rows.push({ id: `a-${++n}`, ...state.payload });
        const saved = rows.find((r) => keys.every((k) => r[k] === state.payload[k]));
        return state.maybe ? { data: { ...saved }, error: null } : { data: [{ ...saved }], error: null };
      }
      if (state.op === "update") { for (const r of rows) if (matches(r)) Object.assign(r, state.payload); return { data: null, error: null }; }
      if (state.op === "delete") { const keep = rows.filter((r) => !matches(r)); rows.length = 0; rows.push(...keep); return { data: null, error: null }; }
      return { data: null, error: { message: "unsupported" } };
    };
    const api = {
      select: () => api,
      upsert: (p, o = {}) => { state.op = "upsert"; state.payload = p; state.onConflict = o.onConflict; return api; },
      update: (p) => { state.op = "update"; state.payload = p; return api; },
      delete: () => { state.op = "delete"; return api; },
      eq: (c, v) => { state.filters.push([c, v]); return api; },
      maybeSingle: () => { state.maybe = true; return Promise.resolve(run()); },
      then: (res, rej) => Promise.resolve(run()).then(res, rej),
    };
    return api;
  };
  const provider = pexelsProvider({
    apiKey: "k",
    fetchImpl: async () => ({ ok: true, json: async () => ({ photos: [{ id: 1, width: 2000, height: 1300, alt: "farm rows in light", src: { original: "https://images.pexels.com/1/o.jpg", large2x: "https://images.pexels.com/1/l.jpg", medium: "https://images.pexels.com/1/m.jpg" } }] }) }),
  });
  return createAssetService({ providers: [provider], client: { from: chain }, now: () => new Date("2026-08-06T08:00:00Z") });
}

function editHarness() {
  const buildStore = memoryBuildStore();
  const snapshotStore = createSnapshotStore();
  const verificationCache = memoryVerificationCache();
  const assetService = recordedAssetService();
  const journeyDrives = [];
  let editPatches = EDIT_PATCH;
  const orchestrator = createOrchestrator({
    contractFn: async () => CONTRACT,
    patchesFn: async ({ step }) => ({
      core: () => CORE_PATCH,
      "increment:newsletter-signup": () => NEWSLETTER_PATCH,
      "increment:browse-info": () => BROWSE_PATCH,
      edit: () => editPatches,
    })[step](),
    assetService, snapshotStore, buildStore, verificationCache,
    journeysFn: async ({ journeys }) => {
      journeyDrives.push(journeys.map((j) => j.id));
      return { journeys: journeys.map((j) => ({ id: j.id, title: j.title, priority: j.priority, status: "pass" })) };
    },
    baseTree: () => clone(fromScaffold(REACT_VITE)),
    baseline: REACT_VITE,
  });
  return { orchestrator, snapshotStore, journeyDrives, assetService, setEditPatches: (p) => { editPatches = p; } };
}

test("WP10 — an edit re-drives EXACTLY the touched journey; the others reuse cached verdicts", async () => {
  const h = editHarness();
  const build = await h.orchestrator.runBuild({ owner: "o", projectId: "p1", request: "booking site" });
  assert.equal(build.state, "green");
  const drivesBefore = h.journeyDrives.length;

  const edit = await h.orchestrator.runEdit({ owner: "o", projectId: "p1", request: "reword the newsletter confirmation", contract: CONTRACT });
  assert.equal(edit.state, "green", JSON.stringify(edit));
  assert.deepEqual(edit.drove, ["newsletter-signup"], "EXACTLY the journey whose owning module changed");
  assert.deepEqual(edit.reused.sort(), ["book-a-visit", "browse-info"], "unchanged owners reuse cached PASS verdicts");
  assert.deepEqual(h.journeyDrives.slice(drivesBefore), [["newsletter-signup"]], "the browser drove one journey, once");

  // Lineage + promotion: the edit snapshot's parent is the prior green, pointer moved.
  const pointer = await h.snapshotStore.pointer("o", "p1", "green");
  assert.equal(pointer, edit.snapshotId);
  const snap = await h.snapshotStore.getSnapshot(edit.snapshotId);
  assert.equal(snap.reason, "edit");
  assert.equal(snap.parent_snapshot, edit.parentSnapshotId);
  const tree = await h.snapshotStore.materialize("o", pointer);
  assert.match(tree["src/routes/NewsletterPanel.jsx"], /welcome aboard/);
  assert.equal(edit.providerCalls, undefined, "no asset resolution ran at all");
});

test("WP10 — a failed edit promotes NOTHING: the prior green keeps serving", async () => {
  const h = editHarness();
  const build = await h.orchestrator.runBuild({ owner: "o", projectId: "p1", request: "booking site" });
  const before = await h.snapshotStore.pointer("o", "p1", "green");

  // An edit that vandalises the ESSENTIAL journey's outcome text: the gate's expectation
  // check fails it deterministically, twice → stop rule → blocked.
  h.setEditPatches([{
    file: "src/routes/BookPage.jsx",
    ops: [{ op: "replace_symbol", symbol: "BookPage",
      content: "export default function BookPage() {\n  return <main><h1>Placeholder</h1></main>;\n}" }],
  }]);
  const edit = await h.orchestrator.runEdit({ owner: "o", projectId: "p1", request: "break it", contract: CONTRACT });
  assert.equal(edit.state, "blocked");
  assert.equal(await h.snapshotStore.pointer("o", "p1", "green"), before, "pointer untouched");
  const tree = await h.snapshotStore.materialize("o", before);
  assert.match(tree["src/routes/BookPage.jsx"], /Booking confirmed/, "the served tree still works");
  assert.equal(build.state, "green");
});

test("WP10 — editTargets ranks generated files by request keywords, deterministically", () => {
  const tree = {
    "src/routes/BookPage.jsx": "export function BookPage() { return 'hero headline booking'; }",
    "src/routes/NewsletterPanel.jsx": "export function NewsletterPanel() { return 'newsletter subscribe confirmation'; }",
    "src/lib/capabilities/forms.js": "newsletter newsletter newsletter",
    "src/components/Nav.jsx": "export function Nav() { return 'navigation'; }",
  };
  const targets = editTargets(tree, "reword the newsletter confirmation message");
  assert.deepEqual(targets, ["src/routes/NewsletterPanel.jsx"], "platform lib files are never edit targets");
  assert.deepEqual(editTargets(tree, "change the hero headline"), ["src/routes/BookPage.jsx"]);

  const prompt = renderPatchPrompt({
    step: "edit", contract: CONTRACT, tiers: { essential: { journeys: [], entities: [], operations: [] }, secondary: { journeys: [], entities: [], operations: [] } },
    tree, editRequest: "reword the newsletter confirmation message",
  });
  assert.match(prompt, /Apply EXACTLY this change/);
  assert.match(prompt, /reword the newsletter confirmation message/);
  assert.match(prompt, /NewsletterPanel\.jsx \(current content\)/, "the targeted file rides along in full");
  assert.match(prompt, /smallest correct patch wins/);
});
