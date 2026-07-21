// POST /api/projects/delete { projectId } — delete a project WITH full cleanup. The client-side
// row delete alone would leak infrastructure: a live published site, its claimed name, connected
// custom domains, the app's end-user data and per-app accounts. This route (service role, owner-
// verified) tears all of it down, then removes the project row.

import { serviceClient } from "../lib/supabase.mjs";
import { previewProvider } from "../preview/index.mjs";

const PROVISIOND_URL = () => process.env.PROVISIOND_URL;
const PROVISIOND_TOKEN = () => process.env.PROVISIOND_TOKEN;

async function provisiondPost(route, body) {
  if (!PROVISIOND_URL() || !PROVISIOND_TOKEN()) return null;
  const r = await fetch(`${PROVISIOND_URL()}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${PROVISIOND_TOKEN()}` },
    body: JSON.stringify(body),
  }).catch(() => null);
  return r?.ok ? r.json() : null;
}

// The full teardown for ONE project (domains, published site + name claim, preview container,
// per-app end users + data, then the row). Callers verify ownership FIRST — the service role
// bypasses RLS. Shared by project delete and account delete (which loops every project).
export async function deleteProjectCascade(svc, projectId) {
  const cleaned = { domains: 0, site: false, appUsers: 0, entities: false };

  // 1. Custom domains: detach the serving symlinks, drop the rows.
  const { data: domains } = await svc.from("custom_domains").select("domain").eq("project_id", projectId);
  for (const d of domains || []) {
    await provisiondPost("/domain-detach", { domain: d.domain });
    cleaned.domains++;
  }
  if (cleaned.domains) await svc.from("custom_domains").delete().eq("project_id", projectId);

  // 2. Published site: take it offline (named slug AND any legacy UUID label), release the name.
  const { data: site } = await svc.from("published_sites").select("slug").eq("project_id", projectId).maybeSingle();
  if (site?.slug) await provisiondPost("/unpublish", { projectId, slug: site.slug });
  await provisiondPost("/unpublish", { projectId }); // legacy label — no-op when absent
  if (site) { await svc.from("published_sites").delete().eq("project_id", projectId); cleaned.site = true; }

  // 3. Preview container: full teardown via the seam (reaper would only stop it).
  await previewProvider().stop(projectId).catch(() => {});

  // 4. Per-app end-user accounts (synthetic auth users) + the app's data rows.
  const { data: appUsers } = await svc.from("app_users").select("auth_user_id").eq("app_id", projectId);
  for (const u of appUsers || []) {
    await svc.auth.admin.deleteUser(u.auth_user_id).catch(() => {});
    cleaned.appUsers++;
  }
  if (cleaned.appUsers) await svc.from("app_users").delete().eq("app_id", projectId);
  await svc.from("entities").delete().eq("app_id", projectId);
  cleaned.entities = true;

  // 5. The project row itself.
  const { error: dErr } = await svc.from("projects").delete().eq("id", projectId);
  if (dErr) throw new Error(dErr.message);

  return cleaned;
}

export async function handleProjectDelete(req, res, body, owner) {
  const projectId = body?.projectId;
  if (!projectId) {
    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "projectId is required" }));
  }
  try {
    const svc = serviceClient();

    // Ownership check first — the service role bypasses RLS, so enforce it explicitly.
    const { data: proj, error: pErr } = await svc
      .from("projects").select("id, owner").eq("id", projectId).maybeSingle();
    if (pErr) throw new Error(pErr.message);
    if (!proj || proj.owner !== owner.id) {
      res.writeHead(404, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Project not found." }));
    }

    const cleaned = await deleteProjectCascade(svc, projectId);

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ deleted: projectId, cleaned }));
  } catch (e) {
    console.error(`[project-delete] ${e?.stack || e}`);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "The project could not be deleted. Please try again." }));
  }
}
