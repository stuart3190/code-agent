// The publish lifecycle: draft → published → update available → unpublished → published again.
//
// Two things make this less obvious than it looks, both found by inspecting production data:
//
//   1. A PRODUCT can own several PROJECT rows — each rebuild can create a new one — while
//      published_sites points at whichever project was live at publish time. Comparing only that
//      project's updated_at means a rebuild under the same product would never register as an
//      update, because the published project row never changes again. The comparison is therefore
//      against the NEWEST project of the same product.
//
//   2. Unpublishing must not delete the row. Publish history, the claimed slug and the original
//      URL all live there, and republishing should return to the same address.

import { serviceClient } from "./supabase.mjs";

// A publish follows a build by a moment, so projects.updated_at can land just before
// published_sites.updated_at is stamped. Without tolerance every publish would immediately report
// that an update was waiting, and the badge would mean nothing.
const STALE_TOLERANCE_MS = 5_000;

export const PUBLISH_STATUS = Object.freeze({
  draft: "draft",
  published: "published",
  updateAvailable: "update_available",
  unpublished: "unpublished",
});

export async function publishStates(owner, client = serviceClient()) {
  const { data: sites, error } = await client
    .from("published_sites")
    .select("project_id,slug,url,created_at,updated_at,unpublished_at")
    .eq("owner", owner);
  // Supabase hands back a plain object, not an Error. Rethrowing it as-is loses the stack and
  // makes the caller's `error.message` handling depend on which layer failed.
  if (error) throw new Error(`published_sites read failed: ${error.message || error}`);
  if (!sites?.length) return [];

  // Every project for this owner, not only the published ones: resolving "has this product
  // changed since it was published?" needs the product's whole family of project rows.
  const { data: projects } = await client
    .from("projects")
    .select("id,product_id,name,updated_at")
    .eq("owner", owner);
  const all = projects || [];

  // A verified custom domain is what the owner actually tells people, so once one is active it
  // becomes the address shown everywhere. Only `active` counts — a domain still proving itself
  // would send people to a hostname that does not resolve yet. The Thrallo URL is always kept
  // alongside it, never replaced, so it stays copyable from Project Settings.
  // Every domain, not only the active ones. `customDomain` below still means "active", because
  // that is the address people are sent to — but a domain part-way through verification is real
  // and must be visible. Reading only active rows is why a domain stuck in pending_dns rendered as
  // "Add a domain" on the Overview tile: the surface offered to start something already underway.
  const { data: allDomains } = await client
    .from("custom_domains")
    .select("domain,project_id,created_at,status,ssl_status,failure_reason")
    .eq("owner", owner)
    .order("created_at", { ascending: true });
  const domainsByProject = new Map();
  for (const row of allDomains || []) {
    const key = String(row.project_id);
    if (!domainsByProject.has(key)) domainsByProject.set(key, []);
    domainsByProject.get(key).push({
      domain: row.domain,
      status: row.status,
      sslStatus: row.ssl_status,
      failureReason: row.failure_reason,
    });
  }
  const domainRows = (allDomains || []).filter((r) => r.status === "active");
  // Sorted here rather than relying on the query's order clause: which domain is "primary" is a
  // product decision, and it should not quietly change if that clause is ever edited away.
  const customByProject = new Map();
  for (const row of [...(domainRows || [])].sort(
    (a, b) => Date.parse(a.created_at || 0) - Date.parse(b.created_at || 0),
  )) {
    // Oldest first, so the first domain connected stays the primary one rather than the address a
    // project is known by changing every time another domain is added.
    if (!customByProject.has(String(row.project_id))) customByProject.set(String(row.project_id), row.domain);
  }
  const byId = new Map(all.map((p) => [String(p.id), p]));

  const newestByProduct = new Map();
  for (const project of all) {
    if (!project.product_id) continue;
    const key = String(project.product_id);
    const current = newestByProduct.get(key);
    if (!current || Date.parse(project.updated_at) > Date.parse(current.updated_at)) {
      newestByProduct.set(key, project);
    }
  }

  return sites.map((site) => {
    const project = byId.get(String(site.project_id));
    const productId = project?.product_id ? String(project.product_id) : null;
    // The product's latest work, falling back to the published project when the product link is
    // missing (older conversations predate product ids).
    const latest = (productId && newestByProduct.get(productId)) || project || null;

    const publishedAt = site.updated_at;
    const live = !site.unpublished_at;
    const stale = !!(live && latest?.updated_at && publishedAt
      && Date.parse(latest.updated_at) > Date.parse(publishedAt) + STALE_TOLERANCE_MS);

    const customDomain = customByProject.get(String(site.project_id)) || null;
    const domains = domainsByProject.get(String(site.project_id)) || [];
    return {
      projectId: String(site.project_id),
      customDomain,
      // The full picture, so every surface describes the same domain the same way.
      domains,
      // What to show and link to. The Thrallo address remains in `url` regardless.
      primaryUrl: customDomain && live ? `https://${customDomain}` : site.url,
      // The project to act on now. Publishing an update must target the CURRENT project of the
      // product, not the one that happened to be live months ago.
      currentProjectId: latest ? String(latest.id) : String(site.project_id),
      productId,
      name: latest?.name || project?.name || null,
      url: site.url,
      slug: site.slug,
      publishedAt,
      firstPublishedAt: site.created_at,
      unpublishedAt: site.unpublished_at || null,
      environment: "production",
      live,
      updateAvailable: stale,
      status: !live ? PUBLISH_STATUS.unpublished
        : stale ? PUBLISH_STATUS.updateAvailable
          : PUBLISH_STATUS.published,
    };
  });
}

// The status of one project as the dashboard should label it. A project with no publish record at
// all has never been live, which is a draft.
export function statusForProduct(states, productId) {
  const site = productId ? states.find((s) => s.productId === String(productId)) : null;
  return site ? site.status : PUBLISH_STATUS.draft;
}
