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
import { serviceClient } from "../lib/supabase.mjs";
import { ledger } from "../lib/services.mjs";

const PROVISIOND_URL = () => process.env.PROVISIOND_URL;
const PROVISIOND_TOKEN = () => process.env.PROVISIOND_TOKEN;

// Publishing is a paid feature: free users build and preview; any paid tier puts the app on a
// live URL (custom domains are gated separately at Pro+ in routes/domains.mjs). Enforced at
// PUBLISH time only — unpublish stays open (taking things down is never paywalled), and already-
// published sites keep serving if a subscription lapses.
const PUBLISH_TIERS = new Set(["starter", "pro", "studio"]);
async function requirePublishTier(owner) {
  const ent = await ledger().getEntitlement(owner.id).catch(() => null);
  if (!PUBLISH_TIERS.has(ent?.tier)) {
    const e = new Error("Publishing is included in every paid plan — subscribe in the Plans panel to put your app on a live URL.");
    e.code = "upgrade_required";
    throw e;
  }
}

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

  const { error: upErr } = await svc.from("published_sites")
    .upsert({ slug: requested, owner: owner.id, project_id: projectId }, { onConflict: "slug" });
  if (upErr) throw new Error(`site name claim failed: ${upErr.message}`);
  if (existing && existing.slug !== requested) {
    await svc.from("published_sites").delete().eq("slug", existing.slug).eq("project_id", projectId);
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
    const { slug } = await claimSlug(owner, projectId, null); // lookup only — no name requested
    const out = await provisiondPost("/unpublish", { projectId, slug: slug || undefined });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ unpublished: out.unpublished }));
  } catch (e) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: e.message }));
  }
}

export async function handlePublish(req, res, body, owner) {
  const projectId = body?.projectId;
  const tree = body?.tree;
  const name = typeof body?.name === "string" ? body.name : null;
  if (!projectId || !tree || typeof tree !== "object") {
    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "projectId and tree are required" }));
  }
  if (!PROVISIOND_URL() || !PROVISIOND_TOKEN()) {
    res.writeHead(503, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "publishing is not configured (PROVISIOND_URL/TOKEN)" }));
  }
  try {
    await requirePublishTier(owner);
    // Claim (or renew) the site name FIRST — a taken name should fail before the build spend.
    const { slug, previousSlug } = await claimSlug(owner, projectId, name);

    await ensureDeps(() => {});
    const caseName = `pub-${projectId}`.replace(/[^a-zA-Z0-9_-]/g, "_");
    const build = await buildTree(withRuntimeEnv(tree, projectId), caseName, () => {});
    if (!build.ok) {
      res.writeHead(422, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "build failed", stderr: (build.stderr || "").slice(-2000) }));
    }
    const files = await readDistAsBase64(path.join(workDirFor(caseName), "dist"));
    const out = await provisiondPost("/publish", { projectId, files, slug: slug || undefined });
    // A rename retires the old address so stale URLs stop serving; naming a legacy-published
    // project likewise retires its old UUID label (no-op when that dir never existed).
    if (slug) {
      if (previousSlug && previousSlug !== slug) {
        await provisiondPost("/unpublish", { projectId, slug: previousSlug }).catch(() => {});
      } else if (!previousSlug) {
        await provisiondPost("/unpublish", { projectId }).catch(() => {});
      }
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ url: out.url, files: out.files, bytes: out.bytes, slug: slug || out.id }));
  } catch (e) {
    const status = e.code === "upgrade_required" ? 402
      : e.code === "slug_taken" || e.code === "bad_slug" ? 409 : 500;
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: e.message, code: e.code }));
  }
}
