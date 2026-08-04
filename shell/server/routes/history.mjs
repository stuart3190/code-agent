// Prompt and build history.
//
// Assembled from the records that already exist rather than a second history model:
//
//   diag_runs         the build a prompt produced — prompt text, model, status, duration
//   deployments       what that build published, if anything (deployments.build_run_id)
//   build_checkpoints the file trees kept along the way (build_checkpoints.build_id)
//   ca_conversations  which conversation it belongs to, and its title
//
// A build already knows its prompt, its model and its conversation. Writing a parallel
// "prompt_history" table would have meant two records of the same event, and the one that drifted
// would be the one shown to the customer.
//
// What this route deliberately does NOT return: the system prompt, the agent's intermediate
// reasoning, or diagnostic step output. Those live behind the diagnostics routes, which are the
// audit trail; history is what the CUSTOMER did and what came back.

import { CodeAgentInputError } from "../lib/codeAgentContracts.mjs";
import { serviceClient } from "../lib/supabase.mjs";

const PAGE_SIZE = 20;
const MAX_PAGE = 50;

export async function handleHistoryList(_req, res, { owner, url }) {
  return wrap(async () => {
    const client = serviceClient();
    const limit = Math.min(MAX_PAGE, Math.max(1, Number(url?.searchParams?.get("limit") || PAGE_SIZE) || PAGE_SIZE));
    const offset = Math.max(0, Number(url?.searchParams?.get("offset") || 0) || 0);
    const projectId = url?.searchParams?.get("project") || null;
    const conversationId = url?.searchParams?.get("conversation") || null;
    const search = (url?.searchParams?.get("q") || "").trim();

    // Owner scoping is in the statement, on every query below, rather than checked once above —
    // a filter that is part of the query cannot be forgotten by a later branch.
    let query = client.from("diag_runs")
      .select("id,project_id,conversation_id,kind,status,prompt,model,started_at,finished_at,duration_ms,repair_rounds", { count: "exact" })
      .eq("owner", owner.id)
      .order("started_at", { ascending: false })
      .range(offset, offset + limit - 1);
    if (projectId) query = query.eq("project_id", projectId);
    if (conversationId) query = query.eq("conversation_id", conversationId);
    // Search is a prefix-friendly ILIKE on the prompt only. Bounded on purpose: the prompt is the
    // thing anyone searches for, and a full-text index does not exist to justify anything wider.
    if (search) query = query.ilike("prompt", `%${search.replace(/[%_]/g, (c) => `\\${c}`)}%`);

    const { data: runs, count, error } = await query;
    if (error) throw new Error(error.message);

    const ids = (runs || []).map((r) => r.id);
    const [deployments, checkpoints, conversations] = await Promise.all([
      relatedDeployments(client, owner.id, ids),
      relatedCheckpoints(client, owner.id, ids),
      relatedConversations(client, owner.id, runs || []),
    ]);

    const items = (runs || []).map((run) => ({
      id: run.id,
      kind: run.kind,
      // The customer's own words. This is the row's headline; everything else is what happened to it.
      prompt: run.prompt || null,
      model: run.model || null,
      status: run.status,
      startedAt: run.started_at,
      finishedAt: run.finished_at,
      durationMs: run.duration_ms,
      repairRounds: run.repair_rounds || 0,
      projectId: run.project_id || null,
      conversationId: run.conversation_id || null,
      conversationTitle: conversations.get(String(run.conversation_id)) || null,
      // Deep-link targets. Null means the thing does not exist, so the client can omit the action
      // rather than offering a link that leads nowhere.
      deployment: deployments.get(run.id) || null,
      checkpoints: checkpoints.get(run.id) || 0,
    }));

    sendJson(res, 200, {
      items,
      page: {
        offset,
        limit,
        total: count ?? items.length,
        nextOffset: offset + items.length < (count ?? 0) ? offset + items.length : null,
        project: projectId,
        conversation: conversationId,
        search: search || null,
      },
    });
  });
}

async function relatedDeployments(client, owner, runIds) {
  const map = new Map();
  if (!runIds.length) return map;
  const { data, error } = await client.from("deployments")
    .select("id,number,status,url,build_run_id,project_id,created_at")
    .eq("owner", owner).in("build_run_id", runIds);
  if (error) {
    console.error(`[history] deployments unavailable: ${error.message}`);
    return map;
  }
  for (const row of data || []) {
    // A build can be published more than once; the newest is the one worth linking to.
    const existing = map.get(row.build_run_id);
    if (!existing || Date.parse(row.created_at) > Date.parse(existing.createdAt)) {
      map.set(row.build_run_id, {
        id: row.id, number: row.number, status: row.status, url: row.url,
        projectId: row.project_id, createdAt: row.created_at,
      });
    }
  }
  return map;
}

async function relatedCheckpoints(client, owner, buildIds) {
  const map = new Map();
  if (!buildIds.length) return map;
  const { data, error } = await client.from("build_checkpoints")
    .select("build_id").eq("owner", owner).in("build_id", buildIds);
  if (error) {
    console.error(`[history] checkpoints unavailable: ${error.message}`);
    return map;
  }
  for (const row of data || []) map.set(row.build_id, (map.get(row.build_id) || 0) + 1);
  return map;
}

async function relatedConversations(client, owner, runs) {
  const map = new Map();
  const ids = [...new Set(runs.map((r) => r.conversation_id).filter(Boolean))];
  if (!ids.length) return map;
  const { data, error } = await client.from("ca_conversations")
    .select("id,title").eq("owner", owner).in("id", ids);
  if (error) {
    console.error(`[history] conversations unavailable: ${error.message}`);
    return map;
  }
  for (const row of data || []) map.set(String(row.id), row.title || null);
  return map;
}

// ── plumbing ────────────────────────────────────────────────────────────────────────────

async function wrap(fn) {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof CodeAgentInputError) throw error;
    if (error.status || error.code) {
      throw new CodeAgentInputError(error.message, error.status || 400, error.code || "history_failed");
    }
    throw error;
  }
}

function sendJson(res, code, value) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(value));
}
