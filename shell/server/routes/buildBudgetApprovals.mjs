import { buildBudgetApprovals } from "../lib/builderV2/buildBudgetApprovals.mjs";
import { startAppBuildV2 } from "../lib/builderV2/entry.mjs";
import { conversationStore } from "../lib/conversationStore.mjs";
import { CodeAgentInputError } from "../lib/codeAgentContracts.mjs";

const sendJson = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

const publicApproval = (approval) => {
  if (!approval) return null;
  const { requestPayload, decisionChanged, ...result } = approval;
  void requestPayload;
  void decisionChanged;
  return result;
};

const ACTIVE_BUILD = new Set(["queued", "running"]);
const SUCCESSFUL_BUILD = new Set(["complete"]);

function resumeFailure(error, build = null) {
  if (build?.status === "failed" || build?.status === "interrupted") {
    return {
      code: build.stopReason || "approved_build_failed",
      message: build.error || "The approved build reached the worker queue but could not start.",
      status: 409,
    };
  }
  const known = {
    worker_required: "The approved build could not start because the isolated Builder V2 worker is unavailable.",
    worker_version_mismatch: "The approved build could not start because no worker matches the deployed release.",
    preview_isolation_required: "The approved build could not start because no worker has a fresh passing isolated-preview proof.",
    builder_v2_killed: "The approved build could not start because Builder V2 is temporarily paused.",
    settlement_paused: "The approved build could not start because managed model settlement is temporarily paused.",
    budget_exceeded: "The approval was saved, but the approved build budget is no longer available.",
    build_job_create_failed: "The approval was saved, but Thrallo could not create its durable build job.",
  };
  const code = error?.code && known[error.code] ? error.code : "approved_build_resume_failed";
  return {
    code,
    message: known[code] || error?.publicMessage
      || "The approval was saved, but Thrallo could not create its durable build job.",
    status: Number(error?.status) >= 400 ? Number(error.status) : 503,
  };
}

async function appendLeadState(store, conversation, text, payload) {
  try {
    await store.appendTurn(conversation, { role: "lead", content: text, payload });
    await store.appendEvent(conversation, "message", { role: "lead", text, ...payload });
  } catch (error) {
    // A durable build outcome must not be relabelled as failed because its conversational receipt
    // raced or temporarily failed. build_started/resolution events remain the UI authority.
    console.error(`[build-approvals] conversation receipt failed: ${error.message}`);
  }
}

async function appendResumeFailure(store, conversation, approval, failure, build) {
  const payload = {
    approvalId: approval.approvalId,
    status: approval.status,
    ceilingCredits: approval.ceilingCredits,
    code: failure.code,
    message: failure.message,
    build: build || null,
  };
  try {
    await store.appendEvent(conversation, "budget_approval_resume_failed", payload);
  } catch (eventError) {
    console.error(`[build-approvals] resume failure event failed: ${eventError.message}`);
  }
  await appendLeadState(store, conversation, failure.message, {
    approvalId: approval.approvalId, approvalStatus: approval.status, buildResumeFailed: true,
  });
}

async function ensureDispatchEvents(store, conversation, approval, build) {
  if (!build) return;
  try {
    const events = await store.listEvents(conversation.owner, conversation.id, 0) || [];
    const hasBuildStarted = events.some((event) => event.type === "build_started"
      && String(event.payload?.jobId) === String(build.jobId));
    if (!hasBuildStarted) {
      await store.appendEvent(conversation, "build_started", {
        jobId: build.jobId,
        projectId: build.projectId,
        pipelineVersion: "v2",
        message: "Builder V2 is assembling the app.",
      });
    }
    const hasResolution = events.some((event) => event.type === "budget_approval_resolved"
      && String(event.payload?.approvalId) === String(approval.approvalId)
      && event.payload?.status === "consumed");
    if (!hasResolution) {
      await store.appendEvent(conversation, "budget_approval_resolved", {
        approvalId: approval.approvalId,
        status: "consumed",
        ceilingCredits: approval.ceilingCredits,
      });
    }
  } catch (error) {
    console.error(`[build-approvals] dispatch event recovery failed: ${error.message}`);
  }
}

export async function resolveBuildBudgetApproval({ owner, approvalId, action, deps = {} }) {
  const approvals = deps.approvals || buildBudgetApprovals();
  const store = deps.store || conversationStore();
  const startBuild = deps.startBuild || startAppBuildV2;
  const approval = await approvals.resolve(owner.id, approvalId, action);
  if (!approval) throw new CodeAgentInputError("Build budget approval not found", 404, "approval_not_found");
  const conversation = await store.getConversation(owner.id, approval.conversationId);
  if (!conversation) throw new CodeAgentInputError("Project conversation not found", 404, "conversation_not_found");

  if (action !== "approve" || !["approved", "consumed"].includes(approval.status)) {
    if (approval.decisionChanged) {
      await store.appendEvent(conversation, "budget_approval_resolved", {
        approvalId: approval.approvalId,
        status: approval.status,
        ceilingCredits: approval.ceilingCredits,
      });
    }
    return { status: 200, body: { approval: publicApproval(approval) } };
  }

  // A repeated click or reconnect after the winning request consumed the approval is a read, not
  // another dispatch. The build_jobs budget_approval_id is the durable idempotency authority even
  // if attaching the convenience IDs to the approval row was interrupted.
  if (approval.status === "consumed") {
    const current = await approvals.getDispatch(owner.id, approvalId);
    return {
      status: current?.build && SUCCESSFUL_BUILD.has(current.build.status) ? 200 : 202,
      body: {
        approval: publicApproval(current?.approval || approval),
        build: current?.build || null,
        resuming: !current?.build,
      },
    };
  }

  const ctx = {
    owner: owner.id,
    conversation,
    conversations: store,
    emit: (type, payload) => store.appendEvent(conversation, type, payload),
  };
  try {
    const accepted = await startBuild(ctx, approval.requestPayload, {
      approvalId: approval.approvalId,
      deps: { approvalStore: approvals },
    });
    const consumed = { ...approval, status: "consumed" };
    const build = accepted.result?.jobId ? {
      status: "queued", phase: "queued", ...accepted.result,
    } : accepted.result;
    await appendLeadState(store, conversation,
      "Approval accepted. Builder V2 started the build automatically.",
      { approvalId: approval.approvalId, approvalStatus: "consumed", jobId: build?.jobId || null });
    return {
      status: 202,
      body: { approval: publicApproval(consumed), build },
    };
  } catch (error) {
    const current = await approvals.getDispatch(owner.id, approvalId).catch(() => null);
    const latest = current?.approval || await approvals.get(owner.id, approvalId);
    const build = current?.build || null;

    // Another concurrent approval request may have won consume+dispatch. Return that durable state
    // instead of turning the losing request into a second build or a misleading error.
    if (latest?.status === "consumed" && (!build || ACTIVE_BUILD.has(build.status) || SUCCESSFUL_BUILD.has(build.status))) {
      if (build) {
        await approvals.attachDispatch(owner.id, approvalId, {
          projectId: build.projectId, jobId: build.jobId,
        }).catch((attachError) => console.error(`[build-approvals] dispatch attach retry failed: ${attachError.message}`));
        await ensureDispatchEvents(store, conversation, latest, build);
      }
      return {
        status: build && SUCCESSFUL_BUILD.has(build.status) ? 200 : 202,
        body: { approval: publicApproval(latest), build, resuming: !build },
      };
    }

    const failedApproval = latest || approval;
    const failure = resumeFailure(error, build);
    if (failedApproval.status === "consumed" && build) {
      await approvals.attachDispatch(owner.id, approvalId, {
        projectId: build.projectId, jobId: build.jobId,
      }).catch((attachError) => console.error(`[build-approvals] failed dispatch attach retry failed: ${attachError.message}`));
      await ensureDispatchEvents(store, conversation, failedApproval, build);
    }
    await appendResumeFailure(store, conversation, failedApproval, failure, build);
    throw new CodeAgentInputError(failure.message, failure.status, failure.code);
  }
}

export async function handleBuildBudgetApprovalGet(_req, res, { owner, approvalId }) {
  const current = await buildBudgetApprovals().getDispatch(owner.id, approvalId);
  if (!current) throw new CodeAgentInputError("Build budget approval not found", 404, "approval_not_found");
  return sendJson(res, 200, {
    approval: publicApproval(current.approval),
    build: current.build,
    resuming: current.approval.status === "consumed" && !current.build,
  });
}

export async function handleBuildBudgetApprovalResolve(_req, res, { owner, approvalId, action }) {
  const result = await resolveBuildBudgetApproval({ owner, approvalId, action });
  return sendJson(res, result.status, result.body);
}
