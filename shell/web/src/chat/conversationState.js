// The conversation event reducer — the entire thread, roster, and preview state of the
// Phase 21 shell is DERIVED from the durable ca_conversation_events stream (the same
// replay the Lead Agent itself recovers from). Pure functions, unit-tested in
// test/code-agent/chat-shell.test.mjs.

import { ACTIVITY_STATE, activityFromJob, isActiveActivity } from "./activityState.js";

export const SPECIALIST_HUES = {
  "Lead Agent": "var(--agent-lead)",
  Planner: "var(--agent-planner)",
  Designer: "var(--agent-designer)",
  Builder: "var(--agent-builder)",
  Tester: "var(--agent-tester)",
  Publisher: "var(--agent-publisher)",
  Reviewer: "var(--agent-tester)",
};

export function agentInitials(name) {
  const parts = String(name || "?").split(/\s+/).filter(Boolean);
  return parts.length > 1 ? (parts[0][0] + parts[1][0]).toUpperCase() : String(name || "?").slice(0, 2);
}

export function emptyConversationView() {
  return {
    items: [],          // ordered thread items: {kind, seq, ...}
    roster: [],         // [{agent, status, state: working|done|failed}] in spawn order
    previewUrl: null,
    thinking: false,    // Lead Agent mid-turn
    waiting: false,     // paused on a business question
    recovery: null,     // {state: recovering|repairing|verifying|continuing, message}
    badge: null,        // {icon, text} — which model is building right now
    buildReference: null, // last build_started identity; historical until the job endpoint confirms it
    buildJob: null,     // durable public job snapshot
    buildActivity: ACTIVITY_STATE.idle,
    activeBuild: null,  // {jobId, projectId} only after a non-terminal job is confirmed
    lastSeq: 0,
  };
}

function upsertAgent(roster, agent, patch) {
  const existing = roster.find((r) => r.agent === agent);
  if (existing) return roster.map((r) => (r.agent === agent ? { ...r, ...patch } : r));
  return [...roster, { agent, status: "", state: "working", ...patch }];
}

// One event → next view. Mirrors the wireframe choreography exactly: the roster and the
// rail's three states are pure functions of the event stream.
export function applyEvent(view, event) {
  const seq = Number(event.sequence || 0);
  const next = { ...view, lastSeq: Math.max(view.lastSeq, seq) };
  const payload = event.payload || {};
  const push = (item) => { next.items = [...next.items, { seq, ...item }]; };

  switch (event.type) {
    case "message":
      push({
        kind: "message", role: payload.role === "user" ? "user" : "lead", text: payload.text || "",
        ...(payload.workspaceContext ? { workspaceContext: payload.workspaceContext } : {}),
      });
      if (payload.role !== "user") next.thinking = false;
      else { next.thinking = true; next.waiting = false; }
      break;
    case "agent_spawned":
      next.roster = upsertAgent(next.roster, payload.agent, { status: payload.status || "", state: "working" });
      break;
    case "agent_status":
      next.roster = upsertAgent(next.roster, payload.agent, { status: payload.status || "" });
      break;
    case "agent_done":
      next.roster = upsertAgent(next.roster, payload.agent, {
        state: payload.ok === false ? "failed" : "done",
      });
      if (payload.agent === "Lead Agent") next.thinking = false;
      break;
    case "plan.created":
      push({ kind: "plan", title: payload.title || "Plan", steps: payload.steps || [] });
      break;
    // Provider badge: which model is doing the work right now (and switches).
    case "provider_badge":
      next.badge = { icon: payload.icon || "🤖", text: payload.text || "", switched: !!payload.switched };
      if (payload.switched) push({ kind: "receipt", text: `${payload.icon || "⚡"} ${payload.text}` });
      break;
    case "quota_warning":
      break; // the accompanying plain-language message carries the meaning
    case "model_changed":
      push({
        kind: "receipt",
        text: payload.value === "auto"
          ? "Model set to Auto smart routing — affects future requests only."
          : `Model set to ${String(payload.value || "").replace(":", " · ")} — affects future requests only.`,
      });
      break;
    case "run_linked":
      push({ kind: "receipt", text: payload.message || `Run started on ${payload.repository || "the repository"}` });
      break;
    case "build_started":
      // An event log is history, not liveness. Retain the identity so the client can read the
      // owner-scoped durable job, but do not show/cancel work until that read proves non-terminal.
      next.buildReference = { jobId: payload.jobId || null, projectId: payload.projectId || null };
      next.buildJob = null;
      next.buildActivity = ACTIVITY_STATE.idle;
      next.activeBuild = null;
      break;
    case "verification_pending":
    case "verification_failed":
      // Ordinary repair churn stays one calm customer-facing checking phase.
      if (next.activeBuild) next.buildActivity = ACTIVITY_STATE.checking;
      break;
    case "preview_ready":
      next.previewUrl = payload.url || next.previewUrl;
      next.buildActivity = ACTIVITY_STATE.ready;
      next.activeBuild = null;
      next.roster = next.roster.map((agent) => (
        agent.state === "working" && agent.agent !== "Lead Agent" ? { ...agent, state: "done" } : agent
      ));
      push({ kind: "preview", url: payload.url, projectId: payload.projectId || null });
      break;
    case "published":
      push({
        kind: "published",
        url: payload.url,
        // Names the version. The address and the actions belong to the panel above the thread —
        // this is the conversational record that it happened, not a second copy of the panel.
        text: payload.deploymentNumber
          ? `Deployment #${payload.deploymentNumber} is live`
          : payload.note || `Live at ${String(payload.url || "").replace(/^https?:\/\//, "").replace(/\/$/, "")}`,
      });
      break;
    // A connected domain is a DNS task, not a sentence. The records are shown as copyable rows
    // because that is what the person has to do next, and prose they must retype is a worse
    // version of the panel that already exists.
    case "domain":
      push({
        kind: "domain",
        domain: payload.domain || "",
        status: payload.status || "pending_dns",
        records: payload.records || [],
        projectId: payload.projectId || null,
      });
      break;
    case "question_asked":
      push({ kind: "question", question: payload.question || "", consequence: payload.businessConsequence || "" });
      next.waiting = true;
      next.thinking = false;
      break;
    case "budget_approval_required":
      push({
        kind: "budget_approval",
        approval: {
          approvalId: payload.approvalId || null,
          requestSummary: payload.requestSummary || payload.summary || "",
          complexity: payload.complexity || "advanced",
          ceilingCredits: payload.ceilingCredits ?? 0,
          availableCredits: payload.availableCredits || { included: 0, purchased: 0 },
          expiresAt: payload.expiresAt || null,
          status: payload.status || "pending",
        },
      });
      next.waiting = true;
      next.thinking = false;
      break;
    case "budget_approval_resolved": {
      let matched = false;
      next.items = next.items.map((item) => {
        if (item.kind !== "budget_approval" || item.approval?.approvalId !== payload.approvalId) return item;
        matched = true;
        return { ...item, approval: { ...item.approval, ...payload } };
      });
      // A compacted stream may start at the resolution. It remains useful as a durable receipt
      // even when its original approval card is outside the retained event window.
      if (!matched) {
        push({
          kind: "receipt",
          text: payload.status === "approved" || payload.status === "consumed"
            ? "Large build budget approved."
            : payload.status === "expired"
              ? "Large build approval expired — nothing was started."
              : payload.status === "cancelled"
                ? "Large build request cancelled — nothing was started."
                : "Large build request declined — nothing was started.",
        });
      }
      next.waiting = false;
      break;
    }
    // Recovery states: subtle, honest, never technical. "failed" is handled by lead_error.
    case "recovery":
      if (payload.state && payload.state !== "failed") {
        next.recovery = { state: payload.state, message: payload.message || "" };
      } else {
        next.recovery = null;
      }
      break;
    /**
     * The server gave up on a turn and reset the conversation so it can be continued.
     *
     * This case did not exist, so `lead_recovered` fell through to `default` and was ignored as
     * "future vocabulary". The recovery sweeper was working correctly — it flipped the stuck
     * conversation back to idle after five minutes and said so — and the screen never found out.
     * The roster kept showing "Lead Agent · Understanding request…" and `thinking` stayed true,
     * which is exactly what a customer saw for ten minutes and more.
     *
     * Every agent is marked done, not just the Lead Agent: a specialist that was mid-work when the
     * process died would otherwise spin forever beside a thread that has moved on.
     */
    case "lead_recovered":
      next.roster = next.roster.map((agent) => (
        agent.state === "working" ? { ...agent, state: "done" } : agent
      ));
      next.thinking = false;
      next.waiting = false;
      next.recovery = null;
      next.activeBuild = null;
      next.buildActivity = ACTIVITY_STATE.failed;
      push({
        kind: "failure",
        text: payload.message
          || "I lost my train of thought during a restart — everything above is saved. Tell me to continue.",
        reference: payload.reference || null,
      });
      break;
    case "lead_error":
    case "lead_agent_failed":
      // The server sends only sanitised copy plus a support reference — never raw errors.
      push({
        kind: "failure",
        text: payload.message
          || "I couldn't resolve this automatically. Your work is safe and the technical details have been saved for support.",
        reference: payload.reference || null,
      });
      next.recovery = null;
      next.thinking = false;
      next.activeBuild = null;
      next.buildActivity = ACTIVITY_STATE.failed;
      break;
    default:
      break; // unknown events are future vocabulary — ignore, never crash
  }
  return next;
}

// Merge a snapshot/phase/end frame from /api/builds/:jobId/events into the conversation view.
// This is the authoritative liveness check used on first open, refresh, and reconnect.
export function applyBuildUpdate(view, update) {
  const incomingId = update?.jobId || view.buildJob?.jobId || null;
  if (view.buildReference?.jobId && incomingId && String(incomingId) !== String(view.buildReference.jobId)) {
    return view; // a superseded watcher finished after a newer build_started event
  }
  const job = { ...(view.buildJob || {}), ...(update || {}) };
  const resolved = activityFromJob(job);
  const active = isActiveActivity(resolved.state);
  const next = {
    ...view,
    buildJob: job,
    buildActivity: resolved.state,
    activeBuild: active ? {
      jobId: job.jobId || view.buildReference?.jobId || null,
      projectId: job.projectId || view.buildReference?.projectId || null,
    } : null,
  };
  if (!active) {
    const failed = [ACTIVITY_STATE.failed, ACTIVITY_STATE.cancelled].includes(resolved.state);
    next.roster = next.roster.map((agent) => (
      agent.state === "working" && agent.agent !== "Lead Agent"
        ? { ...agent, state: failed ? "failed" : "done" }
        : agent
    ));
  }
  return next;
}

export function replayEvents(events) {
  let view = emptyConversationView();
  for (const event of events || []) view = applyEvent(view, event);
  return view;
}

// Rail state (the "living rail": empty → team → team+preview) is derived, never stored.
export function railState(view) {
  if (view.previewUrl) return "preview";
  if (view.roster.length) return "team";
  return "empty";
}

// Begin-screen chips from the conversation list: continue the most recent conversations,
// the newest first, with a live dot when its preview is still recorded.
export function beginChips(conversations) {
  return (conversations || [])
    .slice(0, 2)
    .map((c) => ({ id: c.id, label: c.title ? `Continue ${c.title}` : "Continue where we left off" }));
}
