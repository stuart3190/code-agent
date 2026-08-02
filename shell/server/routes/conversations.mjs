import { CodeAgentInputError } from "../lib/codeAgentContracts.mjs";
import { conversationStore } from "../lib/conversationStore.mjs";
import { postUserMessage } from "../lib/leadAgentService.mjs";

export async function handleConversations(req, res, { owner, method, body }) {
  const store = conversationStore();
  if (method === "GET") {
    const rows = await store.listConversations(owner.id);
    // Publish state travels WITH the card rather than being joined client-side. The dashboard and
    // the conversation both read the same derivation, so a project cannot appear live in one place
    // and draft in the other — which is exactly what happened when the badge was UI-only.
    let publishByProduct = new Map();
    try {
      const { publishStates } = await import("../lib/publishState.mjs");
      publishByProduct = new Map(
        (await publishStates(owner.id)).filter((s) => s.productId).map((s) => [s.productId, s]),
      );
    } catch (error) {
      console.error(`[conversations] publish state unavailable: ${error?.message || error}`);
    }
    // Workspace home: each conversation carries its live activity (who's working + on
    // what), derived from the durable event stream — the same truth the thread shows.
    const conversations = await Promise.all(rows.slice(0, 20).map(async (row) => {
      const summary = publicConversation(row);
      // Never published → draft. That is a status, not an absence, and the dashboard filters on it.
      const site = row.product_id ? publishByProduct.get(String(row.product_id)) || null : null;
      summary.publishStatus = site?.status || "draft";
      summary.site = site;
      try {
        const events = await store.listEvents(owner.id, row.id, 0);
        const working = new Map();
        let lastStatus = null;
        for (const event of events || []) {
          if (event.type === "agent_spawned" || event.type === "agent_status") {
            working.set(event.payload?.agent, event.payload?.status || "");
            lastStatus = { agent: event.payload?.agent, status: event.payload?.status || "" };
          }
          if (event.type === "agent_done") working.delete(event.payload?.agent);
          if (event.type === "verification") summary.verified = event.payload?.pass === true;
          if (event.type === "lead_error") summary.failed = true;
          if (event.type === "preview_ready") summary.hasPreview = true;
        }
        const active = [...working.entries()].filter(([agent]) => agent && agent !== "Lead Agent");
        if (active.length) {
          const [agent, status] = active[active.length - 1];
          summary.activity = { agent, status: status || lastStatus?.status || "Working…" };
        }
      } catch { /* activity is best-effort */ }
      return summary;
    }));
    return sendJson(res, 200, { conversations });
  }
  return wrap(async () => {
    const { conversation } = await postUserMessage(owner.id, {
      text: body?.text, workspaceContext: body?.workspaceContext || null,
      modelPref: body?.modelPref || null,
    });
    sendJson(res, 201, { conversation: publicConversation(conversation) });
  });
}

export async function handleConversationGet(_req, res, { owner, conversationId }) {
  const store = conversationStore();
  const conversation = await store.getConversation(owner.id, conversationId);
  if (!conversation) throw new CodeAgentInputError("Conversation not found", 404, "conversation_not_found");
  const turns = await store.listTurns(owner.id, conversationId, { limit: 100 });
  return sendJson(res, 200, {
    conversation: publicConversation(conversation),
    turns: (turns || []).map(publicTurn),
  });
}

export async function handleConversationMessage(_req, res, { owner, conversationId, body }) {
  return wrap(async () => {
    const { conversation } = await postUserMessage(owner.id, {
      conversationId,
      text: body?.text,
      workspaceContext: body?.workspaceContext || null,
    });
    sendJson(res, 202, { conversation: publicConversation(conversation) });
  });
}

export async function handleConversationEvents(req, res, { owner, conversationId, url }) {
  const store = conversationStore();
  const conversation = await store.getConversation(owner.id, conversationId);
  if (!conversation) throw new CodeAgentInputError("Conversation not found", 404, "conversation_not_found");
  const headerAfter = Number(req.headers["last-event-id"] || 0);
  const after = Math.max(Number(url.searchParams.get("after") || headerAfter || 0), 0);
  const existing = await store.listEvents(owner.id, conversationId, after);

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();
  for (const event of existing || []) writeEvent(res, event);

  const unsubscribe = store.subscribe(conversationId, (event) => writeEvent(res, event));
  const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 15_000);
  heartbeat.unref?.();
  req.on("close", () => { clearInterval(heartbeat); unsubscribe(); });
}

function writeEvent(res, event) {
  res.write(`id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

function publicConversation(row) {
  return {
    id: row.id,
    title: row.title,
    state: row.state,
    productId: row.product_id,
    modelPref: row.model_pref || "auto",
    lastActivityAt: row.last_activity_at,
    createdAt: row.created_at,
  };
}

function publicTurn(row) {
  return {
    sequence: row.sequence,
    role: row.role,
    specialist: row.specialist,
    content: row.content,
    payload: row.payload || {},
    createdAt: row.created_at,
  };
}

async function wrap(fn) {
  try {
    return await fn();
  } catch (error) {
    if (error.status || error.code) {
      throw new CodeAgentInputError(error.message, error.status || 400, error.code || "conversation_failed");
    }
    throw error;
  }
}

function sendJson(res, code, value) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(value));
}
