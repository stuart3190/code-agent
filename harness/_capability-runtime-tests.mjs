import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { auditCapabilityTree } from "../shell/server/lib/capabilityAudit.mjs";
import { openAiCostGbp, safeRuntimeFetch } from "../shell/server/lib/capabilityRuntime.mjs";
import { CAPABILITY_PRESETS } from "../shell/server/lib/capabilities.mjs";

const migration = await readFile(new URL("../supabase/migrations/20260721224922_capability_runtime.sql", import.meta.url), "utf8");
for (const name of ["project_actions", "app_jobs", "runtime_usage", "app_usage_ledger", "action_schedules", "knowledge_bases", "knowledge_documents", "knowledge_chunks"]) {
  assert.match(migration, new RegExp(`create table if not exists public\\.${name}`));
  assert.match(migration, new RegExp(`alter table public\\.${name} enable row level security`));
}
for (const fn of ["reserve_runtime_credits", "settle_runtime_credits", "reserve_app_units", "refund_app_units", "match_knowledge_chunks", "claim_runtime_tasks"]) {
  assert.match(migration, new RegExp(`create or replace function public\\.${fn}`));
  assert.match(migration, new RegExp(`grant execute on function public\\.${fn}`));
}
assert.match(migration, /runtime-assets/);
assert.match(migration, /revoke all on public\.project_actions/);

const presetIds = new Set(CAPABILITY_PRESETS.map((item) => item.id));
for (const id of ["ai_text", "ai_image", "replicate_video", "media_finish", "pdf_extract", "pdf_merge", "archive", "knowledge_ingest", "safe_http"]) {
  assert.ok(presetIds.has(id), `missing capability preset ${id}`);
}

const safe = auditCapabilityTree({ "src/App.jsx": "await actions.invoke('ai_text', { prompt })" }, [{ key: "ai_text" }]);
assert.equal(safe.ok, true);
assert.equal(safe.warnings.length, 0);
assert.equal(auditCapabilityTree({ "src/App.jsx": "fetch('https://api.openai.com/v1/responses')" }).ok, false);
assert.equal(auditCapabilityTree({ "src/config.js": "export const key = 'sk-proj-1234567890abcdef'" }).ok, false);
await assert.rejects(() => safeRuntimeFetch("https://localhost/internal"), /public HTTPS/);
await assert.rejects(() => safeRuntimeFetch("http://example.com"), /public HTTPS/);
assert.equal(Number(openAiCostGbp({ input_tokens: 1_000_000, output_tokens: 0 }).toFixed(2)), 0.6);
assert.equal(Number(openAiCostGbp({ input_tokens: 1_000_000, input_tokens_details: { cached_tokens: 1_000_000 }, output_tokens: 0 }).toFixed(2)), 0.06);

const sdk = await readFile(new URL("../src/scaffolds/reactVite/lib/backend/supabaseBackend.js", import.meta.url), "utf8");
for (const surface of ["actions", "usage", "knowledge", "subscribe", "uploadMany", "createSignedUrl"]) assert.match(sdk, new RegExp(surface));

console.log("capability runtime tests: PASS");
