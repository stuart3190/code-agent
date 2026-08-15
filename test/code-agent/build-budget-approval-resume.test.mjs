import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { resolveBuildBudgetApproval } from "../../shell/server/routes/buildBudgetApprovals.mjs";
import {
  ACTIVITY_STATE,
} from "../../shell/web/src/chat/activityState.js";
import {
  applyBuildUpdate, emptyConversationView, replayEvents,
} from "../../shell/web/src/chat/conversationState.js";

const OWNER = { id: "owner-1" };
const APPROVAL_ID = "approval-1";
const CONVERSATION = { id: "conversation-1", owner: OWNER.id };
const REQUEST = { description: "Build an advanced Roblox asset generator", productName: "Roblox Studio AI" };

function fixture({ initialStatus = "pending" } = {}) {
  let status = initialStatus;
  let build = null;
  let starts = 0;
  let reservationClaims = 0;
  const events = [];
  const turns = [];
  const approval = () => ({
    approvalId: APPROVAL_ID,
    conversationId: CONVERSATION.id,
    requestSummary: REQUEST.description,
    requestPayload: REQUEST,
    complexity: "advanced",
    ceilingCredits: 60,
    status,
  });
  const approvals = {
    async resolve(_owner, _id, action) {
      const changed = status === "pending";
      if (changed) status = action === "approve" ? "approved" : "declined";
      return { ...approval(), decisionChanged: changed };
    },
    async get() { return approval(); },
    async getDispatch() { return { approval: approval(), build }; },
    async attachDispatch() { return approval(); },
  };
  const store = {
    async getConversation() { return CONVERSATION; },
    async appendEvent(_conversation, type, payload) { events.push({ type, payload }); },
    async appendTurn(_conversation, turn) { turns.push(turn); },
    async listEvents() { return events.map((event, index) => ({ sequence: index + 1, ...event })); },
  };
  const startBuild = async (ctx) => {
    starts += 1;
    assert.equal(status, "approved");
    status = "consumed";
    reservationClaims += 1;
    build = {
      jobId: "job-1", projectId: "project-1", status: "queued", phase: "queued",
      pipelineVersion: "v2", workJobId: "work-1",
    };
    await ctx.emit("build_started", build);
    await ctx.emit("budget_approval_resolved", {
      approvalId: APPROVAL_ID, status: "consumed", ceilingCredits: 60,
    });
    return { handled: true, result: build };
  };
  return {
    approvals, store, startBuild, events, turns,
    state: () => ({ status, build, starts, reservationClaims }),
    setState(next) {
      if (next.status) status = next.status;
      if (Object.hasOwn(next, "build")) build = next.build;
    },
  };
}

test("advanced approval automatically resumes exactly one durable build and reservation path", async () => {
  const fx = fixture();
  const result = await resolveBuildBudgetApproval({
    owner: OWNER, approvalId: APPROVAL_ID, action: "approve",
    deps: { approvals: fx.approvals, store: fx.store, startBuild: fx.startBuild },
  });
  assert.equal(result.status, 202);
  assert.equal(result.body.approval.status, "consumed");
  assert.equal(result.body.build.jobId, "job-1");
  assert.deepEqual(fx.state(), {
    status: "consumed",
    build: {
      jobId: "job-1", projectId: "project-1", status: "queued", phase: "queued",
      pipelineVersion: "v2", workJobId: "work-1",
    },
    starts: 1,
    reservationClaims: 1,
  });
  assert.deepEqual(fx.events.slice(0, 2).map((event) => event.type), [
    "build_started", "budget_approval_resolved",
  ], "approved must not be advertised as complete before durable dispatch");
  assert.equal(fx.turns.length, 1);
  assert.match(fx.turns[0].content, /started the build automatically/i);
  assert.doesNotMatch(fx.turns[0].content, /approve.*prompt/i);
});

test("duplicate approval returns the existing consumed build without another dispatch", async () => {
  const fx = fixture();
  const deps = { approvals: fx.approvals, store: fx.store, startBuild: fx.startBuild };
  await resolveBuildBudgetApproval({ owner: OWNER, approvalId: APPROVAL_ID, action: "approve", deps });
  const duplicate = await resolveBuildBudgetApproval({ owner: OWNER, approvalId: APPROVAL_ID, action: "approve", deps });
  assert.equal(duplicate.status, 202);
  assert.equal(duplicate.body.approval.status, "consumed");
  assert.equal(duplicate.body.build.jobId, "job-1");
  assert.equal(fx.state().starts, 1);
  assert.equal(fx.state().reservationClaims, 1);
  assert.equal(fx.events.filter((event) => event.type === "build_started").length, 1);
});

test("a consumed approval whose winner is attaching returns resuming instead of dispatching twice", async () => {
  const fx = fixture({ initialStatus: "consumed" });
  const result = await resolveBuildBudgetApproval({
    owner: OWNER, approvalId: APPROVAL_ID, action: "approve",
    deps: { approvals: fx.approvals, store: fx.store, startBuild: fx.startBuild },
  });
  assert.equal(result.status, 202);
  assert.equal(result.body.resuming, true);
  assert.equal(result.body.build, null);
  assert.equal(fx.state().starts, 0);
});

test("a durable winning job repairs missing conversation transition events without redispatch", async () => {
  const fx = fixture();
  const durable = {
    jobId: "job-recovered", projectId: "project-recovered", status: "queued", phase: "queued",
    pipelineVersion: "v2", workJobId: "work-recovered",
  };
  const startBuild = async () => {
    fx.setState({ status: "consumed", build: durable });
    throw Object.assign(new Error("event stream write failed"), { code: "event_write_failed" });
  };
  const result = await resolveBuildBudgetApproval({
    owner: OWNER, approvalId: APPROVAL_ID, action: "approve",
    deps: { approvals: fx.approvals, store: fx.store, startBuild },
  });
  assert.equal(result.status, 202);
  assert.equal(result.body.build.jobId, durable.jobId);
  assert.equal(fx.events.filter((event) => event.type === "build_started").length, 1);
  assert.equal(fx.events.filter((event) => event.type === "budget_approval_resolved"
    && event.payload.status === "consumed").length, 1);
});

test("platform failure after approval persists the exact resume state and never returns to waiting", async () => {
  const fx = fixture();
  const startBuild = async () => {
    fx.setState({ status: "approved", build: null });
    throw Object.assign(new Error("database detail"), { code: "build_job_create_failed" });
  };
  await assert.rejects(resolveBuildBudgetApproval({
    owner: OWNER, approvalId: APPROVAL_ID, action: "approve",
    deps: { approvals: fx.approvals, store: fx.store, startBuild },
  }), (error) => error.code === "build_job_create_failed"
    && /durable build job/i.test(error.message) && !/database detail/i.test(error.message));

  const failure = fx.events.find((event) => event.type === "budget_approval_resume_failed");
  assert.equal(failure.payload.status, "approved");
  assert.equal(failure.payload.code, "build_job_create_failed");
  const view = replayEvents([
    { sequence: 1, type: "budget_approval_required", payload: { approvalId: APPROVAL_ID, status: "pending" } },
    { sequence: 2, ...failure },
  ]);
  assert.equal(view.waiting, false);
  assert.equal(view.buildActivity, ACTIVITY_STATE.failed);
  assert.equal(view.items[0].approval.status, "approved");
  assert.match(view.items[0].approval.resumeError, /durable build job/i);
});

test("terminal durable failure stays consumed and reconstructs as failed, not approval-pending", async () => {
  const fx = fixture();
  const failedBuild = {
    jobId: "job-failed", projectId: "project-1", status: "failed", phase: "failed",
    error: "Build work could not be queued.", stopReason: "worker_enqueue_failed", pipelineVersion: "v2",
  };
  const startBuild = async () => {
    fx.setState({ status: "consumed", build: failedBuild });
    throw new Error("queue unavailable");
  };
  await assert.rejects(resolveBuildBudgetApproval({
    owner: OWNER, approvalId: APPROVAL_ID, action: "approve",
    deps: { approvals: fx.approvals, store: fx.store, startBuild },
  }), (error) => error.code === "worker_enqueue_failed" && /could not be queued/i.test(error.message));
  assert.equal(fx.state().status, "consumed");
  assert.ok(fx.events.some((event) => event.type === "budget_approval_resolved"
    && event.payload.status === "consumed"));
  const failure = fx.events.find((event) => event.type === "budget_approval_resume_failed");
  assert.equal(failure.payload.status, "consumed");
  assert.equal(failure.payload.build.jobId, "job-failed");
});

test("refresh replay transitions approval waiting to a running durable build", () => {
  let view = replayEvents([
    { sequence: 1, type: "budget_approval_required", payload: { approvalId: APPROVAL_ID, status: "pending" } },
    { sequence: 2, type: "build_started", payload: { jobId: "job-1", projectId: "project-1" } },
    { sequence: 3, type: "budget_approval_resolved", payload: { approvalId: APPROVAL_ID, status: "consumed" } },
  ]);
  assert.equal(view.waiting, false);
  assert.equal(view.items[0].approval.status, "consumed");
  view = applyBuildUpdate(view, {
    jobId: "job-1", projectId: "project-1", status: "running", phase: "running",
  });
  assert.equal(view.buildActivity, ACTIVITY_STATE.building);
  assert.deepEqual(view.activeBuild, { jobId: "job-1", projectId: "project-1" });
});

test("V2-only schema removes the obsolete V1 server identity and web supports durable retry", async () => {
  const [migration, jobs, card, shell] = await Promise.all([
    readFile(new URL("../../supabase/migrations/20260815095256_drop_v1_build_job_server_id.sql", import.meta.url), "utf8"),
    readFile(new URL("../../shell/server/lib/buildJobs.mjs", import.meta.url), "utf8"),
    readFile(new URL("../../shell/web/src/chat/BuildBudgetApprovalCard.jsx", import.meta.url), "utf8"),
    readFile(new URL("../../shell/web/src/chat/ChatShell.jsx", import.meta.url), "utf8"),
  ]);
  assert.match(migration, /pipeline_version is distinct from 'v2'/i);
  assert.match(migration, /drop column if exists server_id/i);
  assert.match(migration, /create unique index build_jobs_budget_approval_uq/i);
  assert.match(migration, /create unique index projects_budget_approval_uq/i);
  assert.doesNotMatch(jobs, /server_id\s*:/i);
  assert.match(card, /Retry starting approved build/);
  assert.match(card, /getBuildBudgetApproval/);
  assert.match(card, /next\.resuming/);
  assert.match(card, /onBuildAccepted\?\.\(result\.build\)/);
  assert.match(shell, /acceptApprovedBuild/);
  assert.match(shell, /watchBuild\(build\)/);
});
