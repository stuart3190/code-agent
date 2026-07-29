import { applyProjectBrand, brandOverview, deleteBrandKit } from "../lib/visualBrand.mjs";

const json = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
};

export async function handleBrandOverview(req, res, url, owner) {
  const projectId = url.searchParams.get("projectId");
  if (!projectId) return json(res, 400, { error: "projectId is required" });
  const result = await brandOverview(owner, projectId);
  return result ? json(res, 200, result) : json(res, 404, { error: "project not found" });
}

export async function handleBrandApply(req, res, body, owner) {
  if (!body?.projectId) return json(res, 400, { error: "projectId is required" });
  try {
    const result = await applyProjectBrand(owner, body.projectId, body.config, { kitName: body.kitName, brandKitId: body.brandKitId });
    return result ? json(res, 200, result) : json(res, 404, { error: "project not found" });
  } catch (error) {
    if (error.code === "brand_not_found") return json(res, 404, { error: error.message, code: error.code });
    throw error;
  }
}

export async function handleBrandDelete(req, res, body, owner) {
  if (!body?.kitId) return json(res, 400, { error: "kitId is required" });
  const deleted = await deleteBrandKit(owner, body.kitId);
  return deleted ? json(res, 200, { ok: true }) : json(res, 404, { error: "brand kit not found" });
}
