// Customer-facing activity is reconstructed from durable build jobs, never inferred from old
// progress copy. The conversation event log is historical; a phrase such as "Writing the code"
// proves only that work happened once, not that it is happening now.

export const ACTIVITY_STATE = Object.freeze({
  idle: "IDLE",
  building: "BUILDING",
  checking: "CHECKING",
  finishing: "FINISHING",
  ready: "READY",
  failed: "FAILED",
  cancelled: "CANCELLED",
});

const ACTIVE_JOB_STATUSES = new Set(["queued", "running"]);
const CHECKING_PHASES = /check|test|verif|quality|review|browser/i;
const FINISHING_PHASES = /final|polish|publish|preview|packag|deploy/i;
const CANCEL_REASONS = /cancel/i;

export function isActiveActivity(state) {
  return [ACTIVITY_STATE.building, ACTIVITY_STATE.checking, ACTIVITY_STATE.finishing].includes(state);
}

export function activityLabel(state) {
  switch (state) {
    case ACTIVITY_STATE.building: return "Building…";
    case ACTIVITY_STATE.checking: return "Checking everything…";
    case ACTIVITY_STATE.finishing: return "Finishing up…";
    case ACTIVITY_STATE.ready: return "Ready";
    case ACTIVITY_STATE.failed: return "Needs attention";
    case ACTIVITY_STATE.cancelled: return "Cancelled";
    default: return "Idle";
  }
}

export function activityFromJob(job) {
  if (!job) return { state: ACTIVITY_STATE.idle, label: activityLabel(ACTIVITY_STATE.idle) };
  const status = String(job.status || "").toLowerCase();
  const phase = String(job.phase || "");

  if (!ACTIVE_JOB_STATUSES.has(status)) {
    let state = ACTIVITY_STATE.idle;
    if (status === "complete") state = ACTIVITY_STATE.ready;
    else if (CANCEL_REASONS.test(String(job.stopReason || "")) || CANCEL_REASONS.test(String(job.error || ""))) {
      state = ACTIVITY_STATE.cancelled;
    } else if (["failed", "interrupted"].includes(status)) state = ACTIVITY_STATE.failed;
    return { state, label: activityLabel(state) };
  }

  let state = ACTIVITY_STATE.building;
  if (CHECKING_PHASES.test(phase)) state = ACTIVITY_STATE.checking;
  else if (FINISHING_PHASES.test(phase)) state = ACTIVITY_STATE.finishing;
  return { state, label: activityLabel(state) };
}

export function projectActivity(project) {
  // Conversation summaries carry the owner-scoped durable job directly. This is the dashboard
  // authority: unlike historical specialist events it survives refresh and cannot leave a
  // completed build looking live.
  if (project?.activeBuild) return activityFromJob(project.activeBuild);
  if (project?.activityState) {
    return { state: project.activityState, label: activityLabel(project.activityState) };
  }
  // Terminal product evidence always outranks historical progress text.
  if (project?.verified || project?.hasPreview) {
    return { state: ACTIVITY_STATE.ready, label: activityLabel(ACTIVITY_STATE.ready) };
  }
  if (project?.cancelled) {
    return { state: ACTIVITY_STATE.cancelled, label: activityLabel(ACTIVITY_STATE.cancelled) };
  }
  if (project?.failed) {
    return { state: ACTIVITY_STATE.failed, label: activityLabel(ACTIVITY_STATE.failed) };
  }
  if (project?.buildJob) return activityFromJob(project.buildJob);
  if (project?.state === "waiting_user") {
    return { state: ACTIVITY_STATE.idle, label: "Waiting for your input" };
  }
  return { state: ACTIVITY_STATE.idle, label: activityLabel(ACTIVITY_STATE.idle) };
}

// The server has already done the owner-scoped build lookup in the conversation-list query. Keep
// the specialist name as presentation only, but discard its historical activity claim unless the
// attached durable job is genuinely live. Dashboard badges and grouping still consume `activity`.
export function normalizeProjectSummary(project) {
  const reported = project?.activity || null;
  const job = project?.activeBuild || null;
  const resolved = activityFromJob(job);
  if (!job || !isActiveActivity(resolved.state)) {
    return { ...project, reportedActivity: reported, activity: null, buildJob: null };
  }
  return {
    ...project,
    reportedActivity: reported,
    buildJob: job,
    activityState: resolved.state,
    activity: {
      agent: reported?.agent || null,
      status: resolved.label,
      projectId: job.projectId || reported?.projectId || null,
      jobId: job.jobId || null,
    },
  };
}

/**
 * Validate dashboard activity against the existing owner-scoped build endpoint.
 *
 * The list API currently omits the job/project ids on some draft cards. Those cards deliberately
 * settle to idle instead of treating unverified historical copy as live work. Once an id is
 * available, the durable job is authoritative.
 */
export async function reconstructProjectActivity(project, loadProjectBuild) {
  const reported = project?.activity || null;
  const projectId = reported?.projectId || project?.projectId || project?.site?.projectId || null;
  const base = { ...project, reportedActivity: reported, activity: null, buildJob: null };

  if (reported && projectId && typeof loadProjectBuild === "function") {
    try {
      const result = await loadProjectBuild(projectId);
      const job = result?.job || null;
      const resolved = activityFromJob(job);
      if (isActiveActivity(resolved.state)) {
        return {
          ...base,
          buildJob: job,
          activityState: resolved.state,
          // Existing grouping/badge code consumes `activity`; keep it only after live-job proof.
          activity: { agent: reported.agent || null, status: resolved.label, projectId, jobId: job?.jobId || null },
        };
      }
      // A previous ready preview remains the useful final result even if a later attempt stopped.
      if (project?.verified || project?.hasPreview) {
        return { ...base, buildJob: job, activityState: ACTIVITY_STATE.ready };
      }
      return { ...base, buildJob: job, activityState: resolved.state };
    } catch {
      // A read failure is not evidence of work. Fall through to durable product evidence.
    }
  }

  if (project?.verified || project?.hasPreview) return { ...base, activityState: ACTIVITY_STATE.ready };
  if (project?.cancelled) return { ...base, activityState: ACTIVITY_STATE.cancelled };
  if (project?.failed) return { ...base, activityState: ACTIVITY_STATE.failed };
  return { ...base, activityState: ACTIVITY_STATE.idle };
}

export async function reconstructProjectActivities(projects, loadProjectBuild) {
  return Promise.all((projects || []).map((project) => reconstructProjectActivity(project, loadProjectBuild)));
}
