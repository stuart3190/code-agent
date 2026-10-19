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
  routes: [{ path: "/book", name: "Booking" }, { path: "/newsletter", name: "Newsletter" },
    { path: "/about", name: "About" }],
  auth: { required: false },
  journeys: [
    { id: "book-a-visit", title: "Book a farm visit", priority: "primary",
      steps: [{ action: "submit the booking form", target: "/book", expect: "booking confirmed" }] },
    { id: "newsletter-signup", title: "Newsletter signup", priority: "secondary",
      steps: [{ action: "enter an email", target: "/newsletter", expect: "newsletter subscribed" }] },
    { id: "browse-info", title: "Browse farm information", priority: "secondary",
      steps: [{ action: "open the about section", target: "/about", expect: "about the farm" }] },
  ],
};

const CORE_PATCH = [{
  replaceFile: "src/screens/scaffold/BookingScreen.jsx",
  content: `import React, { useState } from "react";
import { ASSET_CREDITS } from "../../lib/assetData.js";
import { makeBookingSystem } from "../../lib/capabilities/index.js";

const booking = makeBookingSystem({ entity: "booking" });

export default function BookingScreen() {
  const [state, setState] = useState("idle");
  return (
    <main>
      <h1>Book a farm visit</h1>
      {state === "confirmed" ? <p role="status">Booking confirmed — reference SA-1</p> : null}
      <button onClick={async () => { await booking.createBooking({ date: "2026-08-10", slot: "10:00", partySize: 2 }); setState("confirmed"); }}>Submit booking</button>
      <footer><a href="https://www.pexels.com">Photos provided by Pexels</a>{ASSET_CREDITS.map((credit) => credit.photoUrl ? <a key={credit.photoUrl} href={credit.photoUrl}>{credit.photographer}</a> : null)}</footer>
    </main>
  );
}
`,
}];
const NEWSLETTER_PATCH = [{
  replaceFile: "src/screens/scaffold/NewsletterScreen.jsx",
  content: `import React, { useState } from "react";
import { makeNewsletter } from "../../lib/capabilities/index.js";

const newsletter = makeNewsletter({ entity: "newslettersignup" });

export default function NewsletterScreen() {
  const [state, setState] = useState("idle");
  const [email, setEmail] = useState("");
  return (
    <section>
      {state === "done" ? <p role="status">Newsletter subscribed</p> : null}
      <label>Email address<input type="email" name="email" aria-label="email" value={email} onChange={(event) => setEmail(event.target.value)} /></label>
      <button onClick={async () => { await newsletter.subscribe(email || "reader@example.test"); setState("done"); }}>Subscribe</button>
    </section>
  );
}
`,
}];
const BROWSE_PATCH = [{
  replaceFile: "src/screens/scaffold/AboutScreen.jsx",
  content: `import React from "react";

export default function AboutScreen() {
  return <section><h2>About the farm</h2><p>Family-run strawberry fields since 1987.</p></section>;
}
`,
}];

// The edit: reword ONLY the newsletter panel's confirmation.
const EDIT_PATCH = [{
  file: "src/screens/scaffold/NewsletterScreen.jsx",
  ops: [{
    op: "replace_symbol", symbol: "NewsletterScreen",
    content: `export default function NewsletterScreen() {
  const [state, setState] = useState("idle");
  const [email, setEmail] = useState("");
  return (
    <section>
      {state === "done" ? <p role="status">Newsletter subscribed — welcome aboard</p> : null}
      <label>Email address<input type="email" name="email" aria-label="email" value={email} onChange={(event) => setEmail(event.target.value)} /></label>
      <button onClick={async () => { await newsletter.subscribe(email || "reader@example.test"); setState("done"); }}>Subscribe</button>
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
    fetchImpl: async () => ({ ok: true, json: async () => ({ photos: [{ id: 1, width: 2000, height: 1300, alt: "farm rows in light", photographer: "T", photographer_url: "https://www.pexels.com/@t", url: "https://www.pexels.com/photo/farm-1/", src: { original: "https://images.pexels.com/1/o.jpg", large2x: "https://images.pexels.com/1/l.jpg", medium: "https://images.pexels.com/1/m.jpg" } }] }) }),
  });
  return createAssetService({ providers: [provider], client: { from: chain }, now: () => new Date("2026-08-06T08:00:00Z") });
}

function editHarness() {
  const buildStore = memoryBuildStore();
  const snapshotStore = createSnapshotStore();
  const verificationCache = memoryVerificationCache();
  const assetService = recordedAssetService();
  const journeyDrives = [];
  const knowledgeFacts = [];
  let editPatches = EDIT_PATCH;
  let failJourneys = new Set();
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
      return { journeys: journeys.map((j) => ({ id: j.id, title: j.title, priority: j.priority, status: failJourneys.has(j.id) ? "fail" : "pass" })) };
    },
    baseTree: () => clone(fromScaffold(REACT_VITE)),
    baseline: REACT_VITE,
    events: { knowledge: async (fact) => { knowledgeFacts.push(fact); } },
  });
  return { orchestrator, snapshotStore, journeyDrives, knowledgeFacts, assetService, setEditPatches: (p) => { editPatches = p; },
    failJourneys: (ids) => { failJourneys = new Set(ids); } };
}

test("WP10/C3 — an edit re-drives the touched journey and every zero-owner journey", async () => {
  const h = editHarness();
  const build = await h.orchestrator.runBuild({ owner: "o", projectId: "p1", request: "booking site" });
  assert.equal(build.state, "green");
  const drivesBefore = h.journeyDrives.length;

  const edit = await h.orchestrator.runEdit({ owner: "o", projectId: "p1", request: "reword the newsletter confirmation", contract: CONTRACT });
  assert.equal(edit.state, "green", JSON.stringify(edit));
  assert.deepEqual(edit.drove, ["newsletter-signup"],
    "the changed mounted owner invalidates exactly its journey");
  assert.deepEqual(edit.reused, ["book-a-visit", "browse-info"],
    "complete unchanged mounted owners reuse their PASS verdicts");
  assert.deepEqual(h.journeyDrives.slice(drivesBefore), [["newsletter-signup"]]);

  // Lineage + promotion: the edit snapshot's parent is the prior green, pointer moved.
  const pointer = await h.snapshotStore.pointer("o", "p1", "green");
  assert.equal(pointer, edit.snapshotId);
  const snap = await h.snapshotStore.getSnapshot(edit.snapshotId);
  assert.equal(snap.reason, "working:edit");
  assert.equal(snap.parent_snapshot, edit.parentSnapshotId);
  const tree = await h.snapshotStore.materialize("o", pointer);
  assert.match(tree["src/screens/scaffold/NewsletterScreen.jsx"], /welcome aboard/);
  assert.equal(edit.providerCalls, undefined, "no asset resolution ran at all");
  assert.equal(h.knowledgeFacts.length, 1);
  assert.equal(h.knowledgeFacts[0].value.text, "reword the newsletter confirmation");
  assert.equal(h.knowledgeFacts[0].value.verifiedSnapshot, edit.snapshotId);
});

test("WP10 — a failed edit promotes NOTHING: the prior green keeps serving", async () => {
  const h = editHarness();
  const build = await h.orchestrator.runBuild({ owner: "o", projectId: "p1", request: "booking site" });
  const before = await h.snapshotStore.pointer("o", "p1", "green");

  // An edit that vandalises the ESSENTIAL journey's outcome. The browser — not a lexical
  // pre-compile proxy — is what fails it, which is the whole point of the correction: the
  // edit RUNS, its behaviour is verified, and only then is it refused promotion.
  h.failJourneys(["book-a-visit"]);
  h.setEditPatches([{
    file: "src/screens/scaffold/BookingScreen.jsx",
    ops: [{ op: "replace_symbol", symbol: "BookingScreen",
      content: "export default function BookingScreen() {\n  return <main><h1>Placeholder</h1></main>;\n}" }],
  }]);
  const edit = await h.orchestrator.runEdit({ owner: "o", projectId: "p1", request: "break it", contract: CONTRACT });
  assert.equal(edit.state, "blocked");
  assert.equal(await h.snapshotStore.pointer("o", "p1", "green"), before, "pointer untouched");
  const tree = await h.snapshotStore.materialize("o", before);
  assert.match(tree["src/screens/scaffold/BookingScreen.jsx"], /Booking confirmed/, "the served tree still works");
  assert.equal(build.state, "green");
  assert.equal(h.knowledgeFacts.length, 0, "a failed edit must not become project knowledge");
});

test("a retained headroom edit skips an empty UI batch once and still verifies", async () => {
  const h = editHarness();
  const build = await h.orchestrator.runBuild({ owner: "o", projectId: "beam", request: "booking site" });
  assert.equal(build.state, "green");
  const button = "src/components/ui/button.jsx";
  const checkbox = "src/components/ui/checkbox.jsx";
  const screen = "src/screens/scaffold/NewsletterScreen.jsx";
  const calls = [];
  const buildStore = memoryBuildStore();
  const orchestrator = createOrchestrator({
    contractFn: async () => CONTRACT,
    patchesFn: async ({ step, headroomScope }) => {
      if (step !== "edit") return {
        core: () => CORE_PATCH,
        "increment:newsletter-signup": () => NEWSLETTER_PATCH,
        "increment:browse-info": () => BROWSE_PATCH,
      }[step]?.() || [];
      calls.push(headroomScope?.allowedFiles || []);
      const allowed = headroomScope?.allowedFiles || [];
      if (allowed.some((file) => file === button || file === checkbox)) return [];
      const patches = EDIT_PATCH.map((patch) => ({ ...patch, ops: patch.ops.map((op) => ({ ...op })) }));
      Object.defineProperty(patches, "dispatchScope", { value: {
        kind: "headroom_continuation", logicalStep: "edit", batchWidth: 2,
        files: [screen], allowedFiles: [screen],
        remainingFiles: [button, checkbox],
      } });
      return patches;
    },
    assetService: h.assetService, snapshotStore: h.snapshotStore, buildStore,
    verificationCache: memoryVerificationCache(),
    journeysFn: async ({ journeys }) => ({ journeys: journeys.map((journey) => ({
      id: journey.id, title: journey.title, priority: journey.priority, status: "pass",
    })) }),
    baseTree: () => clone(fromScaffold(REACT_VITE)),
    baseline: REACT_VITE,
  });
  const edit = await orchestrator.runEdit({
    owner: "o", projectId: "beam", request: "Add (cm) to the units", contract: CONTRACT,
  });
  assert.equal(edit.state, "green", edit.error || edit.state);
  const uiCalls = calls.filter((files) => files.includes(button) || files.includes(checkbox));
  assert.equal(uiCalls.length, 1, `the UI batch is one dispatch, not three retries: ${JSON.stringify(calls)}`);
  assert.equal(calls.length, 2);
  const row = await buildStore.get(edit.buildId);
  assert.ok(row.states.includes("verify_edit"), row.states.join(","));
  const tree = await h.snapshotStore.materialize("o", edit.snapshotId);
  assert.match(tree[screen], /welcome aboard/);

  let emptyCalls = 0;
  const emptyStore = memoryBuildStore();
  const emptyEdit = createOrchestrator({
    contractFn: async () => CONTRACT,
    patchesFn: async ({ step }) => {
      if (step === "edit") { emptyCalls += 1; return []; }
      return [];
    },
    assetService: h.assetService, snapshotStore: h.snapshotStore, buildStore: emptyStore,
    verificationCache: memoryVerificationCache(),
    journeysFn: async ({ journeys }) => ({ journeys: journeys.map((journey) => ({
      id: journey.id, status: "pass", title: journey.title, priority: journey.priority,
    })) }),
    baseTree: () => clone(fromScaffold(REACT_VITE)),
    baseline: REACT_VITE,
  });
  const blocked = await emptyEdit.runEdit({
    owner: "o", projectId: "beam", request: "Add (cm) to the units", contract: CONTRACT,
  });
  assert.equal(blocked.state, "blocked");
  assert.equal(blocked.failureClassification, "no_substantive_generation");
  assert.match(blocked.error, /no substantive generation/);
  const blockedRow = await emptyStore.get(blocked.buildId);
  assert.equal(blockedRow.states.includes("verify_edit"), false, blockedRow.states.join(","));
  assert.ok(emptyCalls >= 1 && emptyCalls <= 3);
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
  assert.match(prompt, /NewsletterPanel\.jsx — will be modified by this step/, "the targeted file rides along in full via retrieval");
  assert.match(prompt, /smallest correct patch wins/);
});

test("an identical headroom rejection the model never saw does not consume a generation attempt", async () => {
  const h = editHarness();
  const build = await h.orchestrator.runBuild({ owner: "o", projectId: "unbriefed", request: "booking site" });
  assert.equal(build.state, "green", build.error || build.state);
  const screen = "src/screens/scaffold/NewsletterScreen.jsx";
  const calls = [];
  const badSymbol = "const this entire source line is not the declaration name";
  const orchestrator = createOrchestrator({
    maxCoreAttempts: 2,
    contractFn: async () => CONTRACT,
    patchesFn: async ({ step }) => {
      if (step !== "edit") return [];
      calls.push(step);
      const patches = calls.length < 3 ? [{
        file: screen,
        ops: [{ op: "insert_after_symbol", symbol: badSymbol, content: "const extra = 1;\n" }],
      }] : EDIT_PATCH.map((patch) => ({ ...patch, ops: patch.ops.map((op) => ({ ...op })) }));
      if (calls.length < 3) {
        Object.defineProperty(patches, "dispatchScope", { value: {
          kind: "headroom_continuation", logicalStep: "edit", batchWidth: 1,
          files: [screen], allowedFiles: [screen], remainingFiles: [],
        } });
        Object.defineProperty(patches, "briefedRejections", { value: [], enumerable: false });
      }
      return patches;
    },
    assetService: h.assetService, snapshotStore: h.snapshotStore, buildStore: memoryBuildStore(),
    verificationCache: memoryVerificationCache(),
    journeysFn: async ({ journeys }) => ({ journeys: journeys.map((journey) => ({
      id: journey.id, title: journey.title, priority: journey.priority, status: "pass",
    })) }),
    baseTree: () => clone(fromScaffold(REACT_VITE)),
    baseline: REACT_VITE,
  });
  const edit = await orchestrator.runEdit({
    owner: "o", projectId: "unbriefed", request: "Add a line", contract: CONTRACT,
  });
  assert.equal(calls.length, 3, `one counted failure, one free identical retry, then success; got ${calls.length}. ${edit.error || ""}`);
  assert.equal(edit.state, "green", edit.error || edit.state);
});
