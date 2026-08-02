// publishApp: the conversational publish path (Phase 22). Lean by design — the legacy
// materializeAndPublish carries tier gates, releases, app-identity generation, and Android
// concerns that stay behind until they earn their place. This one does the essentials with
// full progress choreography (docs/DESIGN.md: silence must never be mistakable for
// inactivity): claim a friendly slug, build the project's tree for production, ship the
// dist to Thrallo's provisiond, record it, and hand back https://<slug>.app.thrallo.com.

import path from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { serviceClient } from "../supabase.mjs";
import { optionalEnv } from "../env.mjs";
import { ensureDeps, buildTree, workDirFor } from "../../../../harness/workspace.mjs";
import { slugify } from "../../routes/publish.mjs";
import { notifyOwner } from "../notifications/notificationService.mjs";

const PROVISIOND_URL = () => optionalEnv("PROVISIOND_URL");
const PROVISIOND_TOKEN = () => optionalEnv("PROVISIOND_TOKEN");

export const publishConfigured = () => !!(PROVISIOND_URL() && PROVISIOND_TOKEN());

async function provisiond(route, { method = "POST", body } = {}) {
  const res = await fetch(`${PROVISIOND_URL()}${route}`, {
    method,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      Authorization: `Bearer ${PROVISIOND_TOKEN()}`,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(out.error || `provisiond ${route} ${res.status}`);
    error.code = out.code;
    throw error;
  }
  return out;
}

async function readDistAsBase64(dir, base = "") {
  const files = {};
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) Object.assign(files, await readDistAsBase64(full, rel));
    else files[rel] = (await readFile(full)).toString("base64");
  }
  return files;
}

// Analytics is added to the artifact at publish time rather than built into the app, so it stays
// current without the user rebuilding, and so an exported project carries none of it.
//
// The script is written into the site itself rather than loaded from Thrallo: same-origin means no
// third-party request on someone else's site, no dependency on our CDN being up for their page to
// render, and nothing for a tracker blocker to recognise as third-party.
async function withAnalytics(files, appId) {
  const { analyticsScript, injectAnalytics, ANALYTICS_SCRIPT_PATH } = await import("../analytics/clientScript.mjs");
  const origin = optionalEnv("THRALLO_APP_ORIGIN", "https://app.thrallo.com").replace(/\/$/, "");
  const out = { ...files };

  out[ANALYTICS_SCRIPT_PATH.replace(/^\//, "")] = Buffer.from(
    analyticsScript({ endpoint: `${origin}/api/analytics/collect`, appId }), "utf8",
  ).toString("base64");

  for (const [name, encoded] of Object.entries(files)) {
    if (!name.endsWith(".html")) continue;
    const html = Buffer.from(encoded, "base64").toString("utf8");
    const injected = injectAnalytics(html);
    if (injected !== html) out[name] = Buffer.from(injected, "utf8").toString("base64");
  }
  return out;
}

// Friendly, unique slug: the requested/site name first, else the project name. Collisions —
// including labels the shared publish root already holds for the frozen Buildr sites — get
// a numeric suffix rather than an error the user has to solve.
export async function claimSlug(ownerId, projectId, wanted) {
  const client = serviceClient();
  const { data: existing } = await client.from("published_sites")
    .select("slug").eq("project_id", String(projectId)).maybeSingle();
  const base = slugify(wanted || "") || existing?.slug || null;
  if (!base) return existing?.slug || null;
  if (existing?.slug === base) return base;
  for (let n = 0; n < 20; n += 1) {
    const candidate = n === 0 ? base : `${base}-${n + 1}`;
    const { data: holder } = await client.from("published_sites")
      .select("project_id").eq("slug", candidate).maybeSingle();
    if (holder && holder.project_id !== String(projectId)) continue;
    if (!holder) {
      const taken = await provisiond(`/exists?label=${encodeURIComponent(candidate)}`, { method: "GET" });
      if (taken.exists) continue; // a frozen Buildr site owns that label on disk
    }
    return candidate;
  }
  const error = new Error(`No available site name near "${base}" — pick another name.`);
  error.code = "slug_taken";
  throw error;
}

async function resolveProject(ownerId, { projectId = null, productName = null }) {
  const client = serviceClient();
  let query = client.from("projects").select("id, name, tree, product_id, updated_at")
    .eq("owner", ownerId).not("tree", "is", null)
    .order("updated_at", { ascending: false }).limit(1);
  if (projectId) query = query.eq("id", projectId);
  else if (productName) {
    const { data: product } = await client.from("ca_products")
      .select("id").eq("owner", ownerId).ilike("name", productName).maybeSingle();
    if (product) query = query.eq("product_id", product.id);
  }
  const { data } = await query;
  return data?.[0] || null;
}

export async function publishApp(ctx, { projectId = null, siteName = null, productName = null }) {
  if (!publishConfigured()) {
    const error = new Error("Publishing infrastructure is not configured.");
    error.code = "not_configured";
    throw error;
  }
  const project = await resolveProject(ctx.owner, { projectId, productName });
  if (!project) {
    const error = new Error("There's no built app to publish yet — build something first and I'll take it live.");
    error.code = "nothing_to_publish";
    throw error;
  }

  await ctx.emit("agent_spawned", { agent: "Publisher", status: `Publishing ${project.name || "your app"}…` });
  try {
    const slug = await claimSlug(ctx.owner, project.id, siteName || project.name);

    await ctx.emit("agent_status", { agent: "Publisher", status: "Building for production…" });
    await ensureDeps(() => {});
    const caseName = `pub-${project.id}`.replace(/[^a-zA-Z0-9_-]/g, "_");
    const { withRuntimeEnv } = await import("../runtimeEnv.mjs");
    const build = await buildTree(withRuntimeEnv(project.tree, project.id), caseName, () => {});
    if (!build.ok) {
      const error = new Error("The production build failed — I can fix the app and retry.");
      error.code = "build_failed";
      error.stderr = (build.stderr || "").slice(-2000);
      throw error;
    }

    await ctx.emit("agent_status", { agent: "Publisher", status: "Uploading to the edge…" });
    const built = await readDistAsBase64(path.join(workDirFor(caseName), "dist"));
    // The slug is the app id analytics reports under, and it is already claimed by this point.
    const files = slug ? await withAnalytics(built, slug) : built;
    const out = await provisiond("/publish", { body: { projectId: project.id, files, slug: slug || undefined } });

    await ctx.emit("agent_status", { agent: "Publisher", status: "Going live…" });
    const { error: upsertError } = await serviceClient().from("published_sites").upsert({
      owner: ctx.owner, project_id: String(project.id), slug: out.id, url: out.url,
      updated_at: new Date().toISOString(),
      // Republishing after an unpublish returns the site to live. Without clearing this the
      // project would show as unpublished while its URL was serving again.
      unpublished_at: null,
    }, { onConflict: "project_id" });
    if (upsertError) console.error(`[publish] record failed: ${upsertError.message}`);

    // Outcome evidence: a site that went live is the strongest signal a build was kept.
    // Recorded after the site is actually serving, and never allowed to fail the publish.
    const { signalBuildOutcome } = await import("../buildOutcomes.mjs");
    signalBuildOutcome({ owner: ctx.owner, projectId: project.id, signal: "deployed" }).catch(() => {});

    await ctx.emit("agent_done", { agent: "Publisher", ok: true });
    await ctx.emit("published", { url: out.url, slug: out.id, projectId: project.id });
    notifyOwner(ctx.owner, {
      title: "Published",
      body: `${project.name || "Your app"} is live.`,
      url: out.url,
      tag: `publish-${project.id}`,
    }).catch(() => {});
    return { url: out.url, slug: out.id, files: out.files, note: "Published. The live URL is in the conversation." };
  } catch (error) {
    await ctx.emit("agent_done", { agent: "Publisher", ok: false });
    throw error;
  }
}

// Custom domains: record + attach. The ask gate (previewDomainCheck) starts approving the
// domain the moment the row exists; certs are issued at first handshake once DNS points here.
export async function connectDomain(ctx, { domain, productName = null }) {
  const cleaned = String(domain || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!/^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(cleaned) || cleaned.endsWith(".thrallo.com")) {
    const error = new Error("That doesn't look like a domain I can connect (e.g. yourbusiness.com).");
    error.code = "bad_domain";
    throw error;
  }
  const project = await resolveProject(ctx.owner, { productName });
  const client = serviceClient();
  const { data: site } = project
    ? await client.from("published_sites").select("slug").eq("project_id", String(project.id)).maybeSingle()
    : { data: null };
  if (!site) {
    const error = new Error("Publish the app first, then I'll connect the domain to it.");
    error.code = "not_published";
    throw error;
  }
  const { data: holder } = await client.from("custom_domains").select("owner").eq("domain", cleaned).maybeSingle();
  if (holder && holder.owner !== ctx.owner) {
    const error = new Error("That domain is already connected to another app.");
    error.code = "domain_taken";
    throw error;
  }
  const { error: upsertError } = await client.from("custom_domains").upsert({
    domain: cleaned, owner: ctx.owner, project_id: String(project.id), slug: site.slug,
  }, { onConflict: "domain" });
  if (upsertError) throw new Error(upsertError.message);
  await provisiond("/domain-attach", { body: { domain: cleaned, label: site.slug } });
  const ip = optionalEnv("PUBLISH_IP", "51.195.136.189");
  await ctx.emit("published", {
    url: `https://${cleaned}`, slug: site.slug, projectId: project.id,
    note: `Domain connected — point an A record for ${cleaned} to ${ip} and it goes live with its own certificate.`,
  });
  return {
    domain: cleaned, ip,
    instructions: `Point an A record for ${cleaned} to ${ip}. The certificate is issued automatically on the first visit once DNS resolves.`,
  };
}

// Take a published site offline.
//
// The published_sites row is stamped, never deleted: the slug stays claimed so republishing
// returns to the same address, and the publish history remains answerable. provisiond removes the
// files, which is what actually makes the URL stop serving.
export async function unpublishApp(owner, projectId) {
  if (!publishConfigured()) {
    const error = new Error("Publishing infrastructure is not configured.");
    error.code = "not_configured";
    throw error;
  }
  const client = serviceClient();
  const { data: site } = await client.from("published_sites")
    .select("project_id,slug,url,unpublished_at")
    .eq("project_id", String(projectId)).eq("owner", owner).maybeSingle();
  if (!site) {
    const error = new Error("That project isn't published.");
    error.code = "not_published";
    throw error;
  }
  if (site.unpublished_at) return { url: site.url, alreadyOffline: true };

  await provisiond("/unpublish", { body: { projectId: String(projectId), slug: site.slug } });

  const { error: updateError } = await client.from("published_sites")
    .update({ unpublished_at: new Date().toISOString() })
    .eq("project_id", String(projectId)).eq("owner", owner);
  // The files are already gone, so the site IS offline. Failing the request here would tell the
  // user it did not work while their site was down — the worst of both.
  if (updateError) console.error(`[unpublish] record failed: ${updateError.message}`);

  return { url: site.url, alreadyOffline: false };
}

// Caddy learns about a custom hostname through provisiond. Exported so the domain verifier can
// attach ONLY at the moment a domain becomes verified — attaching earlier is what would let an
// unverified hostname reach certificate issuance.
export async function attachDomain(domain, slug) {
  return provisiond("/domain-attach", { body: { domain, label: slug } });
}

export async function detachDomain(domain) {
  return provisiond("/domain-detach", { body: { domain } });
}
