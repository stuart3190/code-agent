import crypto from "node:crypto";
import os from "node:os";
import { existsSync } from "node:fs";
import { optionalEnv } from "../env.mjs";
import { serviceClient } from "../supabase.mjs";
import { createArtifactManifest } from "../../../../shared/immutableRelease.mjs";

const workerId = `${os.hostname()}:${process.pid}:publisher`;
let timer = null;

export const atomicPublishEnabled = () => optionalEnv("THRALLO_ATOMIC_PUBLISH_ENABLED", "0") === "1";
export const publisherPauseFile = () => optionalEnv("THRALLO_PUBLISHER_PAUSE_FILE", "/var/lib/thrallo/publisher.paused");
export const publisherPaused = () => optionalEnv("THRALLO_PUBLISHER_PAUSED", "0") === "1" || existsSync(publisherPauseFile());

async function provisiond(route, { method = "POST", body } = {}) {
  const base = optionalEnv("PROVISIOND_URL"); const token = optionalEnv("PROVISIOND_TOKEN");
  if (!base || !token) throw Object.assign(new Error("Publishing infrastructure is not configured."), { code: "not_configured" });
  const response = await fetch(`${base}${route}`, {
    method, headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(result.error || `provisiond ${route} ${response.status}`), { code: result.code });
  return result;
}

function rpcError(name, error) {
  if (!error) return;
  const out = new Error(`${name}: ${error.message}`); out.code = error.code; throw out;
}

export async function assertNoBlockingDeploymentDiagnostics(owner, buildRunId, client = serviceClient()) {
  if (!buildRunId) return;
  const { data, error } = await client.from("diag_runs").select("id,status")
    .eq("id", buildRunId).eq("owner", owner).maybeSingle();
  rpcError("deployment diagnostics", error);
  if (data && ["failed", "blocked", "cancelled"].includes(data.status)) {
    throw Object.assign(new Error(`deployment diagnostics are ${data.status}`), { code: "blocking_diagnostics" });
  }
}

export async function finalizeAndActivateRelease({
  owner, projectId, productId = null, buildId = null, snapshotId = null, deploymentId = null,
  slug, url, files, operation = "activate", metadata = {}, client = serviceClient(),
}) {
  if (!atomicPublishEnabled()) return null;
  if (publisherPaused()) throw Object.assign(new Error("Atomic publisher intake is paused."), { code: "publisher_paused" });
  await assertNoBlockingDeploymentDiagnostics(owner, buildId, client);
  const releaseId = crypto.randomUUID();
  const proof = createArtifactManifest(files);
  const { data: domains, error: domainError } = await client.from("custom_domains")
    .select("domain,status,ssl_status").eq("owner", owner).eq("project_id", String(projectId));
  rpcError("custom domain bindings", domainError);

  const finalized = await provisiond("/releases/finalize", {
    body: { releaseId, owner, projectId: String(projectId), files, proof },
  });
  if (finalized.health !== "verified" || finalized.artifactHash !== proof.artifactHash
      || finalized.manifestHash !== proof.manifestHash) throw new Error("provisiond returned invalid release health evidence");

  const { data: registration, error: registerError } = await client.rpc("register_verified_publish_release", {
    p_release_id: releaseId, p_owner: owner, p_project_id: String(projectId), p_product_id: productId,
    p_slug: slug, p_url: url, p_build_id: buildId, p_snapshot_id: snapshotId,
    p_deployment_id: deploymentId, p_artifact_hash: proof.artifactHash,
    p_manifest_hash: proof.manifestHash, p_artifact_path: finalized.artifactPath,
    p_artifact_bytes: proof.bytes, p_file_count: proof.fileCount, p_manifest: proof.manifest,
    p_domains: domains || [], p_metadata: { ...metadata, health: finalized.health },
  });
  rpcError("register verified publish release", registerError);

  const { data: intent, error: intentError } = await client.rpc("request_publish_activation", {
    p_owner: owner, p_release_id: releaseId, p_expected_version: registration.activation_version,
    p_operation: operation, p_activation_deployment_id: deploymentId,
  });
  rpcError("request publish activation", intentError);

  try {
    const pointer = await provisiond("/releases/activate", { body: {
      slug, owner, projectId: String(projectId), releaseId,
      expectedPreviousReleaseId: intent.previous_release_id || null,
    } });
    if (pointer.releaseId !== releaseId) throw new Error("provisiond did not observe the requested release");
    const switched = await client.rpc("mark_publish_pointer_switched", {
      p_intent_id: intent.id, p_observed_release_id: releaseId,
    });
    rpcError("record publish pointer", switched.error);
    const completed = await client.rpc("complete_publish_activation", { p_intent_id: intent.id });
    rpcError("complete publish activation", completed.error);
    return { releaseId, intentId: intent.id, artifactHash: proof.artifactHash, manifestHash: proof.manifestHash,
      files: proof.fileCount, bytes: proof.bytes, url, slug, activationVersion: registration.activation_version + 1 };
  } catch (error) {
    await client.rpc("fail_publish_activation", { p_intent_id: intent.id, p_error: error.message, p_terminal: false });
    error.activationIntentId = intent.id;
    throw error;
  }
}

export async function activateRetainedRelease({
  owner, projectId, releaseId, activationDeploymentId = null, client = serviceClient(),
}) {
  if (!atomicPublishEnabled()) return null;
  const { data: release, error: releaseError } = await client.from("publish_releases")
    .select("id,owner,project_id,site_id,artifact_hash,manifest_hash,health_state,activation_state")
    .eq("id", releaseId).eq("owner", owner).maybeSingle();
  rpcError("retained release", releaseError);
  if (!release) {
    throw Object.assign(new Error("That deployment has no retained immutable release."), { code: "artifact_unavailable" });
  }
  const { data: site, error: siteError } = await client.from("published_sites")
    .select("id,slug,url,activation_version,active_publish_release_id").eq("id", release.site_id).eq("owner", owner).maybeSingle();
  rpcError("release site", siteError);
  if (!site) throw Object.assign(new Error("The published site no longer exists."), { code: "not_published" });
  const verified = await provisiond("/releases/verify", { body: { owner, projectId: release.project_id, releaseId } });
  if (verified.artifactHash !== release.artifact_hash || verified.manifestHash !== release.manifest_hash) {
    throw Object.assign(new Error("The retained release failed its integrity proof."), { code: "corrupt_artifact" });
  }
  const requested = await client.rpc("request_publish_activation", {
    p_owner: owner, p_release_id: releaseId, p_expected_version: site.activation_version,
    p_operation: "rollback", p_activation_deployment_id: activationDeploymentId,
  });
  rpcError("request rollback activation", requested.error);
  const intent = requested.data;
  try {
    const pointer = await provisiond("/releases/activate", { body: {
      slug: site.slug, owner, projectId: release.project_id, releaseId,
      expectedPreviousReleaseId: intent.previous_release_id,
    } });
    if (pointer.releaseId !== releaseId) throw new Error("rollback pointer was not switched");
    const marked = await client.rpc("mark_publish_pointer_switched", {
      p_intent_id: intent.id, p_observed_release_id: releaseId,
    });
    rpcError("record rollback pointer", marked.error);
    const completed = await client.rpc("complete_publish_activation", { p_intent_id: intent.id });
    rpcError("complete rollback", completed.error);
    return { releaseId, intentId: intent.id, url: site.url, slug: site.slug };
  } catch (error) {
    await client.rpc("fail_publish_activation", { p_intent_id: intent.id, p_error: error.message, p_terminal: false });
    error.activationIntentId = intent.id; throw error;
  }
}

export async function atomicUnpublish({ owner, projectId, client = serviceClient() }) {
  if (!atomicPublishEnabled()) return null;
  const { data: site, error } = await client.from("published_sites")
    .select("id,slug,url,activation_version,active_publish_release_id,unpublished_at")
    .eq("owner", owner).eq("project_id", String(projectId)).maybeSingle();
  rpcError("published site", error);
  if (!site) throw Object.assign(new Error("That project isn't published."), { code: "not_published" });
  if (site.unpublished_at && !site.active_publish_release_id) return { url: site.url, alreadyOffline: true };
  const requested = await client.rpc("request_publish_unpublish", {
    p_owner: owner, p_project_id: String(projectId), p_expected_version: site.activation_version,
  });
  rpcError("request unpublish", requested.error);
  const intent = requested.data;
  try {
    const observed = await provisiond("/releases/unpublish", { body: {
      slug: site.slug, expectedPreviousReleaseId: intent.previous_release_id,
    } });
    if (observed.releaseId !== null) throw new Error("site pointer remains after unpublish");
    const marked = await client.rpc("mark_publish_pointer_switched", {
      p_intent_id: intent.id, p_observed_release_id: null,
    });
    rpcError("record unpublish pointer", marked.error);
    const completed = await client.rpc("complete_publish_activation", { p_intent_id: intent.id });
    rpcError("complete unpublish", completed.error);
    return { url: site.url, alreadyOffline: false, retainedReleaseId: intent.previous_release_id };
  } catch (failure) {
    await client.rpc("fail_publish_activation", { p_intent_id: intent.id, p_error: failure.message, p_terminal: false });
    failure.activationIntentId = intent.id; throw failure;
  }
}

async function releaseLocation(client, releaseId) {
  if (!releaseId) return null;
  const { data, error } = await client.from("publish_releases")
    .select("id,owner,project_id,artifact_hash,manifest_hash,health_state").eq("id", releaseId).maybeSingle();
  rpcError("release location", error); return data;
}

export async function verifyRetainedRelease({ owner, releaseId, client = serviceClient() }) {
  const release = await releaseLocation(client, releaseId);
  if (!release || release.owner !== owner) throw new Error("release not found");
  const verified = await provisiond("/releases/verify", { body: {
    owner, projectId: release.project_id, releaseId,
  } });
  if (verified.artifactHash !== release.artifact_hash || verified.manifestHash !== release.manifest_hash) {
    throw new Error("retained release integrity mismatch");
  }
  return verified;
}

export async function adoptLegacyPublishedSite({ owner, projectId, client = serviceClient() }) {
  if (!atomicPublishEnabled()) throw new Error("atomic publishing must be enabled on the dark provisiond endpoint");
  const { data: site, error: siteError } = await client.from("published_sites")
    .select("id,owner,project_id,product_id,slug,url,activation_version,active_publish_release_id,unpublished_at")
    .eq("owner", owner).eq("project_id", String(projectId)).maybeSingle();
  rpcError("legacy published site", siteError);
  if (!site || site.unpublished_at || site.active_publish_release_id) throw new Error("site is not an unadopted live legacy site");
  const { data: deployment, error: deploymentError } = await client.from("deployments")
    .select("id,build_run_id").eq("owner", owner).eq("project_id", String(projectId)).eq("status", "live")
    .order("deployed_at", { ascending: false }).limit(1).maybeSingle();
  rpcError("legacy live deployment", deploymentError);
  const { data: domains, error: domainsError } = await client.from("custom_domains")
    .select("domain,status,ssl_status").eq("owner", owner).eq("project_id", String(projectId));
  rpcError("legacy domain bindings", domainsError);
  const releaseId = crypto.randomUUID();
  const adopted = await provisiond("/releases/adopt-legacy", { body: {
    releaseId, owner, projectId: String(projectId), slug: site.slug,
    domains: (domains || []).map((row) => row.domain),
  } });
  const registered = await client.rpc("register_verified_publish_release", {
    p_release_id: releaseId, p_owner: owner, p_project_id: String(projectId), p_product_id: site.product_id,
    p_slug: site.slug, p_url: site.url, p_build_id: deployment?.build_run_id || null,
    p_snapshot_id: null, p_deployment_id: deployment?.id || null,
    p_artifact_hash: adopted.artifactHash, p_manifest_hash: adopted.manifestHash,
    p_artifact_path: adopted.artifactPath, p_artifact_bytes: adopted.bytes,
    p_file_count: adopted.fileCount, p_manifest: adopted.manifest,
    p_domains: domains || [], p_metadata: { adoptedLegacy: true, legacyPath: adopted.legacyPath },
  });
  rpcError("register adopted release", registered.error);
  const requested = await client.rpc("request_publish_activation", {
    p_owner: owner, p_release_id: releaseId, p_expected_version: site.activation_version,
    p_operation: "activate", p_activation_deployment_id: deployment?.id || null,
  });
  rpcError("request adopted activation", requested.error);
  const marked = await client.rpc("mark_publish_pointer_switched", {
    p_intent_id: requested.data.id, p_observed_release_id: releaseId,
  });
  rpcError("record adopted pointer", marked.error);
  const completed = await client.rpc("complete_publish_activation", { p_intent_id: requested.data.id });
  rpcError("complete adopted activation", completed.error);
  return { releaseId, siteId: site.id, slug: site.slug, artifactHash: adopted.artifactHash,
    manifestHash: adopted.manifestHash, domains: (domains || []).map((row) => row.domain) };
}

export async function reconcileActivation(intent, { client = serviceClient() } = {}) {
  const desired = await releaseLocation(client, intent.desired_release_id);
  const current = await provisiond(`/releases/inspect?slug=${encodeURIComponent(intent.slug)}`, { method: "GET" });
  try {
    if (intent.operation === "unpublish") {
      if (current.releaseId !== null) await provisiond("/releases/unpublish", { body: {
        slug: intent.slug, expectedPreviousReleaseId: intent.previous_release_id,
      } });
    } else if (current.releaseId !== intent.desired_release_id) {
      await provisiond("/releases/activate", { body: {
        slug: intent.slug, owner: desired.owner, projectId: desired.project_id,
        releaseId: desired.id, expectedPreviousReleaseId: intent.previous_release_id,
      } });
    }
    const marked = await client.rpc("mark_publish_pointer_switched", {
      p_intent_id: intent.id, p_observed_release_id: intent.desired_release_id,
    });
    rpcError("record reconciled pointer", marked.error);
    const completed = await client.rpc("complete_publish_activation", { p_intent_id: intent.id });
    rpcError("complete reconciled activation", completed.error);
    return { id: intent.id, state: "completed" };
  } catch (error) {
    if (error.code === "40001" && intent.previous_release_id) {
      const previous = await releaseLocation(client, intent.previous_release_id);
      await provisiond("/releases/activate", { body: {
        slug: intent.slug, owner: previous.owner, projectId: previous.project_id,
        releaseId: previous.id, expectedPreviousReleaseId: intent.desired_release_id,
      } });
      const rolled = await client.rpc("mark_publish_activation_rolled_back", {
        p_intent_id: intent.id, p_observed_release_id: previous.id, p_reason: error.message,
      });
      rpcError("record activation rollback", rolled.error);
      return { id: intent.id, state: "rolled_back" };
    }
    await client.rpc("fail_publish_activation", { p_intent_id: intent.id, p_error: error.message, p_terminal: false });
    throw error;
  }
}

export async function reconcilePendingActivations({ client = serviceClient(), limit = 10 } = {}) {
  if (!atomicPublishEnabled() || publisherPaused()) return { leased: 0, completed: 0, failed: 0, disabled: !atomicPublishEnabled() };
  const leased = await client.rpc("lease_publish_activation_intents", {
    p_worker: workerId, p_limit: limit, p_lease_seconds: 30,
  });
  rpcError("lease publish activations", leased.error);
  let completed = 0; let failed = 0;
  for (const intent of leased.data || []) {
    try { await reconcileActivation(intent, { client }); completed += 1; }
    catch (error) { failed += 1; console.error(`[publisher] reconcile ${intent.id}: ${error.message}`); }
  }
  return { leased: leased.data?.length || 0, completed, failed };
}

export async function sweepPublishReleaseRetention({
  client = serviceClient(), successfulPerSite = Number(optionalEnv("THRALLO_RELEASE_RETENTION_SUCCESSFUL", "5")),
  failedDays = Number(optionalEnv("THRALLO_RELEASE_RETENTION_FAILED_DAYS", "14")), now = new Date(),
} = {}) {
  if (!atomicPublishEnabled()) return { disabled: true, retained: 0 };
  const { data, error } = await client.from("publish_releases")
    .select("id,site_id,activation_state,health_state,created_at,rollback_eligible")
    .order("created_at", { ascending: false });
  rpcError("release retention list", error);
  const retained = new Set(); const successes = new Map();
  const failedCutoff = now.getTime() - Math.max(1, failedDays) * 24 * 60 * 60_000;
  for (const release of data || []) {
    if (release.activation_state === "active") { retained.add(release.id); continue; }
    if (["ready", "activating", "superseded", "rolled_back"].includes(release.activation_state)
        && release.health_state === "verified") {
      const count = successes.get(release.site_id) || 0;
      if (count < Math.max(1, successfulPerSite)) { retained.add(release.id); successes.set(release.site_id, count + 1); }
      continue;
    }
    if (Date.parse(release.created_at) >= failedCutoff) retained.add(release.id);
  }
  const ineligible = (data || []).filter((release) => !retained.has(release.id) && release.rollback_eligible).map((release) => release.id);
  if (ineligible.length) {
    const update = await client.from("publish_releases").update({ rollback_eligible: false }).in("id", ineligible);
    rpcError("release retention eligibility", update.error);
  }
  const cleaned = await provisiond("/releases/cleanup", { body: {
    retained: [...retained], olderThanMs: Math.max(1, failedDays) * 24 * 60 * 60_000, now: now.getTime(),
  } });
  return { retained: retained.size, ineligible: ineligible.length, ...cleaned };
}

export function startPublishReconciler() {
  if (timer || !atomicPublishEnabled()) return;
  timer = setInterval(() => reconcilePendingActivations().catch((error) => console.error(`[publisher] ${error.message}`)), 10_000);
  timer.unref?.();
}

export function stopPublishReconciler() { if (timer) clearInterval(timer); timer = null; }
