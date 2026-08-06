#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";

import { indexTree } from "../shell/server/lib/builderV2/indexer.mjs";
import { compareGraphIndexes, manifestOf } from "../shell/server/lib/builderV2/graphParity.mjs";
import { beginShadowRun, loadIndex, persistIndex } from "../shell/server/lib/builderV2/supabaseTwins.mjs";

if (process.env.BV2_GRAPH_PROOF !== "1") throw new Error("BV2_GRAPH_PROOF=1 is required");
const url = process.env.API_URL;
const serviceKey = process.env.SERVICE_ROLE_KEY;
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(url || "") || !serviceKey) {
  throw new Error("graph proof refuses any target except a loopback disposable Supabase stack");
}

const client = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
const CONTAINER = "supabase_db_thrallo-migration-proof";
const OWNER_A = "90000000-0000-4000-8000-000000000001";
const OWNER_B = "90000000-0000-4000-8000-000000000002";
const PROJECT_A = "91000000-0000-4000-8000-000000000001";
const PROJECT_B = "91000000-0000-4000-8000-000000000002";
const POINTS = ["after_revision", "halfway_symbols", "refs", "edges"];

function sql(statement) {
  return execFileSync("docker", ["exec", "-i", CONTAINER, "psql", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"], {
    input: statement,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function unwrap(result, label) {
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  return result.data;
}

function faultTree(label) {
  return {
    [`src/${label}.js`]: `import { target } from "./target-${label}.js";\nexport function first() { return target(); }\nexport function second() { return first(); }\n`,
    [`src/target-${label}.js`]: "export function target() { return 1; }\n",
  };
}

async function ensurePrincipal(owner, project, suffix) {
  const { error: userError } = await client.auth.admin.createUser({
    id: owner,
    email: `bv2-graph-proof-${suffix}@example.invalid`,
    email_confirm: true,
  });
  if (userError && !/already/i.test(userError.message)) throw userError;
  unwrap(await client.from("projects").upsert({ id: project, owner, name: `BV2 graph proof ${suffix}`, tree: {} }), "project setup");
}

function installFaultHarness() {
  sql(`
    create table public.bv2_test_fault_control (point text primary key, seen integer not null default 0);
    create function public.bv2_test_fail_graph_write() returns trigger
    language plpgsql set search_path = '' as $$
    declare v_point text; v_seen integer;
    begin
      select point into v_point from public.bv2_test_fault_control limit 1;
      if v_point = 'after_revision' and tg_table_name = 'bv2_file_revisions' then
        raise exception 'injected after revision';
      end if;
      if v_point = 'halfway_symbols' and tg_table_name = 'bv2_symbols' then
        update public.bv2_test_fault_control set seen = seen + 1 returning seen into v_seen;
        if v_seen = 2 then raise exception 'injected halfway through symbols'; end if;
      end if;
      if v_point = 'refs' and tg_table_name = 'bv2_symbol_refs' then
        raise exception 'injected during refs';
      end if;
      if v_point = 'edges' and tg_table_name = 'bv2_dependency_edges' then
        raise exception 'injected during edges';
      end if;
      return new;
    end;
    $$;
    create trigger bv2_test_fail_revision after insert on public.bv2_file_revisions
      for each row execute function public.bv2_test_fail_graph_write();
    create trigger bv2_test_fail_symbol before insert on public.bv2_symbols
      for each row execute function public.bv2_test_fail_graph_write();
    create trigger bv2_test_fail_ref before insert on public.bv2_symbol_refs
      for each row execute function public.bv2_test_fail_graph_write();
    create trigger bv2_test_fail_edge before insert on public.bv2_dependency_edges
      for each row execute function public.bv2_test_fail_graph_write();
  `);
}

function setFault(point = null) {
  if (point !== null && !POINTS.includes(point)) throw new Error("unknown fault point");
  sql(point === null
    ? "truncate public.bv2_test_fault_control;"
    : `truncate public.bv2_test_fault_control; insert into public.bv2_test_fault_control(point) values ('${point}');`);
}

function removeFaultHarness() {
  sql(`
    drop trigger if exists bv2_test_fail_revision on public.bv2_file_revisions;
    drop trigger if exists bv2_test_fail_symbol on public.bv2_symbols;
    drop trigger if exists bv2_test_fail_ref on public.bv2_symbol_refs;
    drop trigger if exists bv2_test_fail_edge on public.bv2_dependency_edges;
    drop function if exists public.bv2_test_fail_graph_write();
    drop table if exists public.bv2_test_fault_control;
  `);
}

async function countPath(path) {
  const rows = unwrap(await client.from("bv2_file_revisions").select("id")
    .eq("owner", OWNER_A).eq("project_id", PROJECT_A).eq("path", path), "revision count");
  return rows.length;
}

const proof = { failures: {}, retries: {}, concurrent: null, ownerIsolation: null, parity: null, gc: null };
let harnessInstalled = false;
try {
  await ensurePrincipal(OWNER_A, PROJECT_A, "a");
  await ensurePrincipal(OWNER_B, PROJECT_B, "b");
  installFaultHarness();
  harnessInstalled = true;

  for (const point of POINTS) {
    const tree = faultTree(point);
    const path = Object.keys(tree)[0];
    setFault(point);
    await assert.rejects(persistIndex(OWNER_A, PROJECT_A, indexTree(tree), { client }), /injected/);
    assert.equal(await countPath(path), 0, `${point}: partial parent became visible`);
    setFault();
    const retry = await persistIndex(OWNER_A, PROJECT_A, indexTree(tree), { client });
    assert.equal(retry.written.length, 2);
    const loaded = await loadIndex(OWNER_A, PROJECT_A, retry.manifest, { client });
    assert.deepEqual(loaded.missing, []);
    assert.deepEqual(loaded.integrity, []);
    proof.failures[point] = "rolled_back";
    proof.retries[point] = "clean";
  }

  const concurrentTree = faultTree("concurrent");
  const concurrentIndex = indexTree(concurrentTree);
  const [left, right] = await Promise.all([
    persistIndex(OWNER_A, PROJECT_A, concurrentIndex, { client }),
    persistIndex(OWNER_A, PROJECT_A, concurrentIndex, { client }),
  ]);
  assert.equal(left.written.length + right.written.length, 2);
  assert.equal(await countPath("src/concurrent.js"), 1);
  proof.concurrent = "one_revision";

  const sameTree = faultTree("same-code");
  const sameIndex = indexTree(sameTree);
  await persistIndex(OWNER_A, PROJECT_A, sameIndex, { client });
  await persistIndex(OWNER_B, PROJECT_B, sameIndex, { client });
  await assert.rejects(loadIndex(OWNER_B, PROJECT_A, manifestOf(sameIndex), { client }), /does not belong to owner/i);
  proof.ownerIsolation = "two_physical_tenants_cross_read_rejected";

  const reloaded = await loadIndex(OWNER_A, PROJECT_A, manifestOf(sameIndex), { client });
  const parity = compareGraphIndexes(sameIndex, reloaded, { owner: OWNER_A, projectId: PROJECT_A });
  assert.equal(parity.clean, true, JSON.stringify(parity.mismatches));
  proof.parity = parity.actualCounts;

  const shadowTree = indexTree({ "src/gc.js": "export function gc() { return 1; }\n" });
  await persistIndex(OWNER_A, PROJECT_A, shadowTree, { client });
  await beginShadowRun(OWNER_A, PROJECT_A, "proof-shadow", shadowTree, { client });
  const snapshotTree = indexTree({ "src/gc.js": "export function gc() { return 2; }\n" });
  await persistIndex(OWNER_A, PROJECT_A, snapshotTree, { client });
  const snapshotHash = manifestOf(snapshotTree)["src/gc.js"];
  const snapshotId = "92000000-0000-4000-8000-000000000001";
  unwrap(await client.from("bv2_snapshots").insert({
    id: snapshotId, owner: OWNER_A, project_id: PROJECT_A,
    tree_hash: snapshotHash, reason: "graph-gc-proof", file_count: 1, total_tokens: 1, state: "ready",
  }), "snapshot setup");
  unwrap(await client.from("bv2_snapshot_files").insert({ snapshot_id: snapshotId, path: "src/gc.js", content_hash: snapshotHash }), "snapshot file setup");
  const latestTree = indexTree({ "src/gc.js": "export function gc() { return 3; }\n" });
  await persistIndex(OWNER_A, PROJECT_A, latestTree, { client });
  sql(`update public.bv2_file_revisions set indexed_at = indexed_at - interval '10 days'
       where owner = '${OWNER_A}' and project_id = '${PROJECT_A}' and path = 'src/gc.js';
       update public.bv2_file_revisions set indexed_at = clock_timestamp()
       where owner = '${OWNER_A}' and project_id = '${PROJECT_A}' and path = 'src/gc.js'
         and content_hash = '${manifestOf(latestTree)["src/gc.js"]}';`);
  const deleted = unwrap(await client.rpc("bv2_gc_file_revisions", {
    p_owner: OWNER_A, p_project_id: PROJECT_A, p_before: new Date().toISOString(),
  }), "graph gc");
  assert.equal(deleted, 0);
  proof.gc = "shadow_and_snapshot_pins_preserved";

  console.log(JSON.stringify({ ok: true, ...proof }));
} finally {
  try { setFault(); } catch {}
  if (harnessInstalled) {
    try { removeFaultHarness(); } catch {}
  }
  await client.from("bv2_snapshot_files").delete().eq("snapshot_id", "92000000-0000-4000-8000-000000000001");
  await client.from("bv2_snapshots").delete().eq("id", "92000000-0000-4000-8000-000000000001");
  await client.from("bv2_migration_state").delete().eq("owner", OWNER_A);
  await client.from("projects").delete().eq("id", PROJECT_A);
  await client.from("projects").delete().eq("id", PROJECT_B);
  await client.auth.admin.deleteUser(OWNER_A);
  await client.auth.admin.deleteUser(OWNER_B);
}
