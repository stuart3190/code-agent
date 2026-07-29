// Custom domains — connect a user-owned domain to their published site.
//
//   GET  /api/domain-check?domain=x   UNAUTHENTICATED — Caddy's on_demand_tls "ask" gate.
//                                     200 iff the domain is registered; 404 otherwise. This is
//                                     what stops strangers pointing random domains at the VPS
//                                     and minting certs. Read-only yes/no, so no auth by design.
//   GET  /api/domains?projectId=x     (auth) list the project's domains + status
//   POST /api/domains                 (auth) { projectId, domain } — validate, claim, DNS-check,
//                                     attach the provisiond symlink. Re-POST = re-check DNS.
//   POST /api/domains/remove          (auth) { projectId, domain } — release + detach.
//
// Ownership chain: the project must have a published_sites claim (it's published under a slug);
// the domain row records owner/project/slug; all writes go through the service role.

import { resolve4 } from "node:dns/promises";
import { serviceClient } from "../lib/supabase.mjs";
import { requireFeature } from "../lib/features.mjs";

// Custom domains are a paid feature: Pro and Studio tiers only. Enforced at CONNECT time
// (already-connected domains keep serving if a subscription lapses — hostages make bad customers).
const PROVISIOND_URL = () => process.env.PROVISIOND_URL;
const PROVISIOND_TOKEN = () => process.env.PROVISIOND_TOKEN;
const PUBLISH_IP = process.env.PUBLISH_IP || "51.195.136.189";

const DOMAIN_RE = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

const json = (res, code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };

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

function normalizeDomain(input) {
  const d = String(input || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!DOMAIN_RE.test(d) || d.endsWith(".buildr101.com") || d === "buildr101.com") return null;
  return d;
}

async function dnsPointsHere(domain) {
  try {
    const ips = await resolve4(domain);
    return ips.includes(PUBLISH_IP);
  } catch { return false; }
}

// Caddy's ask gate. MUST be fast and unauthenticated.
export async function handleDomainCheck(req, res, url) {
  const domain = normalizeDomain(url.searchParams.get("domain"));
  if (!domain) return json(res, 404, { ok: false });
  const { data } = await serviceClient().from("custom_domains").select("domain").eq("domain", domain).maybeSingle();
  return json(res, data ? 200 : 404, { ok: !!data });
}

export async function handleDomainList(req, res, url, owner) {
  const projectId = url.searchParams.get("projectId");
  if (!projectId) return json(res, 400, { error: "projectId required" });
  const { data, error } = await serviceClient()
    .from("custom_domains").select("domain, verified_at, created_at")
    .eq("project_id", projectId).eq("owner", owner.id).order("created_at");
  if (error) {
    console.error(`[domains:list] ${error.message}`);
    return json(res, 500, { error: "Domains are temporarily unavailable." });
  }
  return json(res, 200, { domains: data || [], ip: PUBLISH_IP });
}

export async function handleDomainConnect(req, res, body, owner) {
  const projectId = body?.projectId;
  const domain = normalizeDomain(body?.domain);
  if (!projectId) return json(res, 400, { error: "projectId required" });
  if (!domain) return json(res, 400, { error: "Enter a valid domain, e.g. yourbusiness.com" });
  try {
    await requireFeature(owner, "custom_domains");
    const svc = serviceClient();
    const { data: site } = await svc.from("published_sites")
      .select("slug, owner").eq("project_id", projectId).maybeSingle();
    if (!site || site.owner !== owner.id) {
      return json(res, 409, { error: "Publish the app (with a site name) before connecting a domain." });
    }
    const { data: holder } = await svc.from("custom_domains").select("owner, project_id").eq("domain", domain).maybeSingle();
    if (holder && !(holder.owner === owner.id && holder.project_id === projectId)) {
      return json(res, 409, { error: "That domain is already connected to another app." });
    }
    const live = await dnsPointsHere(domain);
    const { error: upErr } = await svc.from("custom_domains").upsert({
      domain, owner: owner.id, project_id: projectId, slug: site.slug,
      verified_at: live ? new Date().toISOString() : null,
    }, { onConflict: "domain" });
    if (upErr) throw new Error(upErr.message);
    await provisiondPost("/domain-attach", { domain, label: site.slug });
    return json(res, 200, {
      domain, status: live ? "live" : "pending-dns", ip: PUBLISH_IP,
      hint: live ? `https://${domain} is live (first visit may take ~30s while the certificate is issued).`
                 : `Point an A record for ${domain} to ${PUBLISH_IP}, then check again.`,
    });
  } catch (e) {
    if (e.code === "upgrade_required") return json(res, 402, { error: e.message, code: e.code });
    console.error(`[domains:connect] ${e?.stack || e}`);
    return json(res, 500, { error: "The domain could not be connected. Please try again." });
  }
}

export async function handleDomainRemove(req, res, body, owner) {
  const projectId = body?.projectId;
  const domain = normalizeDomain(body?.domain);
  if (!projectId || !domain) return json(res, 400, { error: "projectId and domain required" });
  try {
    const svc = serviceClient();
    const { data: row } = await svc.from("custom_domains").select("owner, project_id").eq("domain", domain).maybeSingle();
    if (!row || row.owner !== owner.id || row.project_id !== projectId) {
      return json(res, 404, { error: "Domain not found on this app." });
    }
    await svc.from("custom_domains").delete().eq("domain", domain);
    await provisiondPost("/domain-detach", { domain }).catch(() => {});
    return json(res, 200, { removed: domain });
  } catch (e) {
    console.error(`[domains:remove] ${e?.stack || e}`);
    return json(res, 500, { error: "The domain could not be removed. Please try again." });
  }
}
