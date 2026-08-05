// Usage & analytics security: every customer surface is owner-scoped at the query level,
// admin surfaces reject non-admins, exports contain only the caller's own data, and the
// per-request accounting maths is correct. (The tables themselves are RLS-enabled with
// zero policies — nothing is browser-reachable except via these owner-scoped handlers.)

process.env.CODE_AGENT_STORE = "memory";
process.env.ADMIN_EMAILS = "admin@thrallo.com";
process.env.THRALLO_PRO_PRICE_GBP = "20"; // paid prices are env-gated; revenue maths needs one

import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { usageInsights, buildCostSummary, adminAnalytics, GBP_PER_CREDIT } from "../../shell/server/lib/usageInsights.mjs";
import { createDiagSession, getDiagRun, normalizeTelemetry, providerForModel } from "../../shell/server/lib/appBuild/buildDiagnostics.mjs";
import { isAdmin } from "../../shell/server/lib/admin.mjs";
import { meterWarning } from "../../shell/web/src/manage/usageWarnings.js";

const ALICE = "00000000-0000-4000-8000-00000000000a";
const BOB = "00000000-0000-4000-8000-00000000000b";

function fakeDb() {
  const rows = { diag_runs: [], diag_steps: [], diag_prefs: [], ai_requests: [], ca_subscriptions: [] };
  const from = (name) => {
    const q = { filters: [], gte: [], op: null, patch: null };
    const match = (r) => q.filters.every(([k, v]) => String(r[k]) === String(v))
      && q.gte.every(([k, v]) => String(r[k] ?? "") >= String(v));
    const exec = () => {
      let list = rows[name].filter(match);
      if (q.order) list = [...list].sort((a, b) => {
        const av = a[q.order]; const bv = b[q.order];
        const cmp = av > bv ? 1 : av < bv ? -1 : 0;
        return q.asc ? cmp : -cmp;
      });
      if (q.limit) list = list.slice(0, q.limit);
      if (q.op === "insert") { rows[name].push(...[].concat(q.patch)); return { data: q.patch, error: null }; }
      if (q.op === "update") { list.forEach((r) => Object.assign(r, q.patch)); return { data: list, error: null }; }
      return { data: list, error: null };
    };
    const chain = {
      select: () => chain, insert: (v) => { q.op = "insert"; q.patch = v; return chain; },
      update: (v) => { q.op = "update"; q.patch = v; return chain; },
      eq: (k, v) => { q.filters.push([k, v]); return chain; },
      gte: (k, v) => { q.gte.push([k, v]); return chain; },
      not: () => chain, lt: () => chain,
      order: (k, opts) => { q.order = k; q.asc = opts?.ascending !== false; return chain; },
      limit: (n) => { q.limit = n; return chain; },
      maybeSingle: async () => { const r = exec(); return { data: r.data?.[0] ?? null, error: null }; },
      then: (resolve) => resolve(exec()),
    };
    return chain;
  };
  return { from, rows };
}

async function seed() {
  const db = fakeDb();
  // Alice: one passed build with two AI requests.
  const a = await createDiagSession({ owner: ALICE, projectId: "proj-a", kind: "app_build", prompt: "Alice's shop", client: db });
  a.step({ agent: "Builder", kind: "agent", label: "Build", usage: { input: 10_000, output: 2_000, cached: 500, reasoning: 300, total: 12_000 }, model: "gpt-5.6-sol", durationMs: 9000 });
  a.step({ agent: "Verifier", kind: "verification", label: "Verify", status: "ok", output: "pass" });
  a.finish("passed");
  // Bob: one failed build.
  const b = await createDiagSession({ owner: BOB, projectId: "proj-b", kind: "app_build", prompt: "Bob's secret CRM", client: db });
  b.step({ agent: "Builder", kind: "agent", label: "Build", usage: { input: 50_000, output: 9_000, total: 59_000 }, model: "gpt-5.6-sol", durationMs: 30_000 });
  b.finish("failed");
  await a._chain; await b._chain;
  db.rows.ca_subscriptions.push({ owner: ALICE, plan: "pro", status: "active" }, { owner: BOB, plan: "free", status: "active" });
  return { db, aliceBuild: a.id, bobBuild: b.id };
}

test("per-request accounting records every required field with correct normalization", async () => {
  const { db } = await seed();
  const req = db.rows.ai_requests.find((r) => r.owner === ALICE);
  assert.equal(req.provider, "openai");
  assert.equal(req.model, "gpt-5.6-sol");
  assert.equal(req.agent, "Builder");
  assert.equal(req.input_tokens, 10_000);
  assert.equal(req.output_tokens, 2_000);
  assert.equal(req.cached_tokens, 500);
  assert.equal(req.reasoning_tokens, 300);
  assert.equal(req.duration_ms, 9000);
  assert.ok(req.cost > 0, "exact cost recorded");
  assert.ok(req.build_id && req.project_id && req.created_at, "build/project/timestamp linkage");
  // Both telemetry shapes normalize identically.
  assert.deepEqual(normalizeTelemetry({ inputTokens: 5, outputTokens: 3, cachedTokens: 1, reasoningTokens: 2 }),
    // providerRequestIds joined the shape on 2026-08-05 (billing-incident follow-up): null when
    // the provider surfaced none, so absence is distinguishable from an empty batch.
    { input: 5, output: 3, cached: 1, reasoning: 2, total: 8, providerRequestIds: null });
  assert.equal(providerForModel("claude-sonnet-4-6"), "anthropic");
  assert.equal(providerForModel("gemini-2.5-pro"), "google");
});

test("usage insights are strictly owner-scoped — Bob's data never leaks to Alice", async () => {
  const { db } = await seed();
  const alice = await usageInsights(ALICE, { client: db });
  assert.equal(alice.buildsThisMonth, 1);
  assert.equal(alice.recentBuilds[0].prompt.includes("Alice"), true);
  assert.equal(JSON.stringify(alice).includes("Bob's secret CRM"), false, "no cross-user content");
  assert.equal(alice.requests, 1);
  const bob = await usageInsights(BOB, { client: db });
  assert.equal(JSON.stringify(bob).includes("Alice"), false);
});

test("build summaries and diagnostics reject cross-owner access by Build ID", async () => {
  const { db, bobBuild } = await seed();
  assert.equal(await buildCostSummary(ALICE, bobBuild, { client: db }), null, "Alice cannot read Bob's build by URL id");
  assert.equal(await getDiagRun(ALICE, bobBuild, { client: db }), null, "diagnostics equally sealed");
  const own = await buildCostSummary(BOB, bobBuild, { client: db });
  assert.equal(own.prompt.includes("Bob"), true);
  assert.ok(own.costByAgent.find((a) => a.key === "Builder"), "cost by agent present for the owner");
});

test("exports (diagnostics download path) contain only the caller's own data", async () => {
  const { db, aliceBuild, bobBuild } = await seed();
  const full = await getDiagRun(ALICE, aliceBuild, { client: db, full: true });
  assert.ok(JSON.stringify(full).includes("Alice's shop"));
  assert.equal(JSON.stringify(full).includes("Bob"), false);
  assert.equal(await getDiagRun(ALICE, bobBuild, { client: db, full: true }), null);
});

test("admin analytics aggregates platform-wide and computes profitability", async () => {
  const { db } = await seed();
  const analytics = await adminAnalytics({ client: db });
  assert.equal(analytics.totals.activeUsers, 2);
  assert.equal(analytics.totals.builds, 2);
  assert.ok(analytics.totals.aiSpendCredits > 0);
  assert.ok(analytics.totals.monthlyRevenueGbp > 0, "Alice's pro plan counts as revenue");
  assert.equal(analytics.totals.grossProfitGbp,
    Number((analytics.totals.monthlyRevenueGbp - analytics.totals.aiSpendCredits * GBP_PER_CREDIT).toFixed(2)));
  assert.ok(analytics.topUsers.length >= 2);
  assert.ok(analytics.costByModel.find((m) => m.key === "gpt-5.6-sol"));
  assert.ok(analytics.series.daily.length >= 1, "daily series populated");
});

test("only ADMIN_EMAILS pass the admin gate, and the route enforces it server-side", async () => {
  assert.equal(isAdmin({ id: "x", email: "admin@thrallo.com" }), true);
  assert.equal(isAdmin({ id: "y", email: "customer@example.com" }), false);
  assert.equal(isAdmin({ id: "z", email: null }), false, "PAT-derived owners without email are never admin");
  const source = await readFile(fileURLToPath(new URL("../../shell/server/index.mjs", import.meta.url)), "utf8");
  const route = /if \(p === "\/api\/v1\/admin\/analytics"[\s\S]{0,400}?\}/.exec(source)?.[0] || "";
  assert.match(route, /requireOwner/, "route authenticates");
  assert.match(route, /isAdmin\(owner\)/, "route admin-gates");
  assert.match(route, /403/, "route rejects non-admins");
});

test("usage warnings fire at exactly 75%, 90% and 100%", () => {
  assert.equal(meterWarning(74, 100), null);
  assert.equal(meterWarning(75, 100).level, 75);
  assert.equal(meterWarning(90, 100).level, 90);
  assert.equal(meterWarning(100, 100).level, 100);
  assert.equal(meterWarning(150, 100).level, 100);
  assert.equal(meterWarning(10, 0), null, "no limit — no warning");
});
