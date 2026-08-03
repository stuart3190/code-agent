// The conversation event reducer — the entire thread, roster, and preview state of the
// Phase 21 shell is DERIVED from the durable ca_conversation_events stream (the same
// replay the Lead Agent itself recovers from). Pure functions, unit-tested in
// test/code-agent/chat-shell.test.mjs.

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
    activeBuild: null,  // {jobId, projectId} while a build runs — what Cancel addresses
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
      // The roster carries the progress; the thread stays sparse. The job id is retained so the
      // user can stop the work — without it the Cancel control has nothing to address.
      next.activeBuild = { jobId: payload.jobId || null, projectId: payload.projectId || null };
      break;
    case "preview_ready":
      next.previewUrl = payload.url || next.previewUrl;
      push({ kind: "preview", url: payload.url, projectId: payload.projectId || null });
      break;
    case "published":
      push({
        kind: "published",
        url: payload.url,
        text: payload.note || `Live at ${String(payload.url || "").replace(/^https?:\/\//, "").replace(/\/$/, "")}`,
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
    // Recovery states: subtle, honest, never technical. "failed" is handled by lead_error.
    case "recovery":
      if (payload.state && payload.state !== "failed") {
        next.recovery = { state: payload.state, message: payload.message || "" };
      } else {
        next.recovery = null;
      }
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
      break;
    default:
      break; // unknown events are future vocabulary — ignore, never crash
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
