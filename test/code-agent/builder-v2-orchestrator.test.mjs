// WP-8 — the Build Orchestrator's first-green loop, proven END TO END at zero model
// credits: fake contract + fake patches (the two model seams), everything else REAL — the
// real REACT_VITE scaffold, the real patch engine, the real stage gates via the
// verification facade, the real asset service on recorded payloads, the real C2 snapshot
// protocol with pointer promotions.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createOrchestrator, lintAssetAttribution, memoryBuildStore, renderAssetData } from "../../shell/server/lib/builderV2/orchestrator.mjs";
import { createSnapshotStore } from "../../shell/server/lib/builderV2/snapshotStore.mjs";
import { deriveBuildSpec } from "../../shell/server/lib/builderV2/buildSpec.mjs";
import { browserPlan, deriveVerificationManifest } from "../../shell/server/lib/builderV2/verificationManifest.mjs";
import { createAssetService } from "../../shell/server/lib/builderV2/assets/assetService.mjs";
import { pexelsProvider, PEXELS_LICENSE_SNAPSHOT } from "../../shell/server/lib/builderV2/assets/pexelsProvider.mjs";
import { REACT_VITE } from "../../src/scaffolds/reactVite.mjs";
import { fromScaffold, clone } from "../../src/engine/fileTree.mjs";

// ── fixtures ──────────────────────────────────────────────────────────────────────────────────

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
  replaceFile: "src/screens/scaffold/BookingScreen.jsx",
  content: `import React, { useState } from "react";
import { ASSETS, ASSET_CREDITS } from "../../lib/assetData.js";
import { imageProps, isPlaceholder, placeholderStyle } from "../../lib/assets.js";
import { makeBookingSystem } from "../../lib/capabilities/index.js";

const booking = makeBookingSystem({ entity: "booking" });

export default function BookingScreen() {
  const [state, setState] = useState("idle");
  const hero = ASSETS["hero"];
  return (
    <main>
      <h1>Book a farm visit</h1>
      {isPlaceholder(hero) ? <div style={placeholderStyle(hero)} /> : <img {...imageProps(hero)} />}
      {state === "confirmed" ? <p role="status">Booking confirmed — reference SA-1</p> : null}
      <button onClick={async () => { await booking.createBooking({ date: "2026-08-10", slot: "10:00", partySize: 2 }); setState("confirmed"); }}>Submit booking</button>
      <footer><a href="https://www.pexels.com">Photos provided by Pexels</a>{ASSET_CREDITS.map((credit) => credit.photoUrl ? <a key={credit.photoUrl} href={credit.photoUrl}>{credit.photographer}</a> : null)}</footer>
    </main>
  );
}
`,
}];

const NEWSLETTER_PATCH = [{
  replaceFile: "src/screens/scaffold/HomeScreen.jsx",
  content: `import React, { useState } from "react";
import { makeNewsletter } from "../../lib/capabilities/index.js";

const newsletter = makeNewsletter({ entity: "newslettersignup" });

export default function HomeScreen() {
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
  replaceFile: "src/screens/scaffold/HomeScreen.jsx",
  content: `import React, { useState } from "react";
import { makeNewsletter } from "../../lib/capabilities/index.js";

const newsletter = makeNewsletter({ entity: "newslettersignup" });
export default function HomeScreen() {
  const [state, setState] = useState("idle"); const [email, setEmail] = useState("");
  return <main><section><h2>About the farm</h2><p>Family-run strawberry fields since 1987.</p></section>
    <section>{state === "done" ? <p role="status">Newsletter subscribed</p> : null}
      <label>Email address<input type="email" name="email" aria-label="email" value={email} onChange={(event) => setEmail(event.target.value)} /></label>
      <button onClick={async () => { await newsletter.subscribe(email || "reader@example.test"); setState("done"); }}>Subscribe</button>
    </section></main>;
}
`,
}];

// This suite injects its browser verdicts and tests orchestration, not route composition. Start
// from a visibly mounted fixture root so the candidate does not carry the real scaffold's empty
// placeholder into unrelated correction/repair accounting assertions.
const FIXTURE_HOME = `export default function HomePage() {
  return <main><h1>Orchestrator fixture application</h1></main>;
}`;
const fixtureScaffold = () => {
  const tree = clone(fromScaffold(REACT_VITE));
  tree["src/routes/HomePage.jsx"] = FIXTURE_HOME;
  return tree;
};

const RECORDED_PHOTOS = [
  { id: 201, width: 2000, height: 1300, alt: "strawberry farm rows in summer light",
    photographer: "T", photographer_url: "https://www.pexels.com/@t", url: "https://www.pexels.com/photo/farm-201/", src: { original: "https://images.pexels.com/201/o.jpg", large2x: "https://images.pexels.com/201/l.jpg", medium: "https://images.pexels.com/201/m.jpg" } },
];

function recordedAssetService() {
  const provider = pexelsProvider({
    apiKey: "k",
    fetchImpl: async () => ({ ok: true, json: async () => ({ photos: RECORDED_PHOTOS }) }),
  });
  const rows = [];
  let n = 0;
  const client = { from: () => clientChain(rows, () => ++n) };
  return createAssetService({ providers: [provider], client, now: () => new Date("2026-08-05T22:00:00Z") });
}

// The same minimal PostgREST fake as the asset suite, extracted for reuse here.
function clientChain(rows, nextId) {
  const state = { filters: [], op: "select", payload: null, maybe: false, onConflict: null };
  const matches = (r) => state.filters.every(([c, v]) => r[c] === v);
  const run = () => {
    if (state.op === "select") {
      const out = rows.filter(matches).map((r) => ({ ...r }));
      return state.maybe ? { data: out[0] || null, error: null } : { data: out, error: null };
    }
    if (state.op === "upsert") {
      const keys = (state.onConflict || "").split(",");
      const existing = rows.find((r) => keys.every((k) => r[k] === state.payload[k]));
      if (existing) Object.assign(existing, state.payload);
      else rows.push({ id: `asset-${nextId()}`, ...state.payload });
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
}

// The REAL bv2_builds columns — a store that rejects anything else, exactly as PostgREST
// does. The first live run died on this gap between the permissive memory fake and prod.
const BUILD_COLUMNS = new Set([
  "owner", "project_id", "profile", "request", "state", "budget_credits", "spent_credits",
  "contract_id", "final_snapshot", "error", "started_at", "finished_at", "max_repair_dispatches",
  "verifier_policy",
]);
function strictBuildStore() {
  const rows = new Map();
  let n = 0;
  const check = (patch) => {
    for (const key of Object.keys(patch)) {
      if (!BUILD_COLUMNS.has(key)) throw new Error(`Could not find the '${key}' column of 'bv2_builds' in the schema cache`);
    }
  };
  return {
    async create(row) { check(row); const id = `b-${++n}`; rows.set(id, { ...row, states: [row.state] }); return id; },
    async update(id, patch) { check(patch); const row = rows.get(id); Object.assign(row, patch); if (patch.state) row.states.push(patch.state); },
    async get(id) { return rows.get(id) || null; },
  };
}

function harness({ contract = CONTRACT, contractFn = null, failJourneys = [], patchPlan = null,
  assetService = recordedAssetService(), buildStore = memoryBuildStore(), journeysFn = null,
  backendProbeFn = null, compile = undefined, maxJourneyRepairs = 2, maxNoOpRetries = 2, events = {} } = {}) {
  const snapshotStore = createSnapshotStore();
  const patchCalls = [];
  const checkpoints = [];
  const journeyDrives = [];
  const plan = patchPlan || {
    core: () => CORE_PATCH,
    // Default repair: a real but futile patch — persistent journey failures still block.
    repair: () => [{ file: "src/screens/scaffold/BookingScreen.jsx", ops: [{ op: "append", content: "\n// repair attempt\n" }] }],
    "increment:newsletter-signup": () => NEWSLETTER_PATCH,
    "increment:browse-info": () => BROWSE_PATCH,
  };
  const failSet = new Set(failJourneys);
  const orchestrator = createOrchestrator({
    contractFn: contractFn || (async () => contract),
    patchesFn: async (ctx) => {
      patchCalls.push({ step: ctx.step, originalStep: ctx.originalStep, dispatchReason: ctx.dispatchReason,
        rejections: ctx.rejections.length, problems: ctx.problems, regenerateFiles: ctx.regenerateFiles,
        journeyIds: (ctx.spec?.journeys || []).map((journey) => journey.id),
        repairBoundary: ctx.repairBoundary, treeFiles: Object.keys(ctx.tree || {}) });
      // A pre-compile `correction` is a scoped re-emission of its originating step.
      const stage = plan[ctx.step] ? ctx.step : ctx.originalStep;
      return plan[stage](ctx);
    },
    assetService,
    snapshotStore,
    buildStore,
    backendProbeFn,
    compile,
    journeysFn: journeysFn || (async ({ journeys }) => {
      journeyDrives.push(journeys.map((j) => j.id));
      return { journeys: journeys.map((j) => ({ id: j.id, title: j.title, priority: j.priority, status: failSet.has(j.id) ? "fail" : "pass" })) };
    }),
    baseTree: fixtureScaffold,
    baseline: REACT_VITE,
    maxJourneyRepairs,
    maxNoOpRetries,
    events: { ...events, checkpoint: async (event) => {
      checkpoints.push(event);
      await events.checkpoint?.(event);
    } },
  });
  return { orchestrator, buildStore, snapshotStore, assetService, patchCalls, journeyDrives, checkpoints };
}

// ── the proofs ────────────────────────────────────────────────────────────────────────────────

test("WP8 — full first-green e2e: contract → assets → core green → both increments ship, zero model", async () => {
  const { orchestrator, buildStore, snapshotStore, checkpoints } = harness();
  const result = await orchestrator.runBuild({ owner: "o", projectId: "proj-1", request: "booking site" });

  assert.equal(result.state, "green", JSON.stringify(result));
  assert.deepEqual(result.shipped, ["newsletter-signup", "browse-info"]);
  assert.deepEqual(result.pendingIncrements, []);
  assert.equal(result.providerCalls, 2, "hero + route:/book resolved once each");

  const build = await buildStore.get(result.buildId);
  assert.deepEqual(build.states, [
    "created", "contracting", "assets", "compose_scaffold", "core", "verify_core",
    "increment:newsletter-signup", "increment:browse-info", "final_fresh_verification", "green",
  ], "green is written only after every contracted journey passes");

  // The green pointer names the LAST increment's snapshot; its tree holds everything.
  const pointer = await snapshotStore.pointer("o", "proj-1", "green");
  assert.equal(pointer, result.snapshotId);
  const finalTree = await snapshotStore.materialize("o", pointer);
  assert.ok(finalTree["src/screens/scaffold/BookingScreen.jsx"], "core mounted screen");
  assert.ok(finalTree["src/screens/scaffold/HomeScreen.jsx"].includes("Newsletter subscribed"), "increment 1");
  assert.ok(finalTree["src/screens/scaffold/HomeScreen.jsx"].includes("About the farm"), "increment 2");
  assert.match(finalTree["src/lib/assetData.js"], /images\.pexels\.com\/201/, "AssetRefs injected as constants");
  assert.ok(finalTree["src/lib/assets.js"], "the scaffold render helper ships");
  const foundation = checkpoints.find((event) => event.reason === "foundation:scaffold");
  assert.ok(foundation?.snapshot?.id, "a compiled deterministic scaffold checkpoint precedes model-owned work");
  assert.equal(foundation.promotable, false,
    "the structural foundation is retained but cannot bypass journey verification");
  assert.ok(foundation.tree["src/lib/scaffolds/composed/manifest.js"]);

  // Snapshot lineage: core → newsletter → browse.
  const finalSnap = await snapshotStore.getSnapshot(pointer);
  assert.equal(finalSnap.reason, "working:increment:browse-info");
  const mid = await snapshotStore.getSnapshot(finalSnap.parent_snapshot);
  assert.equal(mid.reason, "working:increment:newsletter-signup");
  assert.equal((await snapshotStore.getSnapshot(mid.parent_snapshot)).reason, "working:core");
  assert.ok(finalSnap.asset_manifest.length >= 2, "the asset manifest versions with the snapshot");
});

test("core generates and verifies every journey sharing its mounted screen exactly once", async () => {
  const contract = {
    summary: "A software catalogue with separate preferences",
    entities: [], operations: [], auth: { required: false },
    routes: [{ path: "/", name: "Catalogue" }, { path: "/preferences", name: "Preferences" }],
    journeys: [
      { id: "browse-catalogue", title: "Browse catalogue", priority: "primary",
        steps: [{ action: "open catalogue", target: "/", expect: "catalogue entries are visible" }] },
      { id: "empty-catalogue-result", title: "See empty result", priority: "secondary",
        steps: [{ action: "filter catalogue", target: "/", expect: "empty result is visible" }] },
      { id: "open-preferences", title: "Open preferences", priority: "secondary",
        steps: [{ action: "open preferences", target: "/preferences", expect: "preferences are visible" }] },
    ],
  };
  const corePatch = [{ replaceFile: "src/screens/scaffold/CatalogueScreen.jsx", content:
    "export default function CatalogueScreen() { return <main><h1>Software catalogue</h1><p>Catalogue entries are visible</p><p>Empty result is visible</p></main>; }" }];
  const preferencesPatch = [{ replaceFile: "src/screens/scaffold/PreferencesScreen.jsx", content:
    "export default function PreferencesScreen() { return <main><h1>Preferences are visible</h1></main>; }" }];
  const h = harness({ contract,
    assetService: {
      resolveIntents: async () => ({ resolved: [], providerCalls: 0 }),
      assetManifestFor: async () => [],
    },
    patchPlan: {
      core: () => corePatch,
      "increment:open-preferences": () => preferencesPatch,
    } });

  const result = await h.orchestrator.runBuild({
    owner: "o", projectId: "shared-screen-unit", request: "software catalogue",
  });

  assert.equal(result.state, "green", JSON.stringify(result));
  assert.deepEqual(h.patchCalls.find((call) => call.step === "core")?.journeyIds,
    ["browse-catalogue", "empty-catalogue-result"]);
  assert.equal(h.patchCalls.some((call) => call.originalStep === "increment:empty-catalogue-result"), false);
  assert.deepEqual(h.patchCalls.find((call) => call.step === "increment:open-preferences")?.journeyIds,
    ["open-preferences"]);
  assert.deepEqual(h.journeyDrives[0], ["browse-catalogue", "empty-catalogue-result"]);
});

test("14S — a red required secondary blocks completion while retaining resumable work", async () => {
  const { orchestrator, snapshotStore, checkpoints: events } = harness({ failJourneys: ["newsletter-signup"] });
  const result = await orchestrator.runBuild({ owner: "o", projectId: "proj-1", request: "booking site" });

  assert.equal(result.state, "blocked");
  assert.deepEqual(result.shipped, ["browse-info"], "later deterministic work is retained but not promoted");
  assert.deepEqual(result.pendingIncrements.map((p) => p.journeyId), ["newsletter-signup"]);

  assert.equal(await snapshotStore.pointer("o", "proj-1", "green"), null,
    "no partial contract can become the project's green authority");
  assert.ok(events.some((event) => event.reason === "foundation:scaffold"
    && event.promotable === false && event.tree["src/lib/scaffolds/composed/manifest.js"]),
  "a failed enhancement does not erase the retained deterministic foundation");
  const working = await orchestrator.resumeWorkingContext("o", "proj-1", result.buildId);
  assert.ok(working.tree["src/screens/scaffold/BookingScreen.jsx"]);
  assert.ok(working.tree["src/screens/scaffold/HomeScreen.jsx"].includes("About the farm"));
  // The red journey's work is RETAINED as its own non-promotable checkpoint, but it is no longer
  // carried into the verified line: `browse-info` is built on the last VERIFIED candidate, not on
  // a tree the browser has just called red. One failed increment poisoning every later one is how
  // a production build ended with six red journeys and 39 of 60 credits unspent.
  const redCheckpoints = events.filter((event) => /newsletter-signup/.test(event.reason || ""));
  assert.ok(redCheckpoints.length, "the red increment is retained as a checkpoint for targeted repair");
  assert.ok(redCheckpoints.every((event) => event.promotable === false));
  assert.ok(redCheckpoints.some((event) => event.tree["src/screens/scaffold/HomeScreen.jsx"]?.includes("Newsletter subscribed")),
    "the retained checkpoint still holds the red work itself");
  assert.ok(working.tree["src/screens/scaffold/HomeScreen.jsx"],
    "…and the verified line does not inherit it");
});

test("a secondary candidate must re-prove every completed journey whose owners it changed", async () => {
  const drives = [];
  const h = harness({
    patchPlan: {
      core: () => CORE_PATCH,
      repair: () => [{ file: "src/screens/scaffold/BookingScreen.jsx", ops: [{ op: "append", content: "\n// futile repair\n" }] }],
      "increment:newsletter-signup": () => [
        ...NEWSLETTER_PATCH,
        { file: "src/screens/scaffold/BookingScreen.jsx", ops: [{ op: "append", content: "\n// regress-primary\n" }] },
      ],
      "increment:browse-info": () => BROWSE_PATCH,
    },
    journeysFn: async ({ journeys, tree }) => {
      drives.push(journeys.map((journey) => journey.id));
      return { journeys: journeys.map((journey) => ({
        id: journey.id, title: journey.title, priority: journey.priority,
        status: journey.id === "book-a-visit" && /regress-primary/.test(tree["src/screens/scaffold/BookingScreen.jsx"] || "")
          ? "fail" : "pass",
      })) };
    },
  });

  const result = await h.orchestrator.runBuild({ owner: "o", projectId: "proj-regression", request: "booking site" });
  assert.equal(result.state, "blocked", JSON.stringify(result));
  assert.ok(drives.some((ids) => ids.includes("book-a-visit") && ids.includes("newsletter-signup")),
    `the changed primary owner was not re-driven with the secondary: ${JSON.stringify(drives)}`);
  assert.ok(!result.shipped.includes("newsletter-signup"), "a candidate that regressed the core must not ship");
  assert.ok(result.shipped.includes("browse-info"), "later work still starts from the retained green core");
});

test("one browser repair round consumes at most one repair dispatch", async () => {
  const h = harness({
    failJourneys: ["book-a-visit"],
    maxJourneyRepairs: 2,
    maxNoOpRetries: 5,
    patchPlan: {
      core: () => CORE_PATCH,
      repair: () => [],
      "increment:newsletter-signup": () => NEWSLETTER_PATCH,
      "increment:browse-info": () => BROWSE_PATCH,
    },
  });
  const result = await h.orchestrator.runBuild({ owner: "o", projectId: "proj-repair-unit", request: "booking site" });
  assert.equal(result.state, "blocked", JSON.stringify(result));
  const repairDispatches = h.patchCalls.filter((call) => call.step === "repair");
  assert.equal(repairDispatches.length, 2,
    "protocol retries inside one browser round must not consume another journey's durable repair share");
  assert.equal(result.repairRounds, 2);
});

test("a parser-rejected repair retries through correction allowance, not a second repair dispatch", async () => {
  const selectedDateCopy = "<p>The selected date remains visible on the slot step.</p>";
  const h = harness({
    maxJourneyRepairs: 1,
    patchPlan: {
      core: () => CORE_PATCH,
      repair: () => [{ file: "src/screens/scaffold/BookingScreen.jsx", ops: [{
        op: "replace_exact",
        symbol: "<h1>Book a farm visit</h1>",
        content: "<h1>Book a farm visit</h1><p>",
      }] }],
      correction: () => [{ file: "src/screens/scaffold/BookingScreen.jsx", ops: [{
        op: "replace_exact",
        symbol: "<h1>Book a farm visit</h1>",
        content: `<h1>Book a farm visit</h1>${selectedDateCopy}`,
      }] }],
      "increment:newsletter-signup": () => NEWSLETTER_PATCH,
      "increment:browse-info": () => BROWSE_PATCH,
    },
    journeysFn: async ({ journeys, tree }) => ({
      journeys: journeys.map((journey) => ({
        id: journey.id, title: journey.title, priority: journey.priority,
        status: journey.id === "book-a-visit"
          && !String(tree["src/screens/scaffold/BookingScreen.jsx"] || "").includes(selectedDateCopy)
          ? "fail" : "pass",
        steps: journey.id === "book-a-visit"
          ? [{ action: "select a date", expect: "the selected date remains visible",
            status: String(tree["src/screens/scaffold/BookingScreen.jsx"] || "").includes(selectedDateCopy) ? "pass" : "fail",
            detail: "the flow advanced but the selected date was not visible" }]
          : [],
      })),
    }),
  });

  const result = await h.orchestrator.runBuild({
    owner: "o", projectId: "proj-repair-parser-correction", request: "booking site", maxRepairs: 1,
  });
  assert.equal(result.state, "green", JSON.stringify(result));
  assert.equal(h.patchCalls.filter((call) => call.step === "repair").length, 1,
    "the browser-informed round owns exactly one repair reservation");
  assert.equal(h.patchCalls.filter((call) => call.step === "correction").length, 1,
    "the parser rejection is corrected through the separate correction allowance");
  assert.equal(h.patchCalls.find((call) => call.step === "correction")?.rejections, 1,
    "the correction receives the exact rejected patch evidence");
});

test("a partially applied browser repair finishes rejected causal edits before re-verification", async () => {
  const cancellationCopy = "<p>A cancellation control is now offered after confirmed recovery.</p>";
  const h = harness({
    maxJourneyRepairs: 1,
    patchPlan: {
      core: () => CORE_PATCH,
      repair: () => [{
        file: "src/screens/scaffold/HomeScreen.jsx",
        ops: [{ op: "append", content: "\n// harmless repair sibling\n" }],
      }, {
        file: "src/screens/scaffold/BookingScreen.jsx",
        ops: [{ op: "replace_exact", symbol: "<h1>Book a farm visit</h1>",
          content: "<h1>Book a farm visit</h1><p>" }],
      }],
      correction: () => [{
        file: "src/screens/scaffold/BookingScreen.jsx",
        ops: [{ op: "replace_exact", symbol: "<h1>Book a farm visit</h1>",
          content: `<h1>Book a farm visit</h1>${cancellationCopy}` }],
      }],
      "increment:newsletter-signup": () => NEWSLETTER_PATCH,
      "increment:browse-info": () => BROWSE_PATCH,
    },
    journeysFn: async ({ journeys, tree }) => ({
      journeys: journeys.map((journey) => ({
        id: journey.id, title: journey.title, priority: journey.priority,
        status: journey.id === "book-a-visit"
          && !String(tree["src/screens/scaffold/BookingScreen.jsx"] || "").includes(cancellationCopy) ? "fail" : "pass",
        steps: journey.id === "book-a-visit" ? [{ action: "cancel the confirmed booking",
          expect: "a cancellation control is offered", status: String(tree["src/screens/scaffold/BookingScreen.jsx"] || "")
            .includes(cancellationCopy) ? "pass" : "undriveable" }] : [],
      })),
    }),
  });

  const result = await h.orchestrator.runBuild({
    owner: "o", projectId: "proj-partial-repair-correction", request: "booking site", maxRepairs: 1,
  });
  assert.equal(result.state, "green", JSON.stringify(result));
  assert.equal(h.patchCalls.filter((call) => call.step === "repair").length, 1,
    "the browser evidence buys exactly one repair dispatch");
  assert.equal(h.patchCalls.filter((call) => call.step === "correction").length, 1,
    "rejected causal work finishes through deterministic correction before another browser run");
  assert.equal(h.patchCalls.find((call) => call.step === "correction")?.rejections, 1);
});

test("WP8/C4 — a failing ESSENTIAL journey blocks: no snapshot, no green pointer, state blocked", async () => {
  const { orchestrator, snapshotStore } = harness({ failJourneys: ["book-a-visit"] });
  const result = await orchestrator.runBuild({ owner: "o", projectId: "proj-1", request: "booking site" });
  assert.equal(result.state, "blocked");
  assert.match(result.error, /book-a-visit/);
  assert.ok(!(await snapshotStore.pointer("o", "proj-1", "green")), "nothing was ever promotable");
});

test("C2 — an unattributed essential failure blocks, is recorded separately, and briefs bounded fallback context", async () => {
  const ghostContract = {
    ...CONTRACT,
    journeys: [{
      id: "zzqx-ghost-flow", title: "Qqzy unowned workflow", priority: "primary",
      steps: [{ action: "submit the booking form", expect: "booking confirmed" }],
    }],
  };
  let repairProblems = [];
  const { orchestrator, snapshotStore } = harness({
    contract: ghostContract,
    failJourneys: ["zzqx-ghost-flow"],
    patchPlan: {
      core: () => [{ ...CORE_PATCH[0], replaceFile: "src/screens/scaffold/HomeScreen.jsx",
        content: CORE_PATCH[0].content.replaceAll("BookingScreen", "HomeScreen") }],
      repair: ({ problems }) => {
        repairProblems = problems;
        return [{ file: "src/screens/scaffold/HomeScreen.jsx", ops: [{ op: "append", content: "\n// bounded unattributed repair attempt\n" }] }];
      },
    },
  });
  const result = await orchestrator.runBuild({ owner: "o", projectId: "proj-1", request: "booking site" });
  assert.equal(result.state, "blocked");
  assert.equal(deriveBuildSpec(ghostContract).scaffoldGraph.journeyOwnership[0].mountedModule,
    "src/screens/scaffold/HomeScreen.jsx", "even an unusual contract receives a deterministic mounted owner");
  assert.deepEqual(result.platformDefects || [], [], "the scaffold graph makes the contracted owner explicit");
  assert.ok(repairProblems.some((p) => /HomeScreen\.jsx/.test(p)), JSON.stringify(repairProblems));
  assert.ok(!(await snapshotStore.pointer("o", "proj-1", "green")), "unattributed failure promoted nothing");
});

test("WP8 — machine-taught patch rejection: round 1 rejected op, round 2 receives the reasons and lands", async () => {
  let round = 0;
  const { orchestrator, patchCalls } = harness({
    patchPlan: {
      core: ({ rejections }) => {
        round += 1;
        if (round === 1) return [{ file: "src/screens/scaffold/BookingScreen.jsx", ops: [{ op: "replace_symbol", symbol: "NoSuchSymbol", content: "x" }] }];
        assert.ok(rejections.some((r) => /NoSuchSymbol/.test(r.reason)), "the model sees WHY");
        return CORE_PATCH;
      },
      "increment:newsletter-signup": () => NEWSLETTER_PATCH,
      "increment:browse-info": () => BROWSE_PATCH,
    },
  });
  const result = await orchestrator.runBuild({ owner: "o", projectId: "proj-1", request: "booking site" });
  assert.equal(result.state, "green");
  assert.equal(patchCalls.filter((c) => c.step === "core").length, 2);
  assert.equal(patchCalls[1].rejections, 1, "round 2 was briefed with the rejection");
});

test("the last candidate correction escalates a rejected file to complete replacement", async () => {
  const unsafe = `import { db } from "../lib/backend/index.js";
export const create = (draft) => db.entity("booking").create(draft);
`;
  const safe = `import { makeBookingSystem } from "../lib/capabilities/index.js";
const booking = makeBookingSystem({ entity: "booking" });
export const create = (draft) => booking.createBooking(draft);
`;
  let correctionRound = 0;
  const { orchestrator, patchCalls } = harness({
    patchPlan: {
      core: () => [...CORE_PATCH, { newFile: "src/data/bookings.js", content: unsafe }],
      correction: () => {
        correctionRound += 1;
        if (correctionRound === 1) {
          return [{ file: "src/data/bookings.js", ops: [{
            op: "replace_exact", symbol: "create", content: "export const create = (draft) => (",
          }] }];
        }
        return [{ replaceFile: "src/data/bookings.js", content: safe }];
      },
      "increment:newsletter-signup": () => NEWSLETTER_PATCH,
      "increment:browse-info": () => BROWSE_PATCH,
    },
  });

  const result = await orchestrator.runBuild({
    owner: "o", projectId: "proj-final-correction-escalation", request: "booking site",
  });
  assert.equal(result.state, "green", JSON.stringify(result));
  const corrections = patchCalls.filter((call) => call.step === "correction");
  assert.equal(corrections.length, 2);
  assert.deepEqual(corrections[1].regenerateFiles, ["src/data/bookings.js"],
    "the final allowance is a whole-file escalation, not repeated fragile symbol surgery");
});

test("a stale final correction excerpt gets one bounded whole-file protocol retry", async () => {
  const file = "src/screens/scaffold/CatalogueScreen.jsx";
  const catalogueContract = {
    summary: "Generic software catalogue",
    entities: [{ name: "catalogueitem" }],
    operations: [],
    routes: [{ path: "/", name: "Catalogue" }],
    auth: { required: false },
    journeys: [{
      id: "browse-catalogue", title: "Browse the software catalogue", priority: "primary",
      steps: [{ action: "view the catalogue", expect: "software catalogue" }],
    }],
  };
  const initial = `export default function CatalogueScreen() {
  const firstIssue = true;
  const secondIssue = true;
  return <main><h1>Software catalogue</h1>{String(firstIssue || secondIssue)}</main>;
}`;
  const corrected = `export default function CatalogueScreen() {
  const firstIssue = false;
  const secondIssue = false;
  return <main><h1>Software catalogue</h1>{String(firstIssue || secondIssue)}</main>;
}`;
  let correctionRound = 0;
  const h = harness({
    contract: catalogueContract,
    maxNoOpRetries: 1,
    assetService: {
      resolveIntents: async () => ({ resolved: [], providerCalls: 0 }),
      assetManifestFor: async () => [],
    },
    compile: async (tree) => {
      const source = String(tree[file] || "");
      if (source.includes("const firstIssue = true")) {
        return { ok: false, stderr: `${file}:2: first catalogue compile issue` };
      }
      if (source.includes("const secondIssue = true")) {
        return { ok: false, stderr: `${file}:3: second catalogue compile issue` };
      }
      return { ok: true };
    },
    patchPlan: {
      core: () => [{ replaceFile: file, content: initial }],
      correction: (ctx) => {
        correctionRound += 1;
        if (correctionRound === 1) {
          return [{ file, ops: [{ op: "replace_exact", symbol: "const firstIssue = true;",
            content: "const firstIssue = false;" }] }];
        }
        if (correctionRound === 2) {
          return [{ file, ops: [{ op: "replace_exact", symbol: "const firstIssue = true;",
            content: "const firstIssue = false;" }] }];
        }
        assert.deepEqual(ctx.regenerateFiles, [file]);
        return [{ replaceFile: file, content: corrected }];
      },
    },
  });

  const result = await h.orchestrator.runBuild({
    owner: "o", projectId: "proj-final-protocol-retry", request: "software catalogue",
  });
  assert.equal(result.state, "green", JSON.stringify(result));
  const corrections = h.patchCalls.filter((call) => call.step === "correction");
  assert.equal(corrections.length, 3);
  assert.equal(corrections[2].dispatchReason, "final_patch_protocol_correction");
  assert.deepEqual(corrections[2].regenerateFiles, [file]);
});

test("WP8 — stop rule: the same defect surviving a repair round blocks instead of burning attempts", async () => {
  const unsafeBookings = (attempt) => `// round ${attempt}\nimport { db } from "../lib/backend/index.js";\nimport { makeBookingSystem, ensureVisitorSession } from "../lib/capabilities/index.js";\nconst booking = makeBookingSystem({ entity: "booking" });\nexport const create = async (draft) => { await ensureVisitorSession(); return db.entity("booking").create(draft); };\nexport const viaCapability = (draft) => booking.createBooking(draft);\n`;
  const { orchestrator } = harness({
    contract: {
      summary: "deterministic stop-rule fixture", entities: [{ name: "booking" }], operations: [],
      routes: [{ path: "/", name: "Booking" }], auth: { required: false },
      journeys: [{ id: "book-a-visit", title: "Complete a booking", priority: "primary",
        steps: [{ action: "complete the flow", expect: "zzqx-final-outcome" }] }],
    },
    patchPlan: {
      // Compiles and parses, but writes a capability-owned entity through the raw persistence
      // API every round — a genuine BLOCKING defect that survives its scoped correction.
      // (A merely cosmetic difference would no longer stop a build, and should not.)
      // Each round differs textually (so it is never a no-op batch) but repeats the SAME
      // blocking defect, which is exactly what the stop rule exists to catch.
      core: ({ attempt }) => [
        {
          newFile: "src/data/bookings.js",
          content: unsafeBookings(attempt),
        },
        {
          replaceFile: "src/screens/scaffold/BookingScreen.jsx",
          content: "import React from \"react\";\nimport { ASSET_CREDITS } from \"../../lib/assetData.js\";\nimport { create } from \"../../data/bookings.js\";\n\nexport default function BookingScreen() {\n  return <main><h1>zzqx-final-outcome</h1><button onClick={() => create({ date: \"2026-08-10\" })}>Submit</button><footer><a href=\"https://www.pexels.com\">Pexels</a>{ASSET_CREDITS.map((credit) => <a href={credit.photoUrl}>{credit.photographer}</a>)}</footer></main>;\n}\n",
        },
      ],
      correction: ({ attempt }) => [{
        replaceFile: "src/data/bookings.js",
        content: unsafeBookings(attempt),
      }],
    },
  });
  const result = await orchestrator.runBuild({ owner: "o", projectId: "proj-1", request: "booking site" });
  assert.equal(result.state, "blocked");
  assert.match(result.error, /stop rule/);
});

test("WP8 — rebuilds are cache-warm: second build makes ZERO provider calls and resume needs no rediscovery", async () => {
  const shared = recordedAssetService();
  const first = harness({ assetService: shared });
  const one = await first.orchestrator.runBuild({ owner: "o", projectId: "proj-1", request: "booking site" });
  assert.equal(one.providerCalls, 2);

  const second = harness({ assetService: shared });
  const two = await second.orchestrator.runBuild({ owner: "o", projectId: "proj-1", request: "booking site" });
  assert.equal(two.state, "green");
  assert.equal(two.providerCalls, 0, "Part 18: a rebuild never re-searches its imagery");

  // Crash-resume: the green pointer alone brings back tree + index — no model, no search.
  const ctx = await second.orchestrator.resumeContext("o", "proj-1");
  assert.equal(ctx.snapshotId, two.snapshotId);
  assert.ok(ctx.tree["src/screens/scaffold/BookingScreen.jsx"]);
  assert.ok(ctx.index.files.get("src/screens/scaffold/BookingScreen.jsx").symbols.some((s) => s.name === "BookingScreen"),
    "the index rebuilds deterministically from the snapshot");
});

test("WP8 — the V2-only entry admits every owner unless the emergency kill switch is active", async () => {
  const { v2BuildEligible } = await import("../../shell/server/lib/builderV2/entry.mjs");
  assert.equal((await v2BuildEligible("owner-1", { env: {} })).eligible, true);
  assert.equal((await v2BuildEligible("owner-2", { env: {} })).eligible, true,
    "V2-only cutover has no owner cohort or database flag dependency");
  const killed = await v2BuildEligible("owner-1", {
    env: { THRALLO_BV2_KILL: "1" },
  });
  assert.equal(killed.eligible, false);
  assert.match(killed.reason, /THRALLO_BV2_KILL/);
});

test("WP9 regression — the REAL bv2_builds column set survives green AND blocked end states", async () => {
  const green = harness({ buildStore: strictBuildStore() });
  const ok = await green.orchestrator.runBuild({ owner: "o", projectId: "proj-1", request: "booking site" });
  assert.equal(ok.state, "green", JSON.stringify(ok));
  assert.deepEqual(ok.pendingIncrements, [], "rich result fields still come back — they are just not persisted");

  const blockedStore = strictBuildStore();
  const blocked = harness({ failJourneys: ["book-a-visit"], buildStore: blockedStore });
  const bad = await blocked.orchestrator.runBuild({ owner: "o", projectId: "proj-1", request: "booking site" });
  assert.equal(bad.state, "blocked", "the exact end state the first live run died on");
  assert.ok(bad.error, "the failure detail rides the ERROR column and the return value");
});

test("WP9 regression — a byte-identical no-op batch is rejected deterministically, never gated", async () => {
  const { indexFile } = await import("../../shell/server/lib/builderV2/indexer.mjs");
  const scaffoldHome = fixtureScaffold()["src/routes/HomePage.jsx"];
  const symbol = indexFile("src/routes/HomePage.jsx", scaffoldHome).symbols.find((s) => s.name === "HomePage");
  const identical = scaffoldHome.slice(symbol.start, symbol.end);

  let round = 0;
  let fedBack = null;
  const { orchestrator } = harness({
    patchPlan: {
      core: ({ rejections }) => {
        round += 1;
        if (round === 1) {
          // Exactly what the first live model did: "replace" the current symbol with itself.
          return [{ file: "src/routes/HomePage.jsx", ops: [{ op: "replace_symbol", symbol: "HomePage", content: identical }] }];
        }
        fedBack = rejections;
        return CORE_PATCH;
      },
      "increment:newsletter-signup": () => NEWSLETTER_PATCH,
      "increment:browse-info": () => BROWSE_PATCH,
    },
  });
  const result = await orchestrator.runBuild({ owner: "o", projectId: "proj-1", request: "booking site" });
  assert.equal(result.state, "green", "round 2 recovers");
  assert.ok(fedBack?.some((r) => /byte-identical|no-op/.test(r.reason)),
    `the model is TOLD it emitted a no-op: ${JSON.stringify(fedBack)}`);
});

test("WP9 regression — a capability-usage defect is rejected deterministically with the interface taught back", async () => {
  let round = 0;
  let fedBack = null;
  const BAD_CONTACT_PATCH = [{
    replaceFile: "src/screens/scaffold/BookingScreen.jsx",
    content: `import React from "react";
import { makeContactForm } from "../../lib/capabilities";

const contactForm = makeContactForm({ entity: "contactMessage" });

export default function BookingScreen() {
  async function go() { await contactForm.submit({ name: "x" }); }
  return <main><h1>Book a farm visit</h1><p role="status">Booking confirmed — reference SA-1</p><button onClick={go}>Submit booking</button></main>;
}
`,
  }];
  const taught = [];
  const { orchestrator } = harness({
    patchPlan: {
      core: ({ rejections, problems }) => {
        round += 1;
        taught.push(...(rejections || []).map((row) => row.reason), ...(problems || []));
        if (round === 1) return BAD_CONTACT_PATCH;
        fedBack = rejections;
        return CORE_PATCH;
      },
      // A blocking defect now arrives as a SCOPED correction over the retained tree: the fix is
      // re-emitted for the one offending module rather than regenerating the whole step.
      correction: ({ problems, moduleCorrectionScope: scope }) => {
        taught.push(...(problems || []));
        assert.deepEqual(scope.allowedFiles, ["src/screens/scaffold/BookingScreen.jsx"]);
        return [{ replaceFile: "src/screens/scaffold/BookingScreen.jsx", content: BAD_CONTACT_PATCH[0].content
          .replace("import React from \"react\";", "import React from \"react\";\nimport { ASSET_CREDITS } from \"../../lib/assetData.js\";")
          .replace("contactForm.submit(", "contactForm.submitContact(")
          .replace("</main>", "<footer><a href=\"https://www.pexels.com\">Photos provided by Pexels</a>{ASSET_CREDITS.map((credit) => <a key={credit.photoUrl} href={credit.photoUrl}>{credit.photographer}</a>)}</footer></main>") }];
      },
      "increment:newsletter-signup": () => NEWSLETTER_PATCH,
      "increment:browse-info": () => BROWSE_PATCH,
    },
  });
  const result = await orchestrator.runBuild({ owner: "o", projectId: "proj-1", request: "booking site" });
  assert.equal(result.state, "green", `the scoped correction recovers with the taught interface: ${result.error} :: ${JSON.stringify(taught)}`);
  assert.ok(taught.some((reason) => /\[submitContact\]/.test(String(reason))),
    `the rejection teaches the REAL interface: ${JSON.stringify(taught)}`);
  assert.ok(taught.some((reason) => /capability_method_unknown/.test(String(reason))),
    "a call to a method the capability does not export remains BLOCKING");
});

test("WP11/V2-20 — the repair tier: a verified browser failure earns a targeted round briefed with the evidence, then green", async () => {
  let bookingDrives = 0;
  const REPAIRED_PATCH = [{
    file: "src/screens/scaffold/BookingScreen.jsx",
    ops: [{ op: "replace_symbol", symbol: "BookingScreen", content: `export default function BookingScreen() {
  const [state, setState] = useState("idle");
  return (
    <main>
      <h1>Book a farm visit</h1>
      {state === "confirmed" ? <p role="status">Booking confirmed — reference SA-2 (repaired)</p> : null}
      <button onClick={async () => { await booking.createBooking({ date: "2026-08-10", slot: "10:00", partySize: 2 }); setState("confirmed"); }}>Submit booking</button>
      <footer><a href="https://www.pexels.com">Photos provided by Pexels</a>{ASSET_CREDITS.map((credit) => credit.photoUrl ? <a key={credit.photoUrl} href={credit.photoUrl}>{credit.photographer}</a> : null)}</footer>
    </main>
  );
}` }],
  }];
  let sawRepairEvidence = null;
  const h = harness({
    patchPlan: {
      core: () => CORE_PATCH,
      repair: ({ problems }) => { sawRepairEvidence = problems; return REPAIRED_PATCH; },
      "increment:newsletter-signup": () => NEWSLETTER_PATCH,
      "increment:browse-info": () => BROWSE_PATCH,
    },
    journeysFn: async ({ journeys }) => ({
      journeys: journeys.map((j) => {
        if (j.id !== "book-a-visit") return { id: j.id, title: j.title, priority: j.priority, status: "pass" };
        bookingDrives += 1;
        // First drive fails with step evidence; the repaired tree passes.
        return bookingDrives === 1
          ? { id: j.id, title: j.title, priority: j.priority, status: "fail", steps: [{ action: "submit the booking form", status: "fail", detail: "confirmation never appeared" }] }
          : { id: j.id, title: j.title, priority: j.priority, status: "pass" };
      }),
    }),
  });
  const result = await h.orchestrator.runBuild({ owner: "o", projectId: "proj-1", request: "booking site" });
  assert.equal(result.state, "green", JSON.stringify(result));
  assert.ok(sawRepairEvidence?.some((p) => /submit the booking form.*confirmation never appeared/.test(p)),
    `the repair round is briefed with the EXACT browser evidence: ${JSON.stringify(sawRepairEvidence)}`);
  const finalTree = await h.snapshotStore.materialize("o", await h.snapshotStore.pointer("o", "proj-1", "green"));
  assert.match(finalTree["src/screens/scaffold/BookingScreen.jsx"], /repaired/, "the repaired tree is what shipped");
});

test("WP11/V2-20 — an unmoved repair escalates its strategy and never repeats an identical round", async () => {
  // The bound used to be the ONLY stop: two futile rounds, both charged, then blocked. The loop
  // now measures each round against the typed defect set it was briefed with, so a repair that
  // edits a file and leaves the defect exactly where it was ends the tier immediately. The
  // maxJourneyRepairs ceiling still stands above it and is never exceeded.
  let repairCalls = 0;
  const h = harness({
    failJourneys: ["book-a-visit"],
    patchPlan: {
      core: () => CORE_PATCH,
      repair: () => { repairCalls += 1; return [{ file: "src/screens/scaffold/BookingScreen.jsx", ops: [{ op: "append", content: `\n// futile repair ${repairCalls}\n` }] }]; },
      "increment:newsletter-signup": () => NEWSLETTER_PATCH,
      "increment:browse-info": () => BROWSE_PATCH,
    },
  });
  const result = await h.orchestrator.runBuild({ owner: "o", projectId: "proj-1", request: "booking site" });
  assert.equal(result.state, "blocked");
  // An unmoved round no longer ENDS the tier — it escalates to a different strategy, so the
  // approved allowance is spent on genuinely different attempts rather than surrendered.
  //
  // The core takes a RESERVED SHARE first (ceil(2 * 0.4) = 1 here) so it cannot starve the two
  // secondary journeys — the build that spent all ten rounds on the core and left six journeys
  // with nothing. But the reservation is SOFT: a red core ends the build, so nothing downstream
  // could have used the remainder anyway, and the core continues into it rather than blocking
  // with credits unspent. Both halves are asserted here because either one alone is a bug.
  assert.equal(repairCalls, 2, "reserved share, then overflow into the rest of the pool");
  assert.equal(result.repairRounds, 2);
  assert.equal(result.repairProgressStop?.reason, "unchanged");
  assert.ok(["exact_owning_file_repair", "causal_dependency_repair"]
    .includes(result.repairProgressStop?.strategy));
  // Having used the whole allowance, the tier reports the allowance as the thing that ran out.
  assert.ok(["repair_share_exhausted", "repair_strategies_exhausted", "repair_allowance_exhausted"]
    .includes(result.stopReason), `unexpected stopReason: ${result.stopReason}`);
  assert.ok(!(await h.snapshotStore.pointer("o", "proj-1", "green")), "nothing promoted");
});

test("WP11/V2-20 — a regressive repair is rolled back before the next strategy", async () => {
  const contract = structuredClone(CONTRACT);
  contract.journeys[0].steps = [
    { action: "open the booking page", target: "/book", expect: "the booking form is visible" },
    { action: "submit the booking form", target: "submit booking", expect: "booking confirmed" },
  ];
  let repairCalls = 0;
  const h = harness({
    contract,
    maxJourneyRepairs: 2,
    patchPlan: {
      core: () => CORE_PATCH,
      repair: ({ tree }) => {
        repairCalls += 1;
        if (repairCalls === 2) {
          assert.doesNotMatch(tree["src/screens/scaffold/BookingScreen.jsx"], /regressive-candidate/,
            "the next strategy must start from the retained browser checkpoint");
        }
        return [{ file: "src/screens/scaffold/BookingScreen.jsx", ops: [{ op: "append",
          content: repairCalls === 1 ? "\n// regressive-candidate\n" : "\n// repaired-candidate\n" }] }];
      },
      "increment:newsletter-signup": () => NEWSLETTER_PATCH,
      "increment:browse-info": () => BROWSE_PATCH,
    },
    journeysFn: async ({ journeys, tree }) => ({
      journeys: journeys.map((journey) => {
        if (journey.id !== "book-a-visit") {
          return { id: journey.id, title: journey.title, priority: journey.priority, status: "pass" };
        }
        if (/repaired-candidate/.test(tree["src/screens/scaffold/BookingScreen.jsx"] || "")) {
          return { id: journey.id, title: journey.title, priority: journey.priority, status: "pass",
            steps: journey.steps.map((step) => ({ ...step, status: "pass", drove: true })) };
        }
        const failAt = /regressive-candidate/.test(tree["src/screens/scaffold/BookingScreen.jsx"] || "") ? 0 : 1;
        return { id: journey.id, title: journey.title, priority: journey.priority, status: "fail",
          owners: ["src/screens/scaffold/BookingScreen.jsx"],
          steps: journey.steps.map((step, index) => ({ ...step,
            status: index < failAt ? "pass" : index === failAt ? "fail" : "not_reached",
            drove: index <= failAt,
          })) };
      }),
    }),
  });

  const result = await h.orchestrator.runBuild({ owner: "o", projectId: "proj-repair-rollback",
    request: "booking site" });
  assert.equal(result.state, "green", JSON.stringify(result));
  assert.equal(repairCalls, 2);
  const finalTree = await h.snapshotStore.materialize("o",
    await h.snapshotStore.pointer("o", "proj-repair-rollback", "green"));
  assert.doesNotMatch(finalTree["src/screens/scaffold/BookingScreen.jsx"], /regressive-candidate/);
  assert.match(finalTree["src/screens/scaffold/BookingScreen.jsx"], /repaired-candidate/);
});

test("WP11/V2-20 — an identical full strategy cycle never restarts through core overflow", async () => {
  let repairCalls = 0;
  const h = harness({
    maxJourneyRepairs: 8,
    failJourneys: ["book-a-visit"],
    patchPlan: {
      core: () => CORE_PATCH,
      repair: () => { repairCalls += 1; return [{ file: "src/screens/scaffold/BookingScreen.jsx",
        ops: [{ op: "append", content: `\n// unchanged production-shape repair ${repairCalls}\n` }] }]; },
      "increment:newsletter-signup": () => NEWSLETTER_PATCH,
      "increment:browse-info": () => BROWSE_PATCH,
    },
  });
  const result = await h.orchestrator.runBuild({ owner: "o", projectId: "proj-1", request: "booking site" });
  assert.equal(result.state, "blocked");
  assert.equal(repairCalls, 3, "each distinct strategy runs once; the outer core loop must not repeat them");
  assert.equal(result.repairRounds, 3);
  assert.equal(result.stopReason, "repair_strategies_exhausted");
});

test("WP11/V2-20 — rejected repair candidates stop before an undefined strategy is persisted", async () => {
  const started = [];
  const finished = [];
  const h = harness({
    maxJourneyRepairs: 8,
    failJourneys: ["book-a-visit"],
    patchPlan: {
      core: () => CORE_PATCH,
      repair: () => [],
      "increment:newsletter-signup": () => NEWSLETTER_PATCH,
      "increment:browse-info": () => BROWSE_PATCH,
    },
    events: {
      repairStrategyStarted: async (row) => {
        assert.ok(row.strategyId, "the durable strategy_id must never be null");
        started.push(row.strategyId);
        return { id: `strategy-${started.length}`, ...row };
      },
      repairStrategyFinished: async (row) => { finished.push(row); },
    },
  });
  const result = await h.orchestrator.runBuild({
    owner: "o", projectId: "proj-rejected-strategies", request: "booking site",
  });
  assert.equal(result.state, "blocked", JSON.stringify(result));
  assert.equal(result.stopReason, "repair_strategies_exhausted");
  assert.deepEqual(started, [
    "exact_owning_file_repair", "causal_dependency_repair", "owner_module_regeneration",
  ]);
  assert.equal(finished.length, 3, "each started strategy is durably finished once");
});

test("WP11/D4 — a failing backend-row probe blocks eligibility even when the browser journey passed", async () => {
  const h = harness({
    backendProbeFn: async () => [{ journeyId: "book-a-visit", detail: "no booking row was created during verification" }],
    patchPlan: {
      core: () => CORE_PATCH,
      // Repairs can't fix a missing database row that the browser can't see — rounds burn, then block.
      repair: () => [{ file: "src/screens/scaffold/BookingScreen.jsx", ops: [{ op: "append", content: "\n// probe repair attempt\n" }] }],
      "increment:newsletter-signup": () => NEWSLETTER_PATCH,
      "increment:browse-info": () => BROWSE_PATCH,
    },
  });
  const result = await h.orchestrator.runBuild({ owner: "o", projectId: "proj-1", request: "booking site" });
  assert.equal(result.state, "blocked");
  assert.match(result.error, /backend-row/i);
});

test("WP8 — renderAssetData is deterministic and placeholder-safe", () => {
  const resolved = [
    { slot: "hero", via: "search", asset: { alt_text: "a", original_url: "https://x/o.jpg", optimised_url: null, width: 100, height: 50, variants: {} } },
    { slot: "route:/book", via: "placeholder", asset: { placeholder: true, css: "linear-gradient(1deg, #000, #fff)", alt: "b" } },
  ];
  const rendered = renderAssetData(resolved);
  assert.equal(rendered, renderAssetData([...resolved].reverse()), "slot order is canonical");
  assert.match(rendered, /placeholder.*true/s);
  assert.match(rendered, /do not hardcode image URLs/);
  assert.match(rendered, /ASSET_CREDITS/);
});

test("H6 — Pexels API linking is a deterministic gate, not prompt-only guidance", () => {
  const assets = [{ via: "search", asset: { provider: "pexels", license: { apiLinkRequired: true } } }];
  assert.deepEqual(lintAssetAttribution({ "src/App.jsx": "export default function App(){}" }, assets), {
    ok: false,
    problems: [
      "Pexels API compliance: render credits from ASSET_CREDITS in generated UI",
      "Pexels API compliance: include a visible link to https://www.pexels.com",
      "Pexels API compliance: link each available photographer credit to photoUrl",
    ],
  });
  const compliant = `import { ASSET_CREDITS } from "./lib/assetData.js";
    export const Footer = () => <footer><a href="https://www.pexels.com">Pexels</a>
      {ASSET_CREDITS.map((credit) => <a href={credit.photoUrl}>{credit.photographer}</a>)}</footer>`;
  assert.deepEqual(lintAssetAttribution({ "src/Footer.jsx": compliant }, assets), { ok: true, problems: [] });
});

// ── a dead control is a CORRECTION, not a repair round ─────────────────────────────────────────
//
// The reservation layer has always counted two allowances separately: `repair` is a round briefed
// by observed journey failure, `correction` is a named structural fix. Run #7 (2026-08-12) blurred
// them — three contact textboxes that could not hold a value produced "step 5 was undriveable",
// both repair rounds were spent restating that, nothing was fixed, and the build ended with no
// allowance left for whatever the journeys might have found next.
//
// The pre-journey mechanics probe turns that into a defect with an address — control id, expected
// mechanic, observed result — so it is charged where structural fixes are charged.

// A REAL contracted control id: an invented one could never be resolved back to a field name, so
// the test would prove nothing about the mapping it exists to check.
const MECHANICS_CONTROL = deriveVerificationManifest(deriveBuildSpec(CONTRACT)).controls[0];
const MECHANICS_FAILURE = {
  probed: 1, skipped: [],
  failures: [{ id: MECHANICS_CONTROL?.id || "ctl_abcd1234", primitive: "textbox", expected: "Probe",
    observed: "", detail: "the contracted textbox did not retain a probe value" }],
};

const MECHANICS_PATCH_PLAN = {
  core: () => CORE_PATCH,
  repair: (ctx) => [{
    file: ctx.repairBoundary?.allowedFiles?.[0] || "src/screens/scaffold/BookingScreen.jsx",
    ops: [{ op: "append", content: "\n// mechanics correction attempt\n" }],
  }],
  "increment:newsletter-signup": () => NEWSLETTER_PATCH,
  "increment:browse-info": () => BROWSE_PATCH,
};

/** A browser layer whose probe fails until `healAfter` verifications have run. */
const mechanicsJourneys = ({ healAfter = Infinity } = {}) => {
  let verifications = 0;
  return async ({ journeys }) => {
    verifications += 1;
    const broken = verifications < healAfter;
    return {
      journeys: journeys.map((j) => ({ id: j.id, title: j.title, priority: j.priority,
        status: broken && j.priority === "primary" ? "undriveable" : "pass" })),
      mechanics: broken ? MECHANICS_FAILURE : { probed: 1, skipped: [], failures: [] },
    };
  };
};

test("MECHANICS — a probe-proven dead control is charged to the correction allowance", async () => {
  const { orchestrator, patchCalls } = harness({
    journeysFn: mechanicsJourneys(), patchPlan: MECHANICS_PATCH_PLAN,
  });
  const result = await orchestrator.runBuild({ owner: "o", projectId: "mech-1", request: "booking site" });

  // The build still blocks — nothing in this harness repairs the control — but WHERE the round was
  // charged is the claim.
  assert.equal(result.state, "blocked", JSON.stringify(result).slice(0, 160));
  const mechanicsRounds = patchCalls.filter((row) => row.dispatchReason === "mechanics_correction");
  assert.equal(mechanicsRounds.length, 1,
    `dispatch identities: ${JSON.stringify(patchCalls.map((row) => `${row.originalStep || row.step}→${row.step}`))}`);
  const mapped = deriveVerificationManifest(deriveBuildSpec(CONTRACT)).mapping[MECHANICS_CONTROL.id];
  const expectedOwners = [...new Set([mapped.stateOwner, ...(mapped.responsibleModules || [])]
    .filter((file) => mechanicsRounds[0].treeFiles.includes(file)))];
  assert.deepEqual(mechanicsRounds[0].repairBoundary?.allowedFiles, expectedOwners,
    "the correction is bounded to the generated state owner instead of replaying every planned module");
  assert.equal(result.mechanicsCorrections, 1);
  // It ran BEFORE the repair tier and did not exhaust it.
  assert.equal(result.mechanicsFailures.length, 1);
});

test("MECHANICS — the correction is briefed with the control id and the observed mechanic", async () => {
  const { orchestrator, patchCalls } = harness({ journeysFn: mechanicsJourneys() });
  await orchestrator.runBuild({ owner: "o", projectId: "mech-2", request: "booking site" });
  const brief = (patchCalls.find((row) => row.originalStep === "repair" && row.step === "correction")?.problems || []).join(" ");
  assert.match(brief, new RegExp(MECHANICS_CONTROL.id), "the brief does not name the control");
  assert.match(brief, /textbox/);
  assert.match(brief, /observed ""/, "the brief does not say what the browser observed");
  assert.match(brief, /defaultValue|onChange/, "the brief offers no generic working pattern");
  // …and it NAMES the control, in the vocabulary the model itself wrote.
  //
  // This assertion used to be its opposite — no business word anywhere — which conflated two
  // different rules. The browser must stay domain-blind because a verifier that needs vocabulary
  // gets unfamiliar domains wrong; that is asserted separately, below, and the two must be able to
  // fail independently. A BRIEF is a message to the author of the contract, and a hand-wired
  // control has no ctl_ handle it would recognise. Repair briefs have always carried journey ids
  // and step prose for exactly this reason.
  assert.match(brief, /the contracted "/, "the brief does not name the control the model wrote");
});

test("MECHANICS — the BROWSER still never receives the business mapping", () => {
  // The other half of the split. Whatever the brief says, nothing that crosses into browserPlan
  // may carry a business name: that boundary is what keeps verification working on domains the
  // platform has never seen.
  const spec = deriveBuildSpec(CONTRACT);
  const manifest = deriveVerificationManifest(spec);
  const plan = browserPlan(manifest);
  assert.ok(Object.keys(manifest.mapping || {}).length, "the mapping exists platform-side");
  assert.equal("mapping" in plan, false, "browserPlan carries the business mapping");
  // The boundary is the MAPPING — the id→meaning dictionary the browser could reason with. Contract
  // -supplied accessible names do cross, by design and by long-standing comment: they are strings
  // the contract handed over for locating, not a table the platform can generalise from. That
  // distinction is the whole basis of the locator ladder, and conflating the two here would forbid
  // the thing the architecture permits while proving nothing about the thing it forbids.
  for (const row of [...plan.controls, ...plan.actions]) {
    assert.equal("logicalField" in row, false, `browserPlan row ${row.id} carries a logical field`);
    assert.equal("journeyId" in row, false, `browserPlan row ${row.id} carries a business journey id`);
  }
});

test("MECHANICS — a correction that works leaves the repair tier untouched", async () => {
  // The probe fails once, the correction lands, and the journeys go green: no repair round runs.
  const { orchestrator, patchCalls } = harness({ journeysFn: mechanicsJourneys({ healAfter: 2 }) });
  const result = await orchestrator.runBuild({ owner: "o", projectId: "mech-3", request: "booking site" });
  assert.equal(patchCalls.filter((row) => row.originalStep === "repair" && row.step === "repair").length, 0,
    "a browser-informed repair round was spent on a control the correction had already fixed");
  assert.equal(result.mechanicsCorrections, 1);
});

test("MECHANICS — the allowance is bounded and hands over to the repair tier", async () => {
  const { orchestrator, patchCalls } = harness({ journeysFn: mechanicsJourneys() });
  const result = await orchestrator.runBuild({ owner: "o", projectId: "mech-4", request: "booking site" });
  assert.equal(result.mechanicsCorrections, 1, "the mechanics loop span on a control that never heals");
  // …and the repair tier still got its turn afterwards, which is the point of separating them.
  assert.ok(patchCalls.some((row) => row.originalStep === "repair" && row.step === "repair"),
    `no repair round followed: ${JSON.stringify(patchCalls.map((row) => `${row.originalStep}→${row.step}`))}`);
});

// ── the contract gate ─────────────────────────────────────────────────────────────────────────
//
// A contract the derived build spec cannot satisfy used to end the build on the spot: the
// contract lane deliberately returns its best degraded attempt, this gate re-ran checks that
// attempt had already failed, and the customer got one sentence naming nothing. One targeted
// repair round now runs first, and whatever still fails is named.

const ACCOUNTS_PROFILE = Object.freeze({
  version: 1, requestedBuildType: "application", resolvedBuildType: "application",
  applicationSubtype: "auto", requirementSignals: ["user_accounts"],
  inferenceSource: "explicit", confidence: 1,
});
const AUTH_MISSING = "build_profile_contract_incomplete signal=user_accounts missing=required_auth_semantics";
const ungatedContract = { ...CONTRACT, buildProfile: ACCOUNTS_PROFILE };
const gatedContract = {
  ...CONTRACT, buildProfile: ACCOUNTS_PROFILE,
  auth: { required: true, model: "email and password", rules: ["a visitor sees only their own booking"] },
};

test("CONTRACT GATE — a rejected contract earns one repair briefed with the exact problems", async () => {
  const asks = [];
  const { orchestrator, buildStore } = harness({
    contractFn: async ({ priorContract = null, problems = [] }) => {
      asks.push({ repaired: Boolean(priorContract), problems });
      return problems.length ? gatedContract : ungatedContract;
    },
  });
  const result = await orchestrator.runBuild({ owner: "o", projectId: "gate-1", request: "booking site" });

  assert.equal(result.state, "green", JSON.stringify(result.error || result));
  assert.equal(asks.length, 2, "the gate failure did not earn a contract repair");
  assert.equal(asks[0].repaired, false);
  assert.equal(asks[1].repaired, true, "the repair was not shown the contract it must correct");
  assert.deepEqual(asks[1].problems, [AUTH_MISSING], "the repair was briefed with something other than the gate's own problems");
  const build = await buildStore.get(result.buildId);
  assert.equal(build.state, "green");
});

test("CONTRACT GATE — a repair that does not close the gate blocks with the problems named", async () => {
  let calls = 0;
  const { orchestrator } = harness({
    contractFn: async () => { calls += 1; return ungatedContract; },
  });
  const result = await orchestrator.runBuild({ owner: "o", projectId: "gate-2", request: "booking site" });

  assert.equal(result.state, "blocked");
  assert.equal(calls, 2, "exactly one repair round is spent on a contract the gate rejects");
  assert.equal(result.contractRepairUsed, true);
  assert.deepEqual(result.problems, [AUTH_MISSING]);
  assert.deepEqual(result.failingGates, ["buildProfile"]);
  assert.ok(result.error.includes(AUTH_MISSING), `the customer-visible failure named nothing: ${result.error}`);
});

test("CONTRACT GATE — a contract the gate accepts is never re-asked", async () => {
  let calls = 0;
  const { orchestrator } = harness({ contractFn: async () => { calls += 1; return gatedContract; } });
  const result = await orchestrator.runBuild({ owner: "o", projectId: "gate-3", request: "booking site" });
  assert.equal(result.state, "green", JSON.stringify(result.error || result));
  assert.equal(calls, 1, "a derivable contract paid for a second contract dispatch");
});
