// WP-14 — shadow indexing is flag-gated, kill-switch-aware, and ABSOLUTELY fault-isolated:
// a total shadow-store outage costs a completed v1 build nothing but a log line.

import { test } from "node:test";
import assert from "node:assert/strict";
import { shadowIndexBuild } from "../../shell/server/lib/builderV2/shadow.mjs";
import { __resetFlagCacheForTests } from "../../shell/server/lib/builderV2/featureFlags.mjs";

const TREE = {
  "src/App.jsx": 'import React from "react";\nexport default function App() { return null; }\n',
  "src/routes/HomePage.jsx": "export default function HomePage() {\n  return <main>hi</main>;\n}\n",
};

const flagClient = (rows) => ({ from: () => ({ select: async () => ({ data: rows, error: null }) }) });
const flagsOn = () => ({ client: flagClient([{ key: "bv2.shadow", value: true }]), env: {}, now: Date.now });

function fakeStoreClient() {
  const writes = [];
  let n = 0;
  const chain = (table) => {
    const api = {
      upsert: (payload) => { writes.push({ table, kind: "upsert", payload: Array.isArray(payload) ? payload.length : payload }); return api; },
      insert: (payload) => { writes.push({ table, kind: "insert", payload: Array.isArray(payload) ? payload.length : payload }); return api; },
      select: () => api,
      eq: () => api,
      delete: () => api,
      in: () => api,
      order: () => api,
      limit: () => api,
      single: () => Promise.resolve({ data: { id: `row-${++n}` }, error: null }),
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
      then: (r) => Promise.resolve({ data: [], error: null }).then(r),
    };
    return api;
  };
  return { writes, from: chain };
}

test("WP14 — flag off (or kill switch) means ZERO writes", async () => {
  __resetFlagCacheForTests();
  const client = fakeStoreClient();
  const off = await shadowIndexBuild({
    owner: "o", projectId: "p", tree: TREE, client,
    flagOptions: { client: flagClient([]), env: {}, now: Date.now }, log: () => {},
  });
  assert.deepEqual(off, { shadowed: false, reason: "bv2.shadow off" });
  assert.equal(client.writes.length, 0);

  __resetFlagCacheForTests();
  const killed = await shadowIndexBuild({
    owner: "o", projectId: "p", tree: TREE, client,
    flagOptions: { ...flagsOn(), env: { THRALLO_BV2_KILL: "1" } }, log: () => {},
  });
  assert.equal(killed.reason, "kill switch");
  assert.equal(client.writes.length, 0);
  __resetFlagCacheForTests();
});

test("WP14 — flag on: the tree is indexed, persisted, and the migration state records the pass", async () => {
  __resetFlagCacheForTests();
  const client = fakeStoreClient();
  const lines = [];
  const result = await shadowIndexBuild({
    owner: "o", projectId: "p", tree: TREE, buildId: "b1", client,
    flagOptions: flagsOn(), log: (l) => lines.push(l),
  });
  assert.equal(result.shadowed, true, JSON.stringify(result));
  assert.ok(result.treeHash);
  assert.ok(client.writes.some((w) => w.table === "bv2_file_revisions"), "the index persisted through the twins");
  const stateWrite = client.writes.find((w) => w.table === "bv2_migration_state");
  assert.equal(stateWrite.payload.state, "shadow");
  assert.equal(stateWrite.payload.notes.buildId, "b1");
  assert.equal(stateWrite.payload.notes.files, 2);
  assert.ok(lines.some((l) => /indexed 2 files/.test(l)));
  __resetFlagCacheForTests();
});

test("WP14 — FAULT INJECTION: a shadow-store outage never throws and never touches the caller", async () => {
  __resetFlagCacheForTests();
  const lines = [];
  // Every table write explodes — the worst possible shadow-store day.
  const broken = {
    from: () => { throw new Error("shadow store is down"); },
  };
  const result = await shadowIndexBuild({
    owner: "o", projectId: "p", tree: TREE, client: broken,
    flagOptions: flagsOn(), log: (l) => lines.push(l),
  });
  assert.equal(result.shadowed, false, "resolves, never rejects");
  assert.match(result.reason, /shadow store is down/);
  assert.ok(lines.some((l) => /v1 unaffected/.test(l)), "the isolation is stated out loud");

  // And the fire-and-forget shape the call site uses can never produce an unhandled rejection.
  __resetFlagCacheForTests();
  await new Promise((resolve, reject) => {
    process.once("unhandledRejection", reject);
    void shadowIndexBuild({ owner: "o", projectId: "p", tree: TREE, client: broken, flagOptions: flagsOn(), log: () => {} });
    setTimeout(resolve, 50);
  });
  __resetFlagCacheForTests();
});
