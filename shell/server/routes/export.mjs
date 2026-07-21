import { serviceClient } from "../lib/supabase.mjs";
import { assertNoPlatformSecrets, buildProjectZip } from "../lib/exportProject.mjs";
import { auditEvent } from "../lib/projectState.mjs";

function safeContentDisposition(filename) {
  const fallback = "buildr101-app.zip";
  const safe = String(filename || fallback).replace(/[^a-zA-Z0-9._-]/g, "-") || fallback;
  return `attachment; filename="${safe}"`;
}

export async function handleExport(req, res, body, owner) {
  const projectId = typeof body?.projectId === "string" ? body.projectId.trim() : "";
  if (!projectId) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "projectId is required" }));
    return;
  }

  const { data, error } = await serviceClient()
    .from("projects")
    .select("id,name,tree,history")
    .eq("id", projectId)
    .eq("owner", owner.id)
    .maybeSingle();

  if (error) throw error;
  if (!data) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "project not found" }));
    return;
  }

  let zip;
  let filename;
  try {
    const built = buildProjectZip(data);
    assertNoPlatformSecrets(built.files);
    zip = built.zip;
    filename = built.filename;
  } catch (e) {
    console.error(`[export] ${e?.stack || e}`);
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Project export failed. Please try again." }));
    return;
  }

  res.writeHead(200, {
    "Content-Type": "application/zip",
    "Content-Disposition": safeContentDisposition(filename),
    "Cache-Control": "no-store"
  });
  await auditEvent({ owner: owner.id, projectId, action: "project.source_zip_exported", target: filename })
    .catch((error) => console.error(`[export] audit failed: ${error.message}`));
  res.end(zip);
}
