// Whether an owner's projects are live, and whether what is live is current.
//
// Publishing already recorded everything needed for this; nothing surfaced it. A user who
// published had to remember they had, and had no way to tell that later edits were still sitting
// unpublished. Both facts come from data that already exists.

import { serviceClient } from "./supabase.mjs";

// persistBuildResult stamps projects.updated_at on every tree write, and publishApp stamps
// published_sites.updated_at after the site is serving — so a project edited after its last
// publish has the later timestamp. The tolerance absorbs the ordinary case where the publish
// itself follows a build by a moment; without it, every freshly published app would immediately
// claim an update was available.
const STALE_TOLERANCE_MS = 5_000;

export async function publishStates(owner, client = serviceClient()) {
  const { data: sites, error } = await client
    .from("published_sites")
    .select("project_id,slug,url,created_at,updated_at")
    .eq("owner", owner);
  // Supabase hands back a plain object, not an Error. Rethrowing it as-is loses the stack and
  // makes the caller's `error.message` handling depend on which layer failed.
  if (error) throw new Error(`published_sites read failed: ${error.message || error}`);
  if (!sites?.length) return [];

  // Owner-scoped on both sides: the site rows are already filtered by owner, and the project
  // lookup repeats the check so a mismatched project_id cannot leak another account's name.
  const { data: projects } = await client
    .from("projects")
    .select("id,product_id,name,updated_at")
    .eq("owner", owner)
    .in("id", sites.map((s) => s.project_id));
  const byId = new Map((projects || []).map((p) => [String(p.id), p]));

  return sites.map((site) => {
    const project = byId.get(String(site.project_id));
    const publishedAt = site.updated_at;
    const changedAt = project?.updated_at || null;
    return {
      projectId: String(site.project_id),
      productId: project?.product_id ? String(project.product_id) : null,
      name: project?.name || null,
      url: site.url,
      publishedAt,
      firstPublishedAt: site.created_at,
      environment: "production",
      updateAvailable: !!(changedAt && publishedAt
        && Date.parse(changedAt) > Date.parse(publishedAt) + STALE_TOLERANCE_MS),
    };
  });
}
