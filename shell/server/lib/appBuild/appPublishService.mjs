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
import { logProject } from "../logs/projectLog.mjs";
// The ONE domain implementation. Conversation and the Domains panel now call the same function,
// so there is no second path that could skip verification.
import { addDomain, normalizeDomain } from "../customDomains.mjs";

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
/**
 * The address this product is published at.
 *
 * A slug belongs to the PRODUCT, not to one project row. Every rebuild inserts a new project, so
 * resolving per project meant a rebuilt app claimed a fresh URL while the old one kept serving —
 * and the new URL broke the custom domain (whose CNAME target and Caddy label are built from the
 * slug) and orphaned analytics (whose app id IS the slug).
 *
 * So: once published, an address is never given up. It is only minted for a product that has
 * never been live. Renaming a project does not change where it lives, which is what anyone would
 * expect of a URL they have given to other people.
 *
 * Returns `{ slug, supersedes }` — `supersedes` is the project id currently holding the row, when
 * the address is being inherited from an earlier build of the same product.
 */
export async function claimSlug(ownerId, projectId, wanted, { productId = null, client = serviceClient() } = {}) {

  const { data: own } = await client.from("published_sites")
    .select("slug").eq("project_id", String(projectId)).eq("owner", ownerId).maybeSingle();
  // Already published: keep the address, whatever the project is called now.
  if (own?.slug) return { slug: own.slug, supersedes: null };

  if (productId) {
    const { projectsForProduct } = await import("./projectScope.mjs");
    const siblings = await projectsForProduct(ownerId, productId, client);
    const ids = siblings.map((p) => String(p.id)).filter((id) => id !== String(projectId));
    if (ids.length) {
      const { data: inherited } = await client.from("published_sites")
        .select("slug, project_id, updated_at").eq("owner", ownerId).in("project_id", ids)
        .order("updated_at", { ascending: false }).limit(1);
      const row = inherited?.[0];
      // An earlier build of this same product is live. This build replaces it at the same address
      // rather than starting a second site.
      if (row?.slug) return { slug: row.slug, supersedes: String(row.project_id) };
    }
  }

  const base = slugify(wanted || "") || null;
  if (!base) return { slug: null, supersedes: null };
  for (let n = 0; n < 20; n += 1) {
    const candidate = n === 0 ? base : `${base}-${n + 1}`;
    const { data: holder } = await client.from("published_sites")
      .select("project_id").eq("slug", candidate).maybeSingle();
    if (holder && holder.project_id !== String(projectId)) continue;
    if (!holder) {
      const taken = await provisiond(`/exists?label=${encodeURIComponent(candidate)}`, { method: "GET" });
      if (taken.exists) continue; // a frozen Buildr site owns that label on disk
    }
    return { slug: candidate, supersedes: null };
  }
  const error = new Error(`No available site name near "${base}" — pick another name.`);
  error.code = "slug_taken";
  throw error;
}

// Move an existing site record onto the project that now backs it, rather than deleting and
// re-inserting. This keeps created_at — the date the product first went live, which deployment
// history depends on — and avoids ever having two rows claiming one slug (it is unique).
async function transferSite(ownerId, fromProjectId, toProjectId, client = serviceClient()) {
  // The product travels with the row. Moving the record between two projects of the same product
  // must not leave product_id pointing at where it used to be, or the one-live-row-per-product
  // index would be guarding the wrong group.
  const { data: target } = await client.from("projects")
    .select("product_id").eq("id", String(toProjectId)).eq("owner", ownerId).maybeSingle();
  const { error } = await client.from("published_sites")
    .update({
      project_id: String(toProjectId),
      product_id: target?.product_id ? String(target.product_id) : null,
      updated_at: new Date().toISOString(),
    })
    .eq("project_id", String(fromProjectId)).eq("owner", ownerId);
  if (error) throw new Error(`could not transfer the published site record: ${error.message}`);
}

// The old `resolveProject` lived here and resolved "the owner's newest project with a tree",
// ignoring the conversation entirely. It is deleted rather than left unused: it is a one-line
// reach away from reintroducing the bug, and lib/appBuild/projectScope.mjs replaces it everywhere.

export async function publishApp(ctx, { projectId = null, siteName = null, productName = null }) {
  if (!publishConfigured()) {
    const error = new Error("Publishing infrastructure is not configured.");
    error.code = "not_configured";
    throw error;
  }
  // Scoped to THIS conversation's product. Publishing whatever happened to be newest is how
  // "publish it" could take a different app live.
  const { resolveConversationProject } = await import("./projectScope.mjs");
  const { project, productId, scope } = await resolveConversationProject(ctx, { projectId, productName });
  if (!project) {
    const error = new Error(scope === "unknown_product"
      ? `I couldn't find an app called "${productName}". Which one did you mean?`
      : "There's no built app to publish yet — build something first and I'll take it live.");
    error.code = "nothing_to_publish";
    throw error;
  }

  await ctx.emit("agent_spawned", { agent: "Publisher", status: `Publishing ${project.name || "your app"}…` });
  const startedAt = Date.now();
  logProject({ owner: ctx.owner, projectId: project.id, source: "publish", message: "Publish started" });
  try {
    const claim = await claimSlug(ctx.owner, project.id, siteName || project.name, { productId });
    const slug = claim.slug;
    // A rebuild of this product inherits the live address. Move the record onto this project
    // BEFORE publishing, so the unique slug is never held by two rows and the site keeps its
    // first-published date.
    if (claim.supersedes) await transferSite(ctx.owner, claim.supersedes, project.id);

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
      // Carried onto the row so the database can hold "one live record per product" itself. A rule
      // that lives only in application code is a rule the next writer can forget.
      product_id: project.product_id ? String(project.product_id) : null,
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
    logProject({
      owner: ctx.owner, projectId: project.id, source: "deploy", level: "info",
      message: `Deployed to ${out.url}`, refType: "deployment", refId: out.id,
      durationMs: Date.now() - startedAt,
    });
    notifyOwner(ctx.owner, {
      title: "Published",
      body: `${project.name || "Your app"} is live.`,
      url: out.url,
      tag: `publish-${project.id}`,
    }).catch(() => {});
    return { url: out.url, slug: out.id, files: out.files, note: "Published. The live URL is in the conversation." };
  } catch (error) {
    await ctx.emit("agent_done", { agent: "Publisher", ok: false });
    // The stderr of a failed production build is exactly what someone needs in the log, and it is
    // otherwise only visible in the conversation that produced it.
    logProject({
      owner: ctx.owner, projectId: project.id, source: "publish", level: "error",
      message: "Publish failed", detail: error?.stderr || error?.message || String(error),
      durationMs: Date.now() - startedAt,
    });
    throw error;
  }
}

/**
 * Connect a custom domain from conversation.
 *
 * This used to be a SECOND implementation of domain creation, and a worse one: it upserted a row
 * with no verification token — so the panel offered an empty TXT record to copy and the domain
 * could never verify, sitting stuck until it was stamped failed at 48 hours — attached the
 * hostname to Caddy immediately, before any ownership proof, and told the user to add an A record
 * when the UI required a TXT record too. It also read PUBLISH_IP while verification read
 * THRALLO_PUBLIC_IP, so the address it dictated could differ from the one actually checked.
 *
 * There is now one path. This resolves scope, then calls `addDomain` — the same function the
 * Domains panel calls, with the same token, the same Pending DNS start, the same plan allowance,
 * and the same rule that nothing is attached to Caddy until both proofs pass.
 */
export async function connectDomain(ctx, { domain, productName = null, projectId = null }) {
  const cleaned = normalizeDomain(domain);
  if (!cleaned) {
    const error = new Error("That doesn't look like a domain I can connect (e.g. yourbusiness.com).");
    error.code = "bad_domain";
    throw error;
  }

  // No owner-newest fallback. Pointing a customer's own hostname at whichever app was touched most
  // recently is not a mild mistake — it publishes the wrong product at their address. If the
  // conversation cannot say which project it means, the honest answer is to ask.
  const { resolveConversationProject } = await import("./projectScope.mjs");
  const { project, scope } = await resolveConversationProject(ctx, {
    projectId, productName, allowOwnerFallback: false,
  });
  if (!project) {
    const error = new Error(scope === "ambiguous"
      ? "Tell me which app this domain is for and I'll connect it."
      : "Publish the app first, then I'll connect the domain to it.");
    error.code = scope === "ambiguous" ? "ambiguous_project" : "not_published";
    throw error;
  }

  // addDomain does the rest: allowance, ownership conflicts, token, Pending DNS, and an immediate
  // check for anyone who set their DNS up in advance.
  const result = await addDomain(ctx.owner, project.id, cleaned, { attach: attachDomain });

  const records = result.records || [];
  const verification = records.find((r) => r.purpose === "verification");
  const routing = records.find((r) => r.purpose === "routing");
  const instructions = [
    `Add these two DNS records for ${cleaned}:`,
    verification && `  ${verification.type}  ${verification.name}  →  ${verification.value}`,
    routing && `  ${routing.type}  ${routing.name}  →  ${routing.value}`,
    "I'll check for them automatically. The certificate is issued once ownership is verified —"
    + " never before. Your Thrallo address keeps working the whole time.",
  ].filter(Boolean).join("\n");

  await ctx.emit("domain", {
    domain: cleaned, projectId: String(project.id), status: result.status,
    records, note: instructions,
  });

  return { domain: cleaned, status: result.status, records, instructions, alreadyConnected: !!result.alreadyConnected };
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

  // A site that is offline must not leave other surfaces claiming otherwise. Without this the
  // Domains tab kept saying "Active · Live and secured with HTTPS" while the hostname 404'd, and
  // the health badge stayed pinned to whatever it last saw.
  const client2 = serviceClient();
  const { data: domains } = await client2.from("custom_domains")
    .select("domain").eq("project_id", String(projectId)).eq("owner", owner);
  for (const row of domains || []) {
    await detachDomain(row.domain).catch((error) =>
      console.error(`[unpublish] detach ${row.domain}: ${error?.message || error}`));
  }
  if (domains?.length) {
    // Back to pending rather than failed: the domain is not broken, it simply has nothing to
    // point at until the project is published again, and republishing re-verifies it.
    await client2.from("custom_domains")
      .update({ status: "pending_dns", ssl_status: "pending", updated_at: new Date().toISOString() })
      .eq("project_id", String(projectId)).eq("owner", owner);
  }
  // Health has nothing to measure once the site is gone; a stale row would keep reporting.
  await client2.from("health_status").delete().eq("project_id", String(projectId)).eq("owner", owner);

  logProject({
    owner, projectId, source: "deploy", level: "warning",
    message: "Site unpublished", detail: `${site.url} is no longer served.`,
  });
  return { url: site.url, alreadyOffline: false, domainsDetached: (domains || []).length };
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
