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

// The event types a project card actually renders. Everything else is a large payload nobody reads.
const CARD_EVENT_TYPES = Object.freeze([
  "agent_spawned", "agent_status", "agent_done", "verification", "lead_error", "preview_ready",
]);

/**
 * How the list can be ordered.
 *
 * Favourites always come first whatever is chosen — pinning something and then losing it to an
 * alphabetical sort would make the pin pointless. Every comparator is total, with a stable id
 * tiebreak, so page two continues page one rather than re-shuffling.
 */
const SORTS = Object.freeze({
  activity: { label: "Last activity", compare: (a, b) => time(b.row.last_activity_at) - time(a.row.last_activity_at) },
  created: { label: "Newest", compare: (a, b) => time(b.row.created_at) - time(a.row.created_at) },
  name: { label: "Name", compare: (a, b) => String(a.row.title || "").localeCompare(String(b.row.title || ""), "en", { sensitivity: "base" }) },
  deployed: {
    label: "Last deployed",
    // Never deployed sorts last rather than first, which is what a 0 timestamp would do.
    compare: (a, b) => (time(b.site?.publishedAt) || -Infinity) - (time(a.site?.publishedAt) || -Infinity),
  },
});

const time = (value) => {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : 0;
};

export async function handleConversations(req, res, { owner, method, body, url = null }) {
  const store = conversationStore();
  if (method === "GET") {
    const params = url?.searchParams;
    const archived = params?.get("archived") === "1";
    // Every conversation, not the first twenty. The store used to impose a silent cap, so paging
    // above it could never reach a twenty-first project.
    const rows = await store.listConversations(owner.id, { archived });
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

    // Visitors today, for every project at once. One row per project per day in analytics_daily,
    // so this is a single small read rather than a query per card — and it is decoration, so a
    // failure leaves the number absent rather than failing the list.
    let visitorsByProject = new Map();
    try {
      const { serviceClient } = await import("../lib/supabase.mjs");
      const today = new Date().toISOString().slice(0, 10);
      const { data } = await serviceClient().from("analytics_daily")
        .select("project_id,visitors,pageviews")
        .eq("owner", owner.id).eq("dimension", "totals").eq("day", today);
      visitorsByProject = new Map((data || []).map((r) => [String(r.project_id), {
        visitors: r.visitors, pageviews: r.pageviews,
      }]));
    } catch (error) {
      console.error(`[conversations] visitors unavailable: ${error?.message || error}`);
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

    const tab = params?.get("tab") || "all";
    const search = (params?.get("q") || "").trim().toLowerCase();
    const favouritesOnly = params?.get("favourites") === "1";
    const sortKey = SORTS[params?.get("sort")] ? params.get("sort") : "activity";
    const offset = Math.max(0, Number(params?.get("offset") || 0) || 0);
    const limit = Math.min(MAX_PAGE, Math.max(1, Number(params?.get("limit") || PAGE_SIZE) || PAGE_SIZE));

    counts.favourites = withStatus.filter((c) => c.row.favourite).length;

    const statuses = TAB_STATUSES[tab] || null;
    const matching = withStatus.filter((c) => {
      if (statuses && !statuses.includes(c.status)) return false;
      if (favouritesOnly && !c.row.favourite) return false;
      if (!search) return true;
      // Name, address and custom domain: the three things someone actually remembers a project by.
      const haystack = [
        c.row.title, c.site?.slug, c.site?.customDomain,
        ...(c.site?.domains || []).map((d) => d.domain),
      ].filter(Boolean).join(" ").toLowerCase();
      return haystack.includes(search);
    });

    // Sorted before paging, so page two continues page one rather than re-shuffling. Favourites
    // lead whatever the ordering is — pinning something and then losing it to an alphabetical sort
    // would make the pin pointless — and the id breaks ties so the order is total.
    const compare = SORTS[sortKey].compare;
    matching.sort((a, b) => {
      if (!!a.row.favourite !== !!b.row.favourite) return a.row.favourite ? -1 : 1;
      return compare(a, b) || String(a.row.id).localeCompare(String(b.row.id));
    });

    const page = matching.slice(offset, offset + limit);

    // Every card's activity in one query rather than two per card.
    let eventsByConversation = new Map();
    try {
      eventsByConversation = await store.listEventsForConversations(
        owner.id, page.map((c) => String(c.row.id)), CARD_EVENT_TYPES,
      );
    } catch (error) {
      console.error(`[conversations] activity unavailable: ${error?.message || error}`);
    }

    // Workspace home: each conversation carries its live activity (who's working + on
    // what), derived from the durable event stream — the same truth the thread shows.
    const conversations = page.map(({ row, status, site }) => {
      const summary = publicConversation(row);
      // Never published → draft. That is a status, not an absence, and the dashboard filters on it.
      summary.publishStatus = status;
      summary.site = site;
      // Health rides with the card too, so the dashboard renders in one request rather than one
      // per project. A site with no check yet has no health — not a green badge it has not earned.
      summary.health = site ? healthByProject.get(site.projectId) || null : null;
      summary.favourite = !!row.favourite;
      summary.archivedAt = row.archived_at || null;
      // Today's traffic, where there is any. Absent rather than zero when nothing was collected —
      // a site published an hour ago has not had "0 visitors today", it has had no day yet.
      summary.today = site ? visitorsByProject.get(String(site.projectId)) || null : null;

      const working = new Map();
      let lastStatus = null;
      for (const event of eventsByConversation.get(String(row.id)) || []) {
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
      return summary;
    });
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
        sort: sortKey,
        favourites: favouritesOnly,
        archived,
      },
      // Offered by the server so the control cannot list an ordering the server does not implement.
      sorts: Object.entries(SORTS).map(([id, { label }]) => ({ id, label })),
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

/**
 * Act on several projects at once.
 *
 *   POST /api/v1/conversations/bulk  { ids: [...], action: "favourite" | "unfavourite" |
 *                                                          "archive" | "restore" | "delete" }
 *
 * One endpoint rather than one per action, because they share everything that matters: the same
 * ownership scoping, the same "ids that are not yours simply do not match", and the same shape of
 * answer. Deleting goes through the SAME soft-delete the single-project path uses — a bulk action
 * that deleted more permanently than the individual one would be a trap.
 */
export async function handleConversationsBulk(_req, res, { owner, body }) {
  const ids = [...new Set((Array.isArray(body?.ids) ? body.ids : []).map(String))].slice(0, 200);
  const action = String(body?.action || "");
  if (!ids.length) return sendJson(res, 400, { error: "Select at least one project.", code: "no_selection" });

  const store = conversationStore();
  try {
    if (action === "favourite" || action === "unfavourite") {
      const changed = await store.setConversationFlags(owner.id, ids, { favourite: action === "favourite" });
      return sendJson(res, 200, { action, changed: changed.length });
    }
    if (action === "archive" || action === "restore") {
      // Archive is not delete: nothing is scheduled for removal and a published site keeps serving.
      const changed = await store.setConversationFlags(owner.id, ids, {
        archived_at: action === "archive" ? new Date().toISOString() : null,
      });
      return sendJson(res, 200, { action, changed: changed.length });
    }
    if (action === "delete") {
      let changed = 0;
      for (const id of ids) {
        // Sequential and per-id so one project that has already gone does not abort the rest.
        const row = await store.softDeleteConversation(owner.id, id);
        if (row) changed += 1;
      }
      return sendJson(res, 200, { action, changed });
    }
    return sendJson(res, 400, { error: "That action is not available.", code: "unknown_action" });
  } catch (error) {
    console.error(`[conversations-bulk] ${error?.message || error}`);
    return sendJson(res, 500, { error: "That did not work. Nothing was changed.", code: "bulk_failed" });
  }
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
