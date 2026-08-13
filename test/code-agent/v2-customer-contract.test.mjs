import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import { activeBuildsFor } from "../../shell/server/lib/buildJobs.mjs";
import { customerCredits } from "../../shell/server/lib/customerCredits.mjs";
import { reconcileAmbiguousModelReservations } from "../../shell/server/lib/modelReservationReconciler.mjs";
import { reconcileConsumedBuildBudgetApprovals } from "../../shell/server/lib/builderV2/buildBudgetApprovals.mjs";
import { repositoryRunBudgetProvider } from "../../shell/server/lib/usageBudgets.mjs";

function rowsQuery(rows) {
  const query = {
    select: () => query,
    eq: () => query,
    in: () => query,
    lte: () => query,
    order: () => query,
    limit: () => query,
    then(resolve, reject) {
      return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
    },
  };
  return query;
}

test("customer credits separate included, purchased, and held balances", async () => {
  const priorKey = process.env.THRALLO_STRIPE_SECRET_KEY;
  const priorPrice = process.env.THRALLO_STRIPE_TOPUP_PRICE_ID;
  const priorCredits = process.env.THRALLO_STRIPE_TOPUP_CREDITS;
  delete process.env.THRALLO_STRIPE_SECRET_KEY;
  delete process.env.THRALLO_STRIPE_TOPUP_PRICE_ID;
  delete process.env.THRALLO_STRIPE_TOPUP_CREDITS;
  try {
    const byTable = {
      bv2_model_reservations: [{ included_reserved_credits: 2, purchased_reserved_credits: 1 }],
      ca_lead_model_reservations: [{ included_reserved_credits: 1.5, purchased_reserved_credits: 0.5 }],
      ca_direct_model_reservations: [{ included_reserved_credits: 0.5, purchased_reserved_credits: 0.25 }],
    };
    const credits = await customerCredits("owner", {
      balanceResolver: async () => ({ included: 10, purchased: 5 }),
      client: { from: (table) => rowsQuery(byTable[table]) },
    });
    assert.deepEqual(credits, {
      includedRemaining: 6,
      purchasedRemaining: 3.25,
      reserved: 5.75,
      totalAvailable: 9.25,
      purchaseAvailable: false,
    });
  } finally {
    if (priorKey === undefined) delete process.env.THRALLO_STRIPE_SECRET_KEY;
    else process.env.THRALLO_STRIPE_SECRET_KEY = priorKey;
    if (priorPrice === undefined) delete process.env.THRALLO_STRIPE_TOPUP_PRICE_ID;
    else process.env.THRALLO_STRIPE_TOPUP_PRICE_ID = priorPrice;
    if (priorCredits === undefined) delete process.env.THRALLO_STRIPE_TOPUP_CREDITS;
    else process.env.THRALLO_STRIPE_TOPUP_CREDITS = priorCredits;
  }
});

test("dashboard active-build summaries expose only owner-scoped queued or running jobs", async () => {
  const map = await activeBuildsFor("owner", ["project-1", "project-1", "project-2"], {
    client: { from: (table) => {
      assert.equal(table, "build_jobs");
      return rowsQuery([{
        id: "job-1", owner: "owner", project_id: "project-1", mode: "build",
        pipeline_version: "v2", status: "running", phase: "running", result: null,
        created_at: "2026-08-13T12:00:00.000Z",
      }]);
    } },
  });
  assert.equal(map.size, 1);
  assert.deepEqual(map.get("project-1"), {
    jobId: "job-1", projectId: "project-1", status: "running", phase: "running",
    mode: "build", pipelineVersion: "v2", error: null, stopReason: null, result: null,
  });
});

test("ambiguous provider holds transfer to platform only after the grace boundary", async () => {
  const calls = [];
  const client = {
    from: (table) => rowsQuery(({
      bv2_model_reservations: [{ id: "build-hold", owner: "owner", created_at: "2026-08-13T11:00:00.000Z" }],
      ca_lead_model_reservations: [{ id: "lead-hold", owner: "owner", created_at: "2026-08-13T11:05:00.000Z" }],
      ca_direct_model_reservations: [{ id: "direct-hold", owner: "owner", created_at: "2026-08-13T11:10:00.000Z" }],
    })[table] || []),
    rpc: async (name, args) => { calls.push({ name, args }); return { data: { id: args.p_reservation_id }, error: null }; },
  };
  const resolved = await reconcileAmbiguousModelReservations({
    client,
    now: Date.parse("2026-08-13T12:00:00.000Z"),
    graceMs: 15 * 60_000,
  });
  assert.deepEqual(resolved.map((row) => row.id), ["build-hold", "lead-hold", "direct-hold"]);
  assert.deepEqual(calls.map((call) => call.name), [
    "absorb_ambiguous_bv2_model_call",
    "absorb_ambiguous_ca_lead_model_call",
    "absorb_ambiguous_ca_direct_model_call",
  ]);
});

test("a crash between reservation and outcome classification is reconciled from held-none", async () => {
  const filters = [];
  const client = {
    from: () => {
      const query = rowsQuery([]);
      query.eq = (column, value) => { filters.push({ kind: "eq", column, value }); return query; };
      query.in = (column, value) => { filters.push({ kind: "in", column, value }); return query; };
      query.lte = (column, value) => { filters.push({ kind: "lte", column, value }); return query; };
      return query;
    },
    rpc: async () => ({ data: null, error: null }),
  };
  await reconcileAmbiguousModelReservations({ client, now: Date.now(), graceMs: 60_000 });
  assert.ok(filters.some((filter) => filter.kind === "eq"
    && filter.column === "reconciliation_state" && filter.value === "none"));
  assert.ok(filters.some((filter) => filter.kind === "eq"
    && filter.column === "reconciliation_state" && filter.value === "pending"));
  assert.ok(filters.some((filter) => filter.kind === "lte" && filter.column === "ambiguous_at"));
  assert.ok(filters.some((filter) => filter.kind === "lte" && filter.column === "created_at"));
});

test("orphaned consumed build approvals are actively reconciled after a process death", async () => {
  const calls = [];
  const rows = [{ id: "approval", status: "approved" }];
  const result = await reconcileConsumedBuildBudgetApprovals({
    client: { rpc: async (name, args) => { calls.push({ name, args }); return { data: rows, error: null }; } },
    now: Date.parse("2026-08-13T12:00:00.000Z"), graceMs: 10 * 60_000,
  });
  assert.deepEqual(result, rows);
  assert.equal(calls[0].name, "reconcile_bv2_build_budget_approvals");
  assert.equal(calls[0].args.p_older_than, "2026-08-13T11:50:00.000Z");
});

test("accounting and approval crash-recovery share durable database locks and identities", async () => {
  const sql = await readFile(new URL("../../supabase/migrations/20260813095526_v2_customer_accounting_and_approvals.sql", import.meta.url), "utf8");
  assert.match(sql, /create trigger credit_ledger_owner_model_lock before insert on public\.credit_ledger/i);
  assert.match(sql, /add column budget_approval_id uuid references public\.bv2_build_budget_approvals\(id\)/i);
  assert.match(sql, /delete from public\.projects p using candidates c[\s\S]*p\.budget_approval_id=c\.id/i);
});

test("the post-rollout accounting contract retires every allocation-unaware Builder RPC", async () => {
  const sql = await readFile(new URL("../../supabase/migrations/20260813183000_retire_legacy_bv2_accounting_rpcs.sql", import.meta.url), "utf8");
  assert.match(sql, /revoke execute on function public\.reserve_bv2_model_call\(/i);
  assert.match(sql, /revoke execute on function public\.reserve_bv2_model_call_v2\(/i);
  assert.match(sql, /revoke execute on function public\.settle_bv2_model_call\(/i);
});

test("repository admission delegates managed model affordability to purchased-credit reservations", async () => {
  assert.equal(repositoryRunBudgetProvider("managed"), "direct_reserved");
  assert.equal(repositoryRunBudgetProvider("anthropic"), "anthropic");
  for (const relative of [
    "../../shell/server/routes/codeAgent.mjs",
    "../../shell/server/lib/automationService.mjs",
    "../../shell/server/lib/capabilities/coreCapabilities.mjs",
  ]) {
    const source = await readFile(new URL(relative, import.meta.url), "utf8");
    assert.match(source, /repositoryRunBudgetProvider\(credentialProvider\)/);
  }
});
