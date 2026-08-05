// WP-8 — the Build Orchestrator's first-green loop, proven END TO END at zero model
// credits: fake contract + fake patches (the two model seams), everything else REAL — the
// real REACT_VITE scaffold, the real patch engine, the real stage gates via the
// verification facade, the real asset service on recorded payloads, the real C2 snapshot
// protocol with pointer promotions.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createOrchestrator, memoryBuildStore, renderAssetData } from "../../shell/server/lib/builderV2/orchestrator.mjs";
import { createSnapshotStore } from "../../shell/server/lib/builderV2/snapshotStore.mjs";
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
  newFile: "src/routes/BookPage.jsx",
  content: `import React, { useState } from "react";
import { ASSETS } from "../lib/assetData.js";
import { imageProps, isPlaceholder, placeholderStyle } from "../lib/assets.js";

export default function BookPage() {
  const [state, setState] = useState("idle");
  const hero = ASSETS["hero"];
  return (
    <main>
      <h1>Book a farm visit</h1>
      {isPlaceholder(hero) ? <div style={placeholderStyle(hero)} /> : <img {...imageProps(hero)} />}
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

const RECORDED_PHOTOS = [
  { id: 201, width: 2000, height: 1300, alt: "strawberry farm rows in summer light",
    photographer: "T", src: { original: "https://images.pexels.com/201/o.jpg", large2x: "https://images.pexels.com/201/l.jpg", medium: "https://images.pexels.com/201/m.jpg" } },
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
  "contract_id", "final_snapshot", "error", "started_at", "finished_at",
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

function harness({ failJourneys = [], patchPlan = null, assetService = recordedAssetService(), buildStore = memoryBuildStore() } = {}) {
  const snapshotStore = createSnapshotStore();
  const patchCalls = [];
  const journeyDrives = [];
  const plan = patchPlan || {
    core: () => CORE_PATCH,
    "increment:newsletter-signup": () => NEWSLETTER_PATCH,
    "increment:browse-info": () => BROWSE_PATCH,
  };
  const failSet = new Set(failJourneys);
  const orchestrator = createOrchestrator({
    contractFn: async () => CONTRACT,
    patchesFn: async (ctx) => { patchCalls.push({ step: ctx.step, rejections: ctx.rejections.length }); return plan[ctx.step](ctx); },
    assetService,
    snapshotStore,
    buildStore,
    journeysFn: async ({ journeys }) => {
      journeyDrives.push(journeys.map((j) => j.id));
      return { journeys: journeys.map((j) => ({ id: j.id, title: j.title, priority: j.priority, status: failSet.has(j.id) ? "fail" : "pass" })) };
    },
    baseTree: () => clone(fromScaffold(REACT_VITE)),
    baseline: REACT_VITE,
  });
  return { orchestrator, buildStore, snapshotStore, assetService, patchCalls, journeyDrives };
}

// ── the proofs ────────────────────────────────────────────────────────────────────────────────

test("WP8 — full first-green e2e: contract → assets → core green → both increments ship, zero model", async () => {
  const { orchestrator, buildStore, snapshotStore } = harness();
  const result = await orchestrator.runBuild({ owner: "o", projectId: "proj-1", request: "booking site" });

  assert.equal(result.state, "green", JSON.stringify(result));
  assert.deepEqual(result.shipped, ["newsletter-signup", "browse-info"]);
  assert.deepEqual(result.pendingIncrements, []);
  assert.equal(result.providerCalls, 2, "hero + route:/book resolved once each");

  const build = await buildStore.get(result.buildId);
  assert.deepEqual(build.states, [
    "created", "contracting", "assets", "core", "verify_core", "green",
    "increment:newsletter-signup", "increment:browse-info", "green",
  ], "the exact Part 5 state walk");

  // The green pointer names the LAST increment's snapshot; its tree holds everything.
  const pointer = await snapshotStore.pointer("o", "proj-1", "green");
  assert.equal(pointer, result.snapshotId);
  const finalTree = await snapshotStore.materialize("o", pointer);
  assert.ok(finalTree["src/routes/BookPage.jsx"], "core");
  assert.ok(finalTree["src/routes/NewsletterPanel.jsx"], "increment 1");
  assert.ok(finalTree["src/routes/AboutSection.jsx"], "increment 2");
  assert.match(finalTree["src/lib/assetData.js"], /images\.pexels\.com\/201/, "AssetRefs injected as constants");
  assert.ok(finalTree["src/lib/assets.js"], "the scaffold render helper ships");

  // Snapshot lineage: core → newsletter → browse.
  const finalSnap = await snapshotStore.getSnapshot(pointer);
  assert.equal(finalSnap.reason, "increment:browse-info");
  const mid = await snapshotStore.getSnapshot(finalSnap.parent_snapshot);
  assert.equal(mid.reason, "increment:newsletter-signup");
  assert.equal((await snapshotStore.getSnapshot(mid.parent_snapshot)).reason, "core");
  assert.ok(finalSnap.asset_manifest.length >= 2, "the asset manifest versions with the snapshot");
});

test("WP8/C4 — a failing secondary increment NEVER blocks the core: rollback + pending, later increments continue", async () => {
  const { orchestrator, snapshotStore } = harness({ failJourneys: ["newsletter-signup"] });
  const result = await orchestrator.runBuild({ owner: "o", projectId: "proj-1", request: "booking site" });

  assert.equal(result.state, "green");
  assert.deepEqual(result.shipped, ["browse-info"], "the increment AFTER the failure still ships");
  assert.deepEqual(result.pendingIncrements.map((p) => p.journeyId), ["newsletter-signup"]);

  const finalTree = await snapshotStore.materialize("o", await snapshotStore.pointer("o", "proj-1", "green"));
  assert.ok(finalTree["src/routes/BookPage.jsx"]);
  assert.ok(finalTree["src/routes/AboutSection.jsx"]);
  assert.equal(finalTree["src/routes/NewsletterPanel.jsx"], undefined,
    "the failed increment's tree was rolled back — its file is in NO promoted snapshot");
});

test("WP8/C4 — a failing ESSENTIAL journey blocks: no snapshot, no green pointer, state blocked", async () => {
  const { orchestrator, snapshotStore } = harness({ failJourneys: ["book-a-visit"] });
  const result = await orchestrator.runBuild({ owner: "o", projectId: "proj-1", request: "booking site" });
  assert.equal(result.state, "blocked");
  assert.match(result.error, /book-a-visit/);
  assert.ok(!(await snapshotStore.pointer("o", "proj-1", "green")), "nothing was ever promotable");
});

test("WP8 — machine-taught patch rejection: round 1 rejected op, round 2 receives the reasons and lands", async () => {
  let round = 0;
  const { orchestrator, patchCalls } = harness({
    patchPlan: {
      core: ({ rejections }) => {
        round += 1;
        if (round === 1) return [{ file: "src/routes/HomePage.jsx", ops: [{ op: "replace_symbol", symbol: "NoSuchSymbol", content: "x" }] }];
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

test("WP8 — stop rule: the same defect surviving a repair round blocks instead of burning attempts", async () => {
  const { orchestrator } = harness({
    patchPlan: {
      // Compiles and parses, but never renders the expected outcome → the expectations
      // gate fails identically every round.
      core: () => [{
        newFile: "src/routes/BookPage.jsx",
        content: "import React from \"react\";\n\nexport default function BookPage() {\n  return <main><h1>Placeholder</h1></main>;\n}\n",
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
  assert.ok(ctx.tree["src/routes/BookPage.jsx"]);
  assert.ok(ctx.index.files.get("src/routes/BookPage.jsx").symbols.some((s) => s.name === "BookPage"),
    "the index rebuilds deterministically from the snapshot");
});

test("WP8 — the shadow entry is triple-gated and fails closed in every direction", async () => {
  const { v2BuildEligible, startAppBuildV2 } = await import("../../shell/server/lib/builderV2/entry.mjs");
  const { __resetFlagCacheForTests } = await import("../../shell/server/lib/builderV2/featureFlags.mjs");
  const flagClient = (rows) => ({ from: () => ({ select: async () => ({ data: rows, error: null }) }) });
  const brokenClient = { from: () => ({ select: async () => ({ data: null, error: { message: "db down" } }) }) };
  const opts = (client) => ({ client, env: {}, now: Date.now });

  __resetFlagCacheForTests();
  assert.equal((await v2BuildEligible("owner-1", opts(flagClient([])))).eligible, false, "unset flags = off");

  __resetFlagCacheForTests();
  const enrolled = await v2BuildEligible("owner-1", opts(flagClient([
    { key: "bv2.enabled", value: true }, { key: "bv2.owners", value: ["owner-1"] },
  ])));
  assert.equal(enrolled.eligible, true);

  __resetFlagCacheForTests();
  const notEnrolled = await v2BuildEligible("owner-2", opts(flagClient([
    { key: "bv2.enabled", value: true }, { key: "bv2.owners", value: ["owner-1"] },
  ])));
  assert.equal(notEnrolled.eligible, false, "allowlists are exact");

  // The kill switch beats flags that are ON, with no cache in the way.
  __resetFlagCacheForTests();
  const killed = await v2BuildEligible("owner-1", {
    client: flagClient([{ key: "bv2.enabled", value: true }, { key: "bv2.owners", value: true }]),
    env: { THRALLO_BV2_KILL: "1" }, now: Date.now,
  });
  assert.equal(killed.eligible, false);
  assert.match(killed.reason, /THRALLO_BV2_KILL/);

  // Storage failure = closed, never thrown.
  __resetFlagCacheForTests();
  const broken = await v2BuildEligible("owner-1", opts(brokenClient));
  assert.equal(broken.eligible, false);

  // And until WP-9, even an eligible owner falls through to v1 — loudly.
  const shadow = await startAppBuildV2();
  assert.equal(shadow.handled, false);
  assert.match(shadow.reason, /WP-9/);
  __resetFlagCacheForTests();
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
  const { indexFile } = await import("../../shell/server/lib/builderV2/indexerV0.mjs");
  const scaffoldHome = clone(fromScaffold(REACT_VITE))["src/routes/HomePage.jsx"];
  const symbol = indexFile("src/routes/HomePage.jsx", scaffoldHome).symbols.find((s) => s.name === "HomePage");
  const identical = scaffoldHome.slice(symbol.start, symbol.end);

  let round = 0;
  let fedBack = null;
  const { orchestrator } = harness({
    patchPlan: {
      core: ({ rejections }) => {
        round += 1;
        if (round === 1) {
          // Exactly what the first live model did: "replace" the stub with its own content.
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
    newFile: "src/routes/BookPage.jsx",
    content: `import React from "react";
import { makeContactForm } from "../lib/capabilities";

const contactForm = makeContactForm({ entity: "contactMessage" });

export default function BookPage() {
  async function go() { await contactForm.submit({ name: "x" }); }
  return <main><h1>Book a farm visit</h1><p role="status">Booking confirmed — reference SA-1</p><button onClick={go}>Submit booking</button></main>;
}
`,
  }];
  const { orchestrator } = harness({
    patchPlan: {
      core: ({ rejections }) => {
        round += 1;
        if (round === 1) return BAD_CONTACT_PATCH;
        fedBack = rejections;
        return CORE_PATCH;
      },
      "increment:newsletter-signup": () => NEWSLETTER_PATCH,
      "increment:browse-info": () => BROWSE_PATCH,
    },
  });
  const result = await orchestrator.runBuild({ owner: "o", projectId: "proj-1", request: "booking site" });
  assert.equal(result.state, "green", "round 2 recovers with the taught interface");
  assert.ok(fedBack?.some((r) => r.signature === "capability-usage" && /\[submitContact\]/.test(r.reason)),
    `the rejection teaches the REAL interface: ${JSON.stringify(fedBack)}`);
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
});
