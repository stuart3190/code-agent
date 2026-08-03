import { CodeAgentInputError } from "../lib/codeAgentContracts.mjs";
import { conversationStore } from "../lib/conversationStore.mjs";
import { postUserMessage } from "../lib/leadAgentService.mjs";
import { resolvePublishState } from "../../shared/publishResolution.mjs";

const PAGE_SIZE = 20;
const MAX_PAGE = 100;

// Which statuses each dashboard tab covers. Filtering happens HERE rather than on the client,
// because the client only ever holds one page — filtering a page and calling it a filter would
// silently hide everything after it.
const TAB_STATUSES = Object.freeze({
  all: null,
  drafts: ["draft", "unpublished"],
  published: ["published"],
  updates: ["update_available"],
});

export async function handleConversations(req, res, { owner, method, body, url = null }) {
  const store = conversationStore();
  if (method === "GET") {
    const rows = await store.listConversations(owner.id);
    // Publish state travels WITH the card rather than being joined client-side. The dashboard and
    // the conversation both read the same derivation, so a project cannot appear live in one place
    // and draft in the other — which is exactly what happened when the badge was UI-only.
    let publish = resolvePublishState([]);
    let healthByProject = new Map();
    try {
      const { publishStates } = await import("../lib/publishState.mjs");
      // The SHARED resolver. This route used to build its own Map, which for a product with two
      // published rows took the last one, while the web app's `.find()` took the first — the same
      // project could read UNPUBLISHED on its card and LIVE in the panel above it.
      publish = resolvePublishState(await publishStates(owner.id));
      if (publish.conflicts.length) {
        // Loud, and named: two live records for one product is a data fault the platform must not
        // quietly pick a winner for forever. ops/repair-publish-state.mjs fixes it.
        console.error(`[conversations] publish conflicts for ${owner.id}: ${JSON.stringify(publish.conflicts)}`);
      }
      const { healthForOwner } = await import("../lib/health/report.mjs");
      healthByProject = await healthForOwner(owner.id);
    } catch (error) {
      console.error(`[conversations] publish state unavailable: ${error?.message || error}`);
    }

    // Status is resolved for EVERY conversation before paging, so a tab count and a filtered page
    // describe the same set. Counting only the current page would report "Published 3" on a list
    // of forty.
    const withStatus = rows.map((row) => ({
      row,
      status: publish.statusFor({ productId: row.product_id }),
      site: publish.site({ productId: row.product_id }),
    }));

    const counts = { all: withStatus.length };
    for (const [tab, statuses] of Object.entries(TAB_STATUSES)) {
      if (statuses) counts[tab] = withStatus.filter((c) => statuses.includes(c.status)).length;
    }

    const params = url?.searchParams;
    const tab = params?.get("tab") || "all";
    const search = (params?.get("q") || "").trim().toLowerCase();
    const offset = Math.max(0, Number(params?.get("offset") || 0) || 0);
    const limit = Math.min(MAX_PAGE, Math.max(1, Number(params?.get("limit") || PAGE_SIZE) || PAGE_SIZE));

    const statuses = TAB_STATUSES[tab] || null;
    const matching = withStatus.filter((c) => {
      if (statuses && !statuses.includes(c.status)) return false;
      if (!search) return true;
      return String(c.row.title || "").toLowerCase().includes(search)
        || String(c.site?.slug || "").toLowerCase().includes(search);
    });

    // Sorted before paging, so page two continues page one rather than re-shuffling. listConversations
    // already orders by activity; this makes the guarantee explicit rather than inherited.
    matching.sort((a, b) =>
      Date.parse(b.row.last_activity_at || b.row.updated_at || 0)
      - Date.parse(a.row.last_activity_at || a.row.updated_at || 0));

    const page = matching.slice(offset, offset + limit);

    // Workspace home: each conversation carries its live activity (who's working + on
    // what), derived from the durable event stream — the same truth the thread shows.
    const conversations = await Promise.all(page.map(async ({ row, status, site }) => {
      const summary = publicConversation(row);
      // Never published → draft. That is a status, not an absence, and the dashboard filters on it.
      summary.publishStatus = status;
      summary.site = site;
      // Health rides with the card too, so the dashboard renders in one request rather than one
      // per project. A site with no check yet has no health — not a green badge it has not earned.
      summary.health = site ? healthByProject.get(site.projectId) || null : null;
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
    return sendJson(res, 200, {
      conversations,
      // Counts are over the WHOLE list, not the page, so the tabs stay honest past the first page.
      counts,
      page: {
        offset,
        limit,
        total: matching.length,
        // Null rather than a boolean: the client asks for exactly this offset next, so paging
        // cannot drift out of step with what the server considers the next page.
        nextOffset: offset + page.length < matching.length ? offset + page.length : null,
        tab,
        search: search || null,
      },
    });
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
