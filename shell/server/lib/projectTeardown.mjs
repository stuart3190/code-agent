// Everything a project owns, and how to take it away.
//
// This exists because deletion was scattered and incomplete. The cascade removed seven tables and
// left ten, and it took the site record away while leaving the site itself serving on the public
// internet — a deleted project stayed reachable forever, with Thrallo no longer holding the slug
// needed to clean it up.
//
// So there is now ONE list of what a project owns. A table added later that is not in this list
// fails a guard test rather than quietly leaking, which is the only version of this that stays
// true over time.

import { serviceClient } from "./supabase.mjs";

/**
 * Every table holding rows scoped to a single project, and the column that scopes them.
 *
 * Order matters: children before parents, and `projects` last of all.
 */
// `label` is what a failure is reported as. Deletion errors reach the user, and a raw table name
// would put database schema in front of them.
export const PROJECT_SCOPED_TABLES = Object.freeze([
  // Per-app backend data belonging to the generated app's own end users.
  { table: "entities", column: "app_id", ownerScoped: false, label: "app data" },
  { table: "app_notifications", column: "app_id", ownerScoped: false, label: "app notifications" },
  { table: "app_auth_events", column: "app_id", ownerScoped: false, label: "auth events" },
  { table: "app_password_resets", column: "app_id", ownerScoped: false, label: "reset codes" },
  { table: "app_users", column: "app_id", ownerScoped: false, label: "app users" },

  // Visitor analytics for the published site. Aggregates as well as raw events — keeping the
  // rollups would leave a deleted site's traffic readable indefinitely.
  { table: "analytics_events", column: "project_id", ownerScoped: true, label: "analytics" },
  { table: "analytics_daily", column: "project_id", ownerScoped: true, label: "analytics" },

  // Platform records.
  { table: "project_logs", column: "project_id", ownerScoped: true, label: "logs" },
  { table: "health_checks", column: "project_id", ownerScoped: true, label: "health history" },
  { table: "health_status", column: "project_id", ownerScoped: true, label: "health" },
  { table: "custom_domains", column: "project_id", ownerScoped: true, label: "custom domains" },
  { table: "published_sites", column: "project_id", ownerScoped: true, label: "published site" },
  // Deployment history is permanent while the project LIVES — it is the answer to "what was live
  // last Tuesday" — but a deleted project must not leave its published source behind, and
  // source_tree is the whole app.
  { table: "deployments", column: "project_id", ownerScoped: true, label: "deployment history" },
  { table: "build_checkpoints", column: "project_id", ownerScoped: true, label: "build checkpoints" },
  { table: "ai_requests", column: "project_id", ownerScoped: true, label: "usage records" },
  { table: "build_jobs", column: "project_id", ownerScoped: true, label: "build history" },

  // diag_runs holds the prompts the user actually typed. The build audit trail is deliberately
  // permanent while a project LIVES, but a permanently deleted project must not leave its owner's
  // prompts behind. diag_steps cascades from it.
  { table: "diag_runs", column: "project_id", ownerScoped: true, label: "build diagnostics" },

  // Last: qa_runs cascades from this, and nothing else may reference it afterwards.
  { table: "projects", column: "id", ownerScoped: true, label: "project" },
]);

// Tables carrying a project_id or app_id that are deliberately NOT purged here, each with a
// reason. The guard requires an entry rather than allowing silence.
//
// The long tail are Buildr101-era tables defined by migrations carried over at fork time and never
// applied to Thrallo's database — they cannot hold data because they do not exist. If one is ever
// applied, `ops/migration-drift.mjs` fails: it reconciles the LIVE table list against both the
// backup list and this one, which is the half CI cannot see.
const UNAPPLIED_LEGACY = "defined by an unapplied Buildr101-era migration; absent from Thrallo production, so it holds no project data";
export const NOT_PURGED = Object.freeze(new Map([
  ["qa_runs", "cascades from projects (FK ON DELETE CASCADE) — deleting it here would be redundant"],
  ["diag_steps", "cascades from diag_runs (FK ON DELETE CASCADE)"],
  ...[
    "project_secrets", "project_integrations", "project_environments", "project_releases",
    "background_tasks", "audit_events", "payment_products", "payment_orders",
    "project_brand_settings", "app_analytics_events", "connector_oauth_states",
    "connector_workflows", "project_actions", "app_jobs", "runtime_usage", "app_usage_ledger",
    "action_schedules", "knowledge_bases", "knowledge_documents", "knowledge_chunks",
    "app_user_integrations", "app_connector_oauth_states",
  ].map((table) => [table, UNAPPLIED_LEGACY]),
]));

// build_signals is keyed by build_id, not project_id, so it cannot be found by the loop above.
// It is cleaned from the diag_runs ids being removed.
/**
 * Every matching row, a page at a time.
 *
 * An unbounded `.select()` is capped by PostgREST, and the cap is silent — you get a short list,
 * not an error. Anywhere the caller's correctness depends on seeing ALL the rows (a purge, a
 * cascade), that silence is a bug waiting for a customer big enough to trigger it.
 */
export async function* pagedRows(client, table, columns, filters = {}, { pageSize = 500 } = {}) {
  for (let from = 0; ; from += pageSize) {
    let query = client.from(table).select(columns).range(from, from + pageSize - 1);
    for (const [column, value] of Object.entries(filters)) query = query.eq(column, value);
    const { data, error } = await query;
    if (error) throw new Error(`${table}: ${error.message}`);
    if (!data?.length) return;
    yield data;
    if (data.length < pageSize) return;
  }
}

async function purgeBuildSignals(client, ownerId, runIds) {
  if (!runIds.length) return;
  await client.from("build_signals").delete().eq("owner", ownerId).in("build_id", runIds);
}

function failure(name, error) {
  const e = new Error(`Deletion failed at ${name}: ${error?.message || error}`);
  e.step = name;
  e.status = 500;
  return e;
}

/**
 * Take a published site off the internet.
 *
 * The slug is what makes this work. Published files live under the SLUG directory, so unpublishing
 * with only a projectId computed a different directory, removed nothing, and returned 200 — the
 * caller's `.catch()` never fired because nothing threw. The record was then deleted, losing the
 * slug, and the site served forever.
 */
export async function takeSiteOffline({ client, provisiond, ownerId, projectId }) {
  if (!provisiond) return { attempted: false };

  const { data: site } = await client.from("published_sites")
    .select("slug").eq("project_id", String(projectId)).eq("owner", ownerId).maybeSingle();
  const slug = site?.slug || null;

  // Pass the slug. Without it provisiond removes a directory that does not exist.
  const result = await provisiond("/unpublish", { projectId, slug })
    .catch((error) => ({ error: error?.message || String(error) }));

  if (!slug) return { attempted: true, slug: null, removed: false, note: "no published site recorded" };

  // Verify rather than assume. This is the check that would have caught the original bug.
  const exists = await provisiond(`/exists?label=${encodeURIComponent(slug)}`, null, "GET")
    .catch(() => null);

  const stillServing = exists?.exists === true;
  if (stillServing) {
    // Loud, because the alternative is a customer's site staying online after they deleted it.
    console.error(`[teardown] ${slug} is STILL SERVING after unpublish — project ${projectId}`);
  }
  return { attempted: true, slug, removed: !stillServing, response: result };
}

// Detach every custom domain from Caddy before the rows are deleted. Deleting the rows first
// loses the hostnames, and Caddy would keep serving them with nothing in Thrallo aware of it.
export async function detachDomains({ client, provisiond, ownerId, projectId }) {
  const { data: domains } = await client.from("custom_domains")
    .select("domain").eq("project_id", String(projectId)).eq("owner", ownerId);
  const names = (domains || []).map((d) => d.domain);
  if (!provisiond) return { detached: [], skipped: names };
  for (const domain of names) {
    await provisiond("/domain-detach", { domain })
      .catch((error) => console.error(`[teardown] detach ${domain}: ${error?.message || error}`));
  }
  return { detached: names, skipped: [] };
}

/**
 * Remove every resource a project owns.
 *
 * Infrastructure first — while the records that describe it still exist — then the rows. Reversing
 * that order is what left orphans.
 */
export async function purgeProjectResources(ownerId, projectId, { client = serviceClient(), provisiond = null } = {}) {
  const report = { projectId: String(projectId) };

  report.site = await takeSiteOffline({ client, provisiond, ownerId, projectId });
  report.domains = await detachDomains({ client, provisiond, ownerId, projectId });
  if (provisiond) await provisiond("/stop", { projectId }).catch(() => {});  // preview container

  // The end users of a generated app have their own auth identities; deleting the app must not
  // leave them able to sign in to nothing.
  //
  // Paged, deliberately. This was a bare `.select()`, and PostgREST caps an unbounded select at a
  // configured maximum — so a popular app's end users beyond that cap were silently never deleted,
  // leaving live auth identities for an app that no longer exists. A purge that quietly does most
  // of the job is worse than one that fails, because nothing says so.
  report.appUsers = 0;
  for await (const rows of pagedRows(client, "app_users", "auth_user_id", { app_id: String(projectId) })) {
    for (const user of rows) {
      await client.auth.admin.deleteUser(user.auth_user_id).catch(() => {});
      report.appUsers += 1;
    }
  }

  // build_signals is keyed by build, so collect the run ids before diag_runs is removed. Paged for
  // the same reason: a long-lived project accumulates far more diagnostic runs than one page.
  const runIds = [];
  for await (const rows of pagedRows(client, "diag_runs", "id", { owner: ownerId, project_id: String(projectId) })) {
    runIds.push(...rows.map((r) => r.id));
  }
  await purgeBuildSignals(client, ownerId, runIds);

  for (const { table, column, ownerScoped, label } of PROJECT_SCOPED_TABLES) {
    let query = client.from(table).delete().eq(column, String(projectId));
    if (ownerScoped) query = query.eq("owner", ownerId);
    const { error } = await query;
    // The label, not the table name — deletion errors reach the user, and database schema is not
    // theirs to see.
    if (error) throw failure(label || table, error);
  }

  return report;
}
