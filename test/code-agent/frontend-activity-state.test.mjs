import assert from "node:assert/strict";
import test from "node:test";

import {
  ACTIVITY_STATE, activityFromJob, projectActivity, reconstructProjectActivity,
} from "../../shell/web/src/chat/activityState.js";
import {
  applyBuildUpdate, emptyConversationView, replayEvents,
} from "../../shell/web/src/chat/conversationState.js";

const event = (sequence, type, payload = {}) => ({ sequence, type, payload });

test("opening the dashboard does not trust historical progress copy", async () => {
  let reads = 0;
  const project = await reconstructProjectActivity({
    id: "c-idle", state: "idle",
    activity: { agent: "Builder", status: "Writing the code…" },
  }, async () => { reads += 1; return { job: null }; });

  assert.equal(reads, 0, "a card without a project/job identity cannot prove live work");
  assert.equal(project.activity, null);
  assert.deepEqual(projectActivity(project), { state: ACTIVITY_STATE.idle, label: "Idle" });
});

test("completed project evidence outranks stale historical activity", async () => {
  const project = await reconstructProjectActivity({
    id: "c-ready", state: "idle", verified: true, hasPreview: true,
    activity: { agent: "Publisher", status: "Preparing your preview…", projectId: "p-ready" },
  }, async () => ({ job: { jobId: "j-old", status: "complete", phase: "complete" } }));

  assert.equal(project.activity, null);
  assert.equal(projectActivity(project).state, ACTIVITY_STATE.ready);
});

test("a genuine running update remains active even when an older preview is ready", async () => {
  const project = await reconstructProjectActivity({
    id: "c-update", verified: true, hasPreview: true,
    activity: { agent: "Publisher", status: "Preparing your preview…", projectId: "p-update" },
  }, async () => ({ job: { jobId: "j-update", status: "running", phase: "finalizing" } }));

  assert.equal(projectActivity(project).state, ACTIVITY_STATE.finishing);
  assert.equal(project.activity.status, "Finishing up…");
});

test("only a genuine non-terminal job displays ordinary customer activity", async () => {
  const project = await reconstructProjectActivity({
    id: "c-run", activity: { agent: "Builder", status: "repair attempt 2", projectId: "p-run" },
  }, async () => ({ job: { jobId: "j-run", projectId: "p-run", status: "running", phase: "quality-checking" } }));

  assert.equal(projectActivity(project).state, ACTIVITY_STATE.checking);
  assert.equal(project.activity.status, "Checking everything…");
  assert.doesNotMatch(project.activity.status, /repair|verification failure|regenerating/i);
});

test("a completed job transitions back to ready", async () => {
  const source = {
    id: "c-transition", activity: { agent: "Builder", status: "Writing the code…", projectId: "p-transition" },
  };
  const running = await reconstructProjectActivity(source, async () => ({
    job: { jobId: "j-transition", projectId: "p-transition", status: "running", phase: "running" },
  }));
  const completed = await reconstructProjectActivity(source, async () => ({
    job: { jobId: "j-transition", projectId: "p-transition", status: "complete", phase: "complete" },
  }));

  assert.equal(projectActivity(running).state, ACTIVITY_STATE.building);
  assert.equal(running.activity.status, "Building…");
  assert.equal(projectActivity(completed).state, ACTIVITY_STATE.ready);
  assert.equal(completed.activity, null);
});

test("cancelled and failed historical jobs never remain in progress", () => {
  assert.equal(activityFromJob({ status: "failed", stopReason: "cancelled" }).state, ACTIVITY_STATE.cancelled);
  assert.equal(activityFromJob({ status: "interrupted", error: "worker stopped" }).state, ACTIVITY_STATE.failed);
  assert.equal(projectActivity({ cancelled: true, activity: { status: "Writing the code…" } }).state, ACTIVITY_STATE.cancelled);
  assert.equal(projectActivity({ failed: true, activity: { status: "Running quality checks…" } }).state, ACTIVITY_STATE.failed);
});

test("refresh and reconnect reconstruct conversation liveness from the durable job", () => {
  const history = [
    event(1, "message", { role: "user", text: "Build it" }),
    event(2, "build_started", { jobId: "j-reconnect", projectId: "p-reconnect" }),
    event(3, "agent_spawned", { agent: "Builder", status: "Writing the code…" }),
  ];
  const replayed = replayEvents(history);
  assert.equal(replayed.activeBuild, null, "historical build_started is not live proof");

  const running = applyBuildUpdate(replayed, {
    jobId: "j-reconnect", projectId: "p-reconnect", status: "running", phase: "running",
  });
  assert.deepEqual(running.activeBuild, { jobId: "j-reconnect", projectId: "p-reconnect" });

  const settled = applyBuildUpdate(running, {
    jobId: "j-reconnect", projectId: "p-reconnect", status: "failed", phase: "failed", stopReason: "cancelled",
  });
  assert.equal(settled.activeBuild, null);
  assert.equal(settled.buildActivity, ACTIVITY_STATE.cancelled);
  assert.equal(settled.roster.find((row) => row.agent === "Builder").state, "failed");

  assert.deepEqual(emptyConversationView().activeBuild, null);
});
