import { applyBrandToTree } from "../shell/server/lib/visualBrand.mjs";
import { withRuntimeEnv } from "../shell/server/lib/runtimeEnv.mjs";
import { serviceClient } from "../shell/server/lib/supabase.mjs";
import { previewProvider } from "../shell/server/preview/index.mjs";

const client = serviceClient();
const refreshPreviews = process.argv.includes("--refresh-previews");
const { data: settings, error: settingsError } = await client
  .from("project_brand_settings")
  .select("project_id,owner,config");
if (settingsError) throw new Error(`brand settings lookup: ${settingsError.message}`);

let repaired = 0;
let skipped = 0;
let refreshed = 0;
for (const setting of settings || []) {
  const { data: project, error: projectError } = await client
    .from("projects")
    .select("tree")
    .eq("id", setting.project_id)
    .eq("owner", setting.owner)
    .maybeSingle();
  if (projectError) throw new Error(`project ${setting.project_id}: ${projectError.message}`);
  if (!project?.tree) {
    skipped += 1;
    continue;
  }
  const applied = applyBrandToTree(project.tree, setting.config);
  const { error: updateError } = await client
    .from("projects")
    .update({ tree: applied.tree, updated_at: new Date().toISOString() })
    .eq("id", setting.project_id)
    .eq("owner", setting.owner);
  if (updateError) throw new Error(`project ${setting.project_id} update: ${updateError.message}`);
  if (refreshPreviews) {
    await previewProvider().start(setting.project_id, withRuntimeEnv(applied.tree, setting.project_id));
    refreshed += 1;
  }
  repaired += 1;
}

console.log(`Visual brands reapplied: ${repaired}; previews refreshed: ${refreshed}; skipped: ${skipped}`);
