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

// ── WP-16 guard rails, drill-tested before any rollout ────────────────────────────────────────

test("WP16 — per-owner auto-rollback: 2 consecutive bad builds pull the owner from bv2.owners", async () => {
  const { autoRollbackCheck } = await import("../../shell/server/lib/builderV2/rollout.mjs");
  const { setFlag, flagValue, __resetFlagCacheForTests } = await import("../../shell/server/lib/builderV2/featureFlags.mjs");

  const flags = new Map([["bv2.owners", ["owner-a", "owner-b"]], ["bv2.enabled", true]]);
  const flagClient = {
    from: () => ({
      select: async () => ({ data: [...flags.entries()].map(([key, value]) => ({ key, value })), error: null }),
      upsert: (row) => { flags.set(row.key, row.value); return { then: (r) => Promise.resolve({ error: null }).then(r) }; },
    }),
  };
  const buildsClient = (rows) => ({
    from: () => ({
      select: () => ({
        eq: () => ({ order: () => ({ limit: async () => ({ data: rows.slice(0, 2), error: null }) }) }),
        gte: async () => ({ data: rows, error: null }),
      }),
    }),
  });
  const lines = [];
  const opts = { client: flagClient, env: {}, now: Date.now };

  __resetFlagCacheForTests();
  const result = await autoRollbackCheck({
    owner: "owner-a",
    client: buildsClient([{ state: "blocked" }, { state: "failed" }, { state: "green" }]),
    flagOptions: opts, log: (l) => lines.push(l),
  });
  assert.equal(result.action, "owner_reverted");
  assert.deepEqual(flags.get("bv2.owners"), ["owner-b"], "the failing owner builds on v1 now");
  assert.ok(lines.some((l) => /INCIDENT owner_reverted/.test(l)));

  // A green in the last two builds means no revert.
  __resetFlagCacheForTests();
  const fine = await autoRollbackCheck({
    owner: "owner-b",
    client: buildsClient([{ state: "green" }, { state: "blocked" }]),
    flagOptions: opts, log: () => {},
  });
  assert.equal(fine.action, "none");
  assert.deepEqual(flags.get("bv2.owners"), ["owner-b"]);
  __resetFlagCacheForTests();
});

test("WP16 — global auto-off: >20% failures over the window kills bv2.enabled for everyone", async () => {
  const { autoRollbackCheck } = await import("../../shell/server/lib/builderV2/rollout.mjs");
  const { __resetFlagCacheForTests } = await import("../../shell/server/lib/builderV2/featureFlags.mjs");
  const flags = new Map([["bv2.owners", []], ["bv2.enabled", true]]);
  const flagClient = {
    from: () => ({
      select: async () => ({ data: [...flags.entries()].map(([key, value]) => ({ key, value })), error: null }),
      upsert: (row) => { flags.set(row.key, row.value); return { then: (r) => Promise.resolve({ error: null }).then(r) }; },
    }),
  };
  const windowRows = [
    { state: "green" }, { state: "green" }, { state: "failed" }, { state: "blocked" },
    { state: "green" }, { state: "green" }, { state: "green" }, { state: "green" },
  ]; // 2/8 bad = 25% > 20%
  const client = {
    from: () => ({
      select: () => ({
        eq: () => ({ order: () => ({ limit: async () => ({ data: [{ state: "green" }], error: null }) }) }),
        gte: async () => ({ data: windowRows, error: null }),
      }),
    }),
  };
  const lines = [];
  __resetFlagCacheForTests();
  const result = await autoRollbackCheck({ owner: "anyone", client, flagOptions: { client: flagClient, env: {}, now: Date.now }, log: (l) => lines.push(l) });
  assert.equal(result.action, "global_off");
  assert.equal(flags.get("bv2.enabled"), false, "v2 is off for everyone until a human looks");
  assert.ok(lines.some((l) => /INCIDENT global_off/.test(l)));
  __resetFlagCacheForTests();
});
