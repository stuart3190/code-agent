import { createTemplate, deleteTemplate, listTemplates, remixTemplate } from "../lib/templates.mjs";

const json = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
};

export async function handleTemplateList(req, res, owner) {
  return json(res, 200, { templates: await listTemplates(owner) });
}

export async function handleTemplateCreate(req, res, body, owner) {
  if (!body?.projectId) return json(res, 400, { error: "projectId is required" });
  try {
    const template = await createTemplate(owner, body.projectId, body);
    return template ? json(res, 200, { template }) : json(res, 404, { error: "project not found" });
  } catch (error) {
    if (["no_app", "template_limit", "bad_template"].includes(error.code)) return json(res, 409, { error: error.message, code: error.code });
    throw error;
  }
}

export async function handleTemplateRemix(req, res, body, owner) {
  if (!body?.templateId) return json(res, 400, { error: "templateId is required" });
  const project = await remixTemplate(owner, body.templateId, body.name);
  return project ? json(res, 200, { project }) : json(res, 404, { error: "template not found" });
}

export async function handleTemplateDelete(req, res, body, owner) {
  if (!body?.templateId) return json(res, 400, { error: "templateId is required" });
  return (await deleteTemplate(owner, body.templateId)) ? json(res, 200, { ok: true }) : json(res, 404, { error: "template not found" });
}
