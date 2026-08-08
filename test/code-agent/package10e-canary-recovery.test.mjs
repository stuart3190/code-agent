import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../../ops/prove-v2-composition-dark-db.mjs", import.meta.url), "utf8");

test("Package 10E recovery is explicitly gated and production-project pinned", () => {
  assert.match(source, /THRALLO_PACKAGE10E_CANARY/);
  assert.match(source, /THRALLO_PROCESS_ROLE/);
  assert.match(source, /THRALLO_MANAGED_SETTLEMENT_PAUSED/);
  assert.match(source, /zczgvcsokfafuyognvwx/);
  assert.match(source, /10e00000-0000-4000-8000-000000000001/);
});

test("Package 10E recovery cannot manage ingress, Caddy, provisiond, or processes", () => {
  for (const forbidden of [
    /from\s+["'][^"']*atomicPublisher\.mjs["']/,
    /from\s+["'][^"']*provisiond[^"']*["']/,
    /ensureCaddy/,
    /child_process/,
    /\bspawn\s*\(/,
    /\bexec(?:File)?\s*\(/,
    /\bdocker\b/i,
    /Caddyfile/,
  ]) assert.doesNotMatch(source, forbidden);
});

test("Package 10E recovery exercises C8 through database RPCs only", () => {
  for (const rpc of [
    "register_verified_publish_release",
    "request_publish_activation",
    "mark_publish_pointer_switched",
    "complete_publish_activation",
    "request_publish_unpublish",
  ]) assert.match(source, new RegExp(`client\\.rpc\\(["']${rpc}["']`));
  assert.match(source, /filesystemMutationThisRun:\s*false/);
  assert.match(source, /filesystemProofReused/);
});

test("Package 10E recovery emits durable checkpoints and always verifies cleanup", () => {
  for (const checkpoint of [
    "baseline",
    "runtime_lifecycle_created",
    "graph_retrieval_patch_green",
    "snapshot_preview_export_qa_source_green",
    "worker_completion_recovery_green",
    "provider_replay_boundary_green",
    "c8_database_state_machine_green",
    "cleanup_customer_parity_green",
    "package10e_canary_recovery_complete",
  ]) assert.match(source, new RegExp(`emit\\(["']${checkpoint}["']`));
  assert.match(source, /await cleanup\(\)/);
  assert.match(source, /assert\.deepEqual\(after, baseline/);
});

test("Package 10E recovery never enables customer paths or dispatches a provider", () => {
  assert.doesNotMatch(source, /THRALLO_(?:BUILD_WORKER|ATOMIC_PUBLISH)_ENABLED\s*=\s*["']?1/);
  assert.doesNotMatch(source, /client\.(?:openai|anthropic|gemini)/i);
  assert.match(source, /providerCalls:\s*0/);
  assert.match(source, /stripeTransactions:\s*0/);
});
