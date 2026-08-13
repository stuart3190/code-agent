// Shared materialization/publishing support. The Android build worker uses this after creating a
// signing key so the published PWA serves matching assetlinks. It is deliberately not an HTTP route.

import crypto from "node:crypto";
import path from "node:path";
import { readdir, readFile } from "node:fs/promises";

import { buildTree, ensureDeps, workDirFor } from "../../../../harness/workspace.mjs";
import { withRuntimeEnv } from "../runtimeEnv.mjs";
import { withPwaAssets, renderIcons } from "../pwa.mjs";
import { ownedProject, serviceClient } from "../supabase.mjs";
import { assetlinksJson } from "../androidLinks.mjs";
import { ensureAppIdentity } from "../appIdentity.mjs";
import { auditEvent, recordRelease } from "../projectState.mjs";
import { requireFeature } from "../features.mjs";
import { auditCapabilityTree } from "../capabilityAudit.mjs";
import { packagePublishTree } from "../publishBuildWorker.mjs";
import { assertPublishIntakeReady, atomicPublishEnabled, finalizeAndActivateRelease } from "./atomicPublisher.mjs";
import { slugifySiteName } from "./siteSlug.mjs";

const PROVISIOND_URL = () => process.env.PROVISIOND_URL;
const PROVISIOND_TOKEN = () => process.env.PROVISIOND_TOKEN;
const RESERVED = new Set(["www", "api", "app", "apps", "preview", "admin", "mail", "buildr", "buildr101", "shell", "static", "assets"]);

async function claimSlug(owner, projectId, requestedName, { persist = true } = {}) {
  const svc = serviceClient();
  const { data: existing, error: exErr } = await svc
    .from("published_sites").select("slug, owner").eq("project_id", projectId).maybeSingle();
  if (exErr) throw new Error(`site lookup failed: ${exErr.message}`);

  const requested = requestedName ? slugifySiteName(requestedName) : null;
  if (requested !== null && requested.length < 3) {
    const error = new Error("Site name must be at least 3 characters (letters, numbers, dashes).");
    error.code = "bad_slug"; throw error;
  }
  if (requested !== null && RESERVED.has(requested)) {
    const error = new Error("That site name is reserved \u2014 pick another.");
    error.code = "bad_slug"; throw error;
  }
  if (!requested) return { slug: existing?.slug ?? null, previousSlug: null };
  if (existing?.slug === requested) return { slug: requested, previousSlug: null };

  const { data: holder, error: holderError } = await svc
    .from("published_sites").select("owner, project_id").eq("slug", requested).maybeSingle();
  if (holderError) throw new Error(`site name check failed: ${holderError.message}`);
  if (holder && !(holder.owner === owner.id && holder.project_id === projectId)) {
    const error = new Error(holder.owner === owner.id
      ? "That site name is used by another of your apps."
      : "That site name is taken \u2014 pick another.");
    error.code = "slug_taken"; throw error;
  }

  if (!persist) return { slug: existing?.slug || requested, previousSlug: null };
  if (existing) {
    const { error } = await svc.from("published_sites").update({ slug: requested }).eq("project_id", projectId);
    if (error) throw new Error(`site name claim failed: ${error.message}`);
  } else {
    const { error } = await svc.from("published_sites")
      .insert({ slug: requested, owner: owner.id, project_id: projectId });
    if (error) throw new Error(`site name claim failed: ${error.message}`);
  }
  return { slug: requested, previousSlug: existing?.slug ?? null };
}

async function provisiondPost(route, body) {
  const response = await fetch(`${PROVISIOND_URL()}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${PROVISIOND_TOKEN()}` },
    body: JSON.stringify(body),
  });
  const out = await response.json();
  if (!response.ok) throw new Error(out.error || `provisiond ${route} ${response.status}`);
  return out;
}

async function readDistAsBase64(dir) {
  const files = {};
  async function walk(relativeDir) {
    for (const entry of await readdir(path.join(dir, relativeDir), { withFileTypes: true })) {
      const child = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(child);
      else files[child] = (await readFile(path.join(dir, child))).toString("base64");
    }
  }
  await walk("");
  return files;
}

export async function materializeAndPublish({ owner, projectId, tree, name }) {
  if (!PROVISIOND_URL() || !PROVISIOND_TOKEN()) {
    const error = new Error("publishing is not configured (PROVISIOND_URL/TOKEN)");
    error.code = "not_configured"; throw error;
  }
  assertPublishIntakeReady();
  if (!(await ownedProject(owner.id, projectId))) {
    const error = new Error("project not found"); error.code = "project_not_found"; throw error;
  }
  await requireFeature(owner, "publish");
  const runtimeClient = serviceClient();
  const { data: actions, error: actionError } = await runtimeClient.from("project_actions").select("key")
    .eq("owner", owner.id).eq("project_id", projectId).eq("environment", "live").eq("enabled", true);
  if (actionError && actionError.code !== "PGRST205" && actionError.code !== "42P01") throw actionError;
  const capabilityAudit = auditCapabilityTree(tree, actions || []);
  if (!capabilityAudit.ok) {
    const error = new Error(`Publishing stopped: ${capabilityAudit.hardIssues[0]}`);
    error.code = "capability_incomplete"; throw error;
  }
  const { slug, previousSlug } = await claimSlug(owner, projectId, name, { persist: !atomicPublishEnabled() });
  const caseName = `pub-${projectId}`.replace(/[^a-zA-Z0-9_-]/g, "_");
  let appName = name;
  if (!appName) {
    const { data: project } = await serviceClient().from("projects").select("name").eq("id", projectId).maybeSingle();
    appName = project?.name || slug || "My app";
  }
  const identity = await ensureAppIdentity({ projectId, fallbackName: appName, log: console.log });
  if (!name) appName = identity.name;

  let publishTree = tree;
  const { data: keystore } = await serviceClient()
    .from("android_keystores").select("package_id, fingerprint").eq("project_id", projectId).maybeSingle();
  if (keystore) {
    publishTree = { ...tree, "public/.well-known/assetlinks.json": assetlinksJson(keystore.package_id, keystore.fingerprint) };
  }
  const runtimeTree = withPwaAssets(withRuntimeEnv(publishTree, projectId), { appName });
  const packaged = await packagePublishTree({
    owner: owner.id, projectId, tree: runtimeTree, appName, iconGlyph: identity.icon, renderIcons: true,
    idempotencyKey: `publish-package:${projectId}:${crypto.createHash("sha256")
      .update(JSON.stringify({ runtimeTree, appName, iconGlyph: identity.icon })).digest("hex")}`,
  });
  let files;
  if (!packaged) {
    await ensureDeps(() => {});
    const build = await buildTree(runtimeTree, caseName, () => {});
    if (!build.ok) {
      const error = new Error("build failed"); error.code = "build_failed";
      error.stderr = (build.stderr || "").slice(-2000); throw error;
    }
    await renderIcons({ appName, tree, iconGlyph: identity.icon,
      distDir: path.join(workDirFor(caseName), "dist"), log: console.log });
    files = await readDistAsBase64(path.join(workDirFor(caseName), "dist"));
  } else files = packaged.files;

  const atomic = atomicPublishEnabled() ? await finalizeAndActivateRelease({
    owner: owner.id, projectId, slug: slug || String(projectId),
    url: `https://${slug || projectId}.app.thrallo.com/`, files,
    runtimeConfig: runtimeTree[".env"],
    metadata: { surface: "legacy-materialize", workerJobId: packaged?.workJobId || null },
  }) : null;
  const out = atomic ? { id: atomic.slug, url: atomic.url, files: atomic.files, bytes: atomic.bytes }
    : await provisiondPost("/publish", { projectId, files, slug: slug || undefined });
  const release = await recordRelease({
    owner: owner.id, projectId, environment: "live", tree,
    config: { slug: slug || out.id, url: out.url, files: out.files, bytes: out.bytes },
  }).catch((error) => { console.error(`[publish] release record failed: ${error.message}`); return null; });
  if (release?.id) {
    const client = serviceClient();
    const { data: environment } = await client.from("project_environments").select("config")
      .eq("project_id", projectId).eq("environment", "live").maybeSingle();
    const { error } = await client.from("project_environments").update({
      config: { ...(environment?.config || {}), current_release_id: release.id, url: out.url },
      updated_at: new Date().toISOString(),
    }).eq("project_id", projectId).eq("environment", "live");
    if (error) console.error(`[publish] environment pointer failed: ${error.message}`);
  }
  await auditEvent({
    owner: owner.id, projectId, action: "project.published", target: slug || out.id,
    metadata: { url: out.url, releaseId: release?.id || null },
  }).catch((error) => console.error(`[publish] audit failed: ${error.message}`));
  if (slug && !atomic) {
    if (previousSlug && previousSlug !== slug) {
      await provisiondPost("/unpublish", { projectId, slug: previousSlug }).catch(() => {});
    } else if (!previousSlug) await provisiondPost("/unpublish", { projectId }).catch(() => {});
  }
  return { url: out.url, files: out.files, bytes: out.bytes, slug: slug || out.id, releaseId: release?.id || null };
}
