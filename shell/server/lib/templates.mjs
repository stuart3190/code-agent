import { requireFeature } from "./features.mjs";
import { auditEvent } from "./projectState.mjs";
import { ownedProject, serviceClient } from "./supabase.mjs";

export function cleanTemplateText(value, max) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, max);
}

export async function listTemplates(owner, client = serviceClient()) {
  await requireFeature(owner, "templates");
  const { data, error } = await client.from("project_templates")
    .select("id,owner,name,description,category,public,times_remixed,created_at,updated_at")
    .or(`public.eq.true,owner.eq.${owner.id}`).order("times_remixed", { ascending: false }).order("updated_at", { ascending: false }).limit(100);
  if (error) throw new Error(`templates: ${error.message}`);
  return data || [];
}

export async function createTemplate(owner, projectId, input = {}, client = serviceClient()) {
  await requireFeature(owner, "templates");
  const project = await ownedProject(owner.id, projectId, "id,name,tree", client);
  if (!project) return null;
  if (!project.tree || typeof project.tree !== "object") throw Object.assign(new Error("Build the app before saving it as a template."), { code: "no_app" });
  const { count } = await client.from("project_templates").select("id", { count: "exact", head: true }).eq("owner", owner.id);
  if ((count || 0) >= 20) throw Object.assign(new Error("You can keep up to 20 personal templates."), { code: "template_limit" });
  const name = cleanTemplateText(input.name || project.name || "App template", 100);
  const description = cleanTemplateText(input.description, 500);
  const category = cleanTemplateText(input.category || "other", 40).toLowerCase().replace(/[^a-z0-9-]+/g, "-") || "other";
  if (!name) throw Object.assign(new Error("Template name is required."), { code: "bad_template" });
  if (JSON.stringify(project.tree).length > 2_000_000) throw Object.assign(new Error("This project is too large to save as a template."), { code: "bad_template" });
  const { data, error } = await client.from("project_templates").insert({
    owner: owner.id, name, description, category, source_tree: project.tree, public: false,
  }).select("id,owner,name,description,category,public,times_remixed,created_at,updated_at").single();
  if (error) throw new Error(`template create: ${error.message}`);
  await auditEvent({ owner: owner.id, projectId, action: "template.created", target: data.id }, client).catch(() => {});
  return data;
}

export async function remixTemplate(owner, templateId, name, client = serviceClient()) {
  await requireFeature(owner, "templates");
  const { data: template, error } = await client.from("project_templates")
    .select("id,owner,name,source_tree,times_remixed,public").eq("id", templateId).maybeSingle();
  if (error) throw new Error(`template lookup: ${error.message}`);
  if (!template || (!template.public && template.owner !== owner.id)) return null;
  const projectName = cleanTemplateText(name || `${template.name} remix`, 100) || "Template remix";
  const now = new Date().toISOString();
  const { data: project, error: createError } = await client.from("projects").insert({
    owner: owner.id, name: projectName, tree: template.source_tree, history: [], preview_ref: null, updated_at: now,
  }).select("id,name,tree,history,preview_ref,knowledge,published_url,design_profile,created_at,updated_at").single();
  if (createError) throw new Error(`template remix: ${createError.message}`);
  await client.from("project_templates").update({ times_remixed: template.times_remixed + 1, updated_at: now }).eq("id", template.id);
  await auditEvent({ owner: owner.id, projectId: project.id, action: "template.remixed", target: template.id }, client).catch(() => {});
  return {
    id: project.id, name: project.name, tree: project.tree, prompts: project.history || [], previewRef: project.preview_ref,
    knowledge: project.knowledge || "", publishedUrl: project.published_url || null, designProfile: project.design_profile || null,
    createdAt: project.created_at, updatedAt: project.updated_at,
  };
}

export async function deleteTemplate(owner, templateId, client = serviceClient()) {
  await requireFeature(owner, "templates");
  const { data, error } = await client.from("project_templates").delete().eq("id", templateId).eq("owner", owner.id).select("id").maybeSingle();
  if (error) throw new Error(`template delete: ${error.message}`);
  return !!data;
}
