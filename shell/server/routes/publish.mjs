// POST /api/publish  { projectId, tree }  -> { url, files, bytes }
//
// F7 publish v1: static export to the VPS. Builds the tree (same bar as generate), reads the
// resulting dist/, and ships it base64-encoded to provisiond's /publish, which serves it on
// https://<label>.app.buildr101.com. The runtime backend config is injected at build time
// (withRuntimeEnv) — "backend as a parameter" (DECISION-hosting.md) holds: the SAVED tree and
// export ZIPs stay clean; a different backend later = republish, no code change.

import path from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { buildTree, ensureDeps, workDirFor } from "../../../harness/workspace.mjs";
import { withRuntimeEnv } from "../lib/runtimeEnv.mjs";
import { withPwaAssets, renderIcons } from "../lib/pwa.mjs";
import { ownedProject, serviceClient } from "../lib/supabase.mjs";
import { assetlinksJson } from "../lib/androidLinks.mjs";
import { ensureAppIdentity } from "../lib/appIdentity.mjs";
import { auditEvent, recordRelease } from "../lib/projectState.mjs";
import { requireFeature } from "../lib/features.mjs";
import { auditCapabilityTree } from "../lib/capabilityAudit.mjs";

const PROVISIOND_URL = () => process.env.PROVISIOND_URL;
const PROVISIOND_TOKEN = () => process.env.PROVISIOND_TOKEN;

// Publishing is a paid feature: free users build and preview; any paid tier puts the app on a
// live URL (custom domains are gated separately at Pro+ in routes/domains.mjs). Enforced at
// PUBLISH time only — unpublish stays open (taking things down is never paywalled), and already-
// published sites keep serving if a subscription lapses.
// Mirrors provisiond's reserved list (provisiond re-enforces; this gives the friendly 409).
const RESERVED = new Set(["www", "api", "app", "apps", "preview", "admin", "mail", "buildr", "buildr101", "shell", "static", "assets"]);

// Site names: normalize free text to a DNS-safe slug ("Ledger & Co" -> "ledger-co").
export function slugify(name) {
  return String(name || "").toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
}

// Claim/renew the slug for this project (published_sites, service role — ownership is enforced
// HERE, not in the browser). Returns the slug to publish under, or throws { code: "slug_taken" }.
// A rename (new slug for an already-claimed project) frees + unpublishes the old label.
async function claimSlug(owner, projectId, requestedName) {
  const svc = serviceClient();
  const { data: existing, error: exErr } = await svc
    .from("published_sites").select("slug, owner").eq("project_id", projectId).maybeSingle();
  if (exErr) throw new Error(`site lookup failed: ${exErr.message}`);

  const requested = requestedName ? slugify(requestedName) : null;
  if (requested !== null && requested.length < 3) {
    const e = new Error("Site name must be at least 3 characters (letters, numbers, dashes).");
    e.code = "bad_slug"; throw e;
  }
  if (requested !== null && RESERVED.has(requested)) {
    const e = new Error("That site name is reserved — pick another.");
    e.code = "bad_slug"; throw e;
  }

  // No name requested: reuse the existing claim (republish) or fall back to the legacy label.
  if (!requested) return { slug: existing?.slug ?? null, previousSlug: null };
  if (existing?.slug === requested) return { slug: requested, previousSlug: null };

  const { data: holder, error: hErr } = await svc
    .from("published_sites").select("owner, project_id").eq("slug", requested).maybeSingle();
  if (hErr) throw new Error(`site name check failed: ${hErr.message}`);
  if (holder && !(holder.owner === owner.id && holder.project_id === projectId)) {
    const e = new Error(holder.owner === owner.id
      ? "That site name is used by another of your apps."
      : "That site name is taken — pick another.");
    e.code = "slug_taken"; throw e;
  }

  // A project holds exactly ONE row (unique project_id index), so a rename must MOVE the existing
  // row's slug in place — inserting a second row for the same project violates that index (the old
  // upsert-on-slug-then-delete did exactly that and 500'd on every rename).
  if (existing) {
    const { error: updErr } = await svc.from("published_sites")
      .update({ slug: requested }).eq("project_id", projectId);
    if (updErr) throw new Error(`site name claim failed: ${updErr.message}`);
  } else {
    const { error: insErr } = await svc.from("published_sites")
      .insert({ slug: requested, owner: owner.id, project_id: projectId });
    if (insErr) throw new Error(`site name claim failed: ${insErr.message}`);
  }
  return { slug: requested, previousSlug: existing?.slug ?? null };
}

async function provisiondPost(route, body) {
  const r = await fetch(`${PROVISIOND_URL()}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${PROVISIOND_TOKEN()}` },
    body: JSON.stringify(body),
  });
  const out = await r.json();
  if (!r.ok) throw new Error(out.error || `provisiond ${route} ${r.status}`);
  return out;
}

async function readDistAsBase64(dir) {
  const files = {};
  async function walk(relDir) {
    for (const entry of await readdir(path.join(dir, relDir), { withFileTypes: true })) {
      const childRel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(childRel);
      else files[childRel] = (await readFile(path.join(dir, childRel))).toString("base64");
    }
  }
  await walk("");
  return files;
}

// POST /api/unpublish { projectId } — remove the published static site (the URL then 404s).
// The site-name claim is KEPT (the name stays reserved for this project; republish reuses it).
export async function handleUnpublish(req, res, body, owner) {
  const projectId = body?.projectId;
  if (!projectId) {
    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "projectId is required" }));
  }
  if (!PROVISIOND_URL() || !PROVISIOND_TOKEN()) {
    res.writeHead(503, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "publishing is not configured (PROVISIOND_URL/TOKEN)" }));
  }
  try {
    if (!(await ownedProject(owner.id, projectId))) {
      res.writeHead(404, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "project not found" }));
    }
    const { slug } = await claimSlug(owner, projectId, null); // lookup only — no name requested
    const out = await provisiondPost("/unpublish", { projectId, slug: slug || undefined });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ unpublished: out.unpublished }));
  } catch (e) {
    console.error(`[unpublish] ${e?.stack || e}`);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "The app could not be unpublished. Please try again." }));
  }
}

// The materialize+publish core, reusable by the publish route AND the Android export (which
// republishes the tree with assetlinks injected). Enforces tier, claims/renews the slug, builds
// the PWA-materialized tree, renders icons into dist, ships to provisiond, retires the old label
// on a rename. Throws coded errors (upgrade_required / slug_taken / bad_slug / build failed).
// Returns { url, slug, files, bytes }.
export async function materializeAndPublish({ owner, projectId, tree, name }) {
  if (!PROVISIOND_URL() || !PROVISIOND_TOKEN()) {
    const e = new Error("publishing is not configured (PROVISIOND_URL/TOKEN)"); e.code = "not_configured"; throw e;
  }
  if (!(await ownedProject(owner.id, projectId))) {
    const e = new Error("project not found"); e.code = "project_not_found"; throw e;
  }
  await requireFeature(owner, "publish");
  const runtimeClient = serviceClient();
  const { data: actions, error: actionError } = await runtimeClient.from("project_actions").select("key")
    .eq("owner", owner.id).eq("project_id", projectId).eq("environment", "live").eq("enabled", true);
  if (actionError && actionError.code !== "PGRST205" && actionError.code !== "42P01") throw actionError;
  const capabilityAudit = auditCapabilityTree(tree, actions || []);
  if (!capabilityAudit.ok) {
    const e = new Error(`Publishing stopped: ${capabilityAudit.hardIssues[0]}`);
    e.code = "capability_incomplete";
    throw e;
  }
  // Claim (or renew) the site name FIRST — a taken name should fail before the build spend.
  const { slug, previousSlug } = await claimSlug(owner, projectId, name);

  await ensureDeps(() => {});
  const caseName = `pub-${projectId}`.replace(/[^a-zA-Z0-9_-]/g, "_");
  // PWA assets ride ONLY the publish materialization — previews stay service-worker-free.
  // Manifest/icon name: the dialog's site name, else the project's display name, else the slug.
  let appName = name;
  if (!appName) {
    const { data: proj } = await serviceClient()
      .from("projects").select("name").eq("id", projectId).maybeSingle();
    appName = proj?.name || slug || "My app";
  }
  // Generated identity: a real app name + icon glyph (once per project, cached). The manifest
  // display name uses the generated name UNLESS the user typed an explicit site name at publish.
  const identity = await ensureAppIdentity({ projectId, fallbackName: appName, log: console.log });
  if (!name) appName = identity.name;
  const iconGlyph = identity.icon;
  // Once a project has generated an Android app, EVERY publish must keep serving its assetlinks —
  // otherwise a plain republish would break the installed app's full-screen verification.
  let publishTree = tree;
  const { data: ks } = await serviceClient()
    .from("android_keystores").select("package_id, fingerprint").eq("project_id", projectId).maybeSingle();
  if (ks) {
    publishTree = { ...tree, "public/.well-known/assetlinks.json": assetlinksJson(ks.package_id, ks.fingerprint) };
  }
  const build = await buildTree(withPwaAssets(withRuntimeEnv(publishTree, projectId), { appName }), caseName, () => {});
  if (!build.ok) {
    const e = new Error("build failed"); e.code = "build_failed"; e.stderr = (build.stderr || "").slice(-2000); throw e;
  }
  // Binary icons can't ride the UTF-8 tree — render them straight into the built dist.
  await renderIcons({ appName, tree, iconGlyph, distDir: path.join(workDirFor(caseName), "dist"), log: console.log });
  const files = await readDistAsBase64(path.join(workDirFor(caseName), "dist"));
  const out = await provisiondPost("/publish", { projectId, files, slug: slug || undefined });
  const release = await recordRelease({
    owner: owner.id, projectId, environment: "live", tree,
    config: { slug: slug || out.id, url: out.url, files: out.files, bytes: out.bytes },
  }).catch((error) => { console.error(`[publish] release record failed: ${error.message}`); return null; });
  if (release?.id) {
    const client = serviceClient();
    const { data: environment } = await client.from("project_environments").select("config")
      .eq("project_id", projectId).eq("environment", "live").maybeSingle();
    const { error: environmentError } = await client.from("project_environments").update({
      config: { ...(environment?.config || {}), current_release_id: release.id, url: out.url }, updated_at: new Date().toISOString(),
    }).eq("project_id", projectId).eq("environment", "live");
    if (environmentError) console.error(`[publish] environment pointer failed: ${environmentError.message}`);
  }
  await auditEvent({
    owner: owner.id, projectId, action: "project.published", target: slug || out.id,
    metadata: { url: out.url, releaseId: release?.id || null },
  }).catch((error) => console.error(`[publish] audit failed: ${error.message}`));
  // A rename retires the old address so stale URLs stop serving; naming a legacy-published
  // project likewise retires its old UUID label (no-op when that dir never existed).
  if (slug) {
    if (previousSlug && previousSlug !== slug) {
      await provisiondPost("/unpublish", { projectId, slug: previousSlug }).catch(() => {});
    } else if (!previousSlug) {
      await provisiondPost("/unpublish", { projectId }).catch(() => {});
    }
  }
  return { url: out.url, files: out.files, bytes: out.bytes, slug: slug || out.id, releaseId: release?.id || null };
}

export async function handlePublish(req, res, body, owner) {
  const projectId = body?.projectId;
  const tree = body?.tree;
  const name = typeof body?.name === "string" ? body.name : null;
  if (!projectId || !tree || typeof tree !== "object") {
    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "projectId and tree are required" }));
  }
  try {
    const out = await materializeAndPublish({ owner, projectId, tree, name });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(out));
  } catch (e) {
    if (e.code === "not_configured") {
      res.writeHead(503, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: e.message }));
    }
    if (e.code === "build_failed") {
      res.writeHead(422, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "The app did not compile. Return to the builder and use Fix it." }));
    }
    if (e.code === "capability_incomplete") {
      res.writeHead(422, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: e.message, code: e.code }));
    }
    const status = e.code === "upgrade_required" ? 402
      : e.code === "slug_taken" || e.code === "bad_slug" ? 409
      : e.code === "project_not_found" ? 404 : 500;
    if (status === 500) console.error(`[publish] ${e?.stack || e}`);
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: status === 500 ? "Publishing failed. Please try again." : e.message, code: e.code }));
  }
}

// Slug lookup for other routes (Android export precondition): the project's current published
// slug or null. Read-only — never claims.
export async function publishedSlug(projectId) {
  const { data } = await serviceClient()
    .from("published_sites").select("slug").eq("project_id", projectId).maybeSingle();
  return data?.slug || null;
}
