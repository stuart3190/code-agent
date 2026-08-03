// Deployments: recording what actually went out, and putting an old one back.
//
// The previous "Deployments" view read diag_runs — diagnostic BUILD runs. A build nobody published
// showed as a deployment, a publish showed as nothing of its own, and published_sites (one row per
// project, overwritten every publish) destroyed the previous deployment each time. There was no
// answer to "what was live last Tuesday", and nothing to roll back TO.
//
// A deployment row is opened when a publish starts and only moves forward: building → deploying →
// live, or → failed. Publishing again opens a NEW row and marks the previous one superseded.
// Nothing is ever rewritten, which is what makes the history worth keeping.

import { serviceClient } from "../supabase.mjs";

export const DEPLOY_STATUS = Object.freeze({
  building: "building",
  deploying: "deploying",
  live: "live",
  failed: "failed",
  rolledBack: "rolled_back",
  superseded: "superseded",
});

// States that mean "this publish is still happening". A second click while one of these is in
// flight joins the existing deployment rather than opening a rival one.
const IN_FLIGHT = [DEPLOY_STATUS.building, DEPLOY_STATUS.deploying];
// Long enough to cover a slow production build, short enough that a genuinely dead attempt does
// not block publishing forever.
const IN_FLIGHT_TTL_MS = 20 * 60_000;

const nowIso = () => new Date().toISOString();
const scopeOf = (row) => String(row.product_id || row.project_id);

function fail(message, status, code) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

/**
 * The next deployment number for an app.
 *
 * Per PRODUCT, not per project row. "#7" means the seventh time this app went out, which is the
 * question someone reading the list is actually asking. A rebuild creates a new project row under
 * the same product, and restarting at #1 there would make the history unreadable.
 */
async function nextNumber(client, owner, productId, projectId) {
  const query = client.from("deployments").select("number")
    .eq("owner", owner).order("number", { ascending: false }).limit(1);
  const { data, error } = productId
    ? await query.eq("product_id", productId)
    : await query.is("product_id", null).eq("project_id", String(projectId));
  if (error) throw new Error(`deployments: could not allocate a number: ${error.message}`);
  return (data?.[0]?.number || 0) + 1;
}

/**
 * Open a deployment for a publish that is starting.
 *
 * Returns the row, and `joined: true` when an in-flight deployment already existed — repeated
 * clicks must be idempotent, and two rows for one publish would make the history lie about how
 * often the app was deployed.
 */
export async function openDeployment({
  owner, projectId, productId = null, triggeredBy = null, triggeredByKind = "user",
  buildRunId = null, sourceProjectId = null, rolledBackFrom = null,
  environment = "production", client = serviceClient(), now = new Date(),
}) {
  const existing = await inFlightFor(owner, { projectId, productId, client, now });
  if (existing) return { deployment: existing, joined: true };

  // The unique (owner, app, number) index is what makes this safe under a race: the loser of two
  // concurrent publishes collides and retries rather than quietly taking the same number.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const number = await nextNumber(client, owner, productId, projectId);
    const { data, error } = await client.from("deployments").insert({
      owner,
      project_id: String(projectId),
      product_id: productId ? String(productId) : null,
      number,
      triggered_by: triggeredBy,
      triggered_by_kind: triggeredByKind,
      environment,
      status: DEPLOY_STATUS.building,
      build_run_id: buildRunId,
      source_project_id: String(sourceProjectId || projectId),
      rolled_back_from: rolledBackFrom,
      build_started_at: now.toISOString(),
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
    }).select("*").single();

    if (!error) return { deployment: data, joined: false };
    if (!/duplicate key/i.test(error.message || "")) {
      throw new Error(`deployments: could not open a deployment: ${error.message}`);
    }
  }
  throw new Error("deployments: could not allocate a deployment number after several attempts");
}

// A publish already under way for this app, if any.
export async function inFlightFor(owner, { projectId, productId = null, client = serviceClient(), now = new Date() } = {}) {
  const query = client.from("deployments").select("*")
    .eq("owner", owner).in("status", IN_FLIGHT)
    .order("created_at", { ascending: false }).limit(1);
  const { data, error } = productId
    ? await query.eq("product_id", String(productId))
    : await query.eq("project_id", String(projectId));
  if (error) throw new Error(`deployments: could not check for a publish in progress: ${error.message}`);

  const row = data?.[0];
  if (!row) return null;
  // A row left behind by a process that died must not block publishing forever.
  if (now.getTime() - Date.parse(row.created_at) > IN_FLIGHT_TTL_MS) {
    await client.from("deployments").update({
      status: DEPLOY_STATUS.failed,
      failure_reason: "The publish stopped without finishing. Nothing was changed on the live site.",
      updated_at: nowIso(),
    }).eq("id", row.id);
    return null;
  }
  return row;
}

// The build finished. Recorded separately from the deploy so the two durations are real
// measurements rather than one number split by guesswork.
export async function markBuilt(deploymentId, { client = serviceClient(), now = new Date(), sourceTree = null } = {}) {
  const { data: row } = await client.from("deployments").select("build_started_at").eq("id", deploymentId).maybeSingle();
  const started = Date.parse(row?.build_started_at || now.toISOString());
  const patch = {
    status: DEPLOY_STATUS.deploying,
    build_completed_at: now.toISOString(),
    build_duration_ms: Math.max(0, now.getTime() - started),
    deploy_started_at: now.toISOString(),
    updated_at: now.toISOString(),
  };
  // The exact source that was built. Stored here rather than read from the project later, because
  // the project moves on and an older deployment must never hand back today's code.
  if (sourceTree) patch.source_tree = sourceTree;
  const { error } = await client.from("deployments").update(patch).eq("id", deploymentId);
  if (error) throw new Error(`deployments: could not record the build: ${error.message}`);
}

/**
 * The deployment is serving. Everything that was live for this app before it becomes history.
 *
 * The previous live row is retired BEFORE this one is promoted, because the database allows only
 * one live deployment per app — doing it the other way round would collide.
 */
export async function markLive(deploymentId, { url, slug, client = serviceClient(), now = new Date(), supersededStatus = DEPLOY_STATUS.superseded } = {}) {
  const { data: row, error: readError } = await client.from("deployments")
    .select("*").eq("id", deploymentId).maybeSingle();
  if (readError) throw new Error(`deployments: could not read the deployment: ${readError.message}`);
  if (!row) throw fail("That deployment no longer exists.", 404, "deployment_missing");

  const scope = scopeOf(row);
  const { data: currentLive } = await client.from("deployments")
    .select("id,product_id,project_id").eq("owner", row.owner).eq("status", DEPLOY_STATUS.live);
  for (const live of currentLive || []) {
    if (live.id === deploymentId || scopeOf(live) !== scope) continue;
    const { error: retireError } = await client.from("deployments")
      .update({ status: supersededStatus, updated_at: now.toISOString() }).eq("id", live.id);
    if (retireError) throw new Error(`deployments: could not retire the previous deployment: ${retireError.message}`);
  }

  const deployStarted = Date.parse(row.deploy_started_at || row.build_completed_at || now.toISOString());
  const { error } = await client.from("deployments").update({
    status: DEPLOY_STATUS.live,
    url, slug,
    deployed_at: now.toISOString(),
    deploy_duration_ms: Math.max(0, now.getTime() - deployStarted),
    failure_reason: null,
    updated_at: now.toISOString(),
  }).eq("id", deploymentId);
  if (error) throw new Error(`deployments: could not mark the deployment live: ${error.message}`);
}

/**
 * The publish did not work.
 *
 * A failed attempt is KEPT — an honest history includes the times it did not go out — but it never
 * becomes live, and it never touches whatever is currently serving.
 */
export async function markFailed(deploymentId, reason, { client = serviceClient(), now = new Date() } = {}) {
  const { error } = await client.from("deployments").update({
    status: DEPLOY_STATUS.failed,
    failure_reason: String(reason || "The publish failed.").slice(0, 2_000),
    updated_at: now.toISOString(),
  }).eq("id", deploymentId);
  if (error) console.error(`[deployments] could not record failure: ${error.message}`);
}

// ── Reading ─────────────────────────────────────────────────────────────────────────────

export function publicDeployment(row) {
  return {
    id: row.id,
    number: row.number,
    status: row.status,
    environment: row.environment,
    triggeredByKind: row.triggered_by_kind,
    buildRunId: row.build_run_id || null,
    sourceProjectId: row.source_project_id || null,
    buildDurationMs: row.build_duration_ms ?? null,
    deployDurationMs: row.deploy_duration_ms ?? null,
    deployedAt: row.deployed_at || null,
    createdAt: row.created_at,
    url: row.url || null,
    failureReason: row.failure_reason || null,
    rolledBackFrom: row.rolled_back_from || null,
    // Whether this deployment can still be restored or downloaded. Stating it beats a button that
    // fails when pressed.
    sourceAvailable: !!row.source_tree,
    // Git fields are deliberately ABSENT rather than null: Thrallo has no repository connection
    // for these projects, and a row of empty "commit / branch / author" would be inventing a
    // concept the product does not have.
  };
}

/**
 * A project's deployments, newest first.
 *
 * Keyed by the app rather than the project row: a rebuild creates a new project, and its
 * deployments belong to the same history.
 */
export async function listDeployments(owner, projectId, { client = serviceClient(), limit = 50 } = {}) {
  const { data: project, error: projectError } = await client.from("projects")
    .select("id,product_id").eq("id", String(projectId)).eq("owner", owner).maybeSingle();
  if (projectError) throw new Error(`deployments: could not resolve the project: ${projectError.message}`);

  let query = client.from("deployments").select("*").eq("owner", owner)
    .order("number", { ascending: false }).limit(limit);
  query = project?.product_id
    ? query.eq("product_id", String(project.product_id))
    : query.eq("project_id", String(projectId));

  const { data, error } = await query;
  if (error) throw new Error(`deployments: could not list deployments: ${error.message}`);
  return (data || []).map(publicDeployment);
}

// One deployment, owner-scoped. Returns the RAW row (source tree included) for rollback and
// download; everything user-facing goes through publicDeployment.
export async function getDeployment(owner, deploymentId, { client = serviceClient() } = {}) {
  const { data, error } = await client.from("deployments")
    .select("*").eq("id", deploymentId).eq("owner", owner).maybeSingle();
  if (error) throw new Error(`deployments: could not read the deployment: ${error.message}`);
  return data || null;
}

/**
 * Is this deployment one the caller may act on from this project?
 *
 * Owner scoping alone is not enough: an owner with two apps must not be able to roll one app back
 * onto another's address by pasting a deployment id.
 */
export async function assertBelongsTo(owner, deployment, projectId, { client = serviceClient() } = {}) {
  if (!deployment) throw fail("That deployment could not be found.", 404, "deployment_missing");
  const { data: project } = await client.from("projects")
    .select("id,product_id").eq("id", String(projectId)).eq("owner", owner).maybeSingle();
  if (!project) throw fail("That project could not be found.", 404, "project_missing");

  const sameApp = project.product_id
    ? String(deployment.product_id || "") === String(project.product_id)
    : String(deployment.project_id) === String(projectId);
  if (!sameApp) throw fail("That deployment belongs to a different app.", 403, "wrong_app");
  return project;
}
