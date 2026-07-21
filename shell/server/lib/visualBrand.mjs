import { requireFeature } from "./features.mjs";
import { auditEvent } from "./projectState.mjs";
import { ownedProject, serviceClient } from "./supabase.mjs";

const START = "/* buildr101:visual-brand:start */";
const END = "/* buildr101:visual-brand:end */";
const FONTS = Object.freeze({
  modern: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  editorial: 'Georgia, Cambria, "Times New Roman", serif',
  friendly: 'Nunito, ui-rounded, "Arial Rounded MT Bold", system-ui, sans-serif',
  technical: '"IBM Plex Mono", "SFMono-Regular", Consolas, monospace',
});

function color(value, fallback) {
  const candidate = String(value || "").trim();
  return /^#[0-9a-f]{6}$/i.test(candidate) ? candidate.toLowerCase() : fallback;
}

export function cleanBrandConfig(input = {}) {
  const font = Object.hasOwn(FONTS, input.font) ? input.font : "modern";
  const radius = Math.max(0, Math.min(32, Math.round(Number(input.radius ?? 12) || 0)));
  return {
    primary: color(input.primary, "#7c3aed"),
    accent: color(input.accent, "#f59e0b"),
    background: color(input.background, "#0f172a"),
    surface: color(input.surface, "#1e293b"),
    text: color(input.text, "#f8fafc"),
    font,
    radius,
  };
}

export function applyBrandToTree(tree, rawConfig) {
  if (!tree || typeof tree !== "object" || Array.isArray(tree)) throw new Error("Project tree is missing.");
  const config = cleanBrandConfig(rawConfig);
  const cssPath = Object.hasOwn(tree, "src/index.css") ? "src/index.css"
    : Object.hasOwn(tree, "src/App.css") ? "src/App.css" : "src/index.css";
  const previous = String(tree[cssPath] || "");
  const start = previous.indexOf(START);
  const end = previous.indexOf(END);
  const base = start >= 0 && end > start ? `${previous.slice(0, start).trimEnd()}\n` : `${previous.trimEnd()}\n`;
  const block = `${START}
:root {
  --buildr-primary: ${config.primary};
  --buildr-accent: ${config.accent};
  --buildr-background: ${config.background};
  --buildr-surface: ${config.surface};
  --buildr-text: ${config.text};
  --buildr-radius: ${config.radius}px;
  --primary: ${config.primary};
  --accent: ${config.accent};
  --background: ${config.background};
  --foreground: ${config.text};
  --card: ${config.surface};
  --radius: ${config.radius}px;
}
html, body, #root { min-height: 100%; }
body { font-family: ${FONTS[config.font]}; background-color: var(--buildr-background); color: var(--buildr-text); }
button, input, select, textarea, [class*="rounded"] { border-radius: var(--buildr-radius); }
${END}
`;
  return { tree: { ...tree, [cssPath]: `${base}${block}` }, config, cssPath };
}

export async function brandOverview(owner, projectId, client = serviceClient()) {
  await requireFeature(owner, "visual_editor");
  if (!(await ownedProject(owner.id, projectId, "id", client))) return null;
  const [{ data: current, error: currentError }, { data: kits, error: kitsError }] = await Promise.all([
    client.from("project_brand_settings").select("brand_kit_id,config,updated_at").eq("project_id", projectId).eq("owner", owner.id).maybeSingle(),
    client.from("brand_kits").select("id,name,config,created_at,updated_at").eq("owner", owner.id).order("updated_at", { ascending: false }).limit(50),
  ]);
  if (currentError) throw new Error(`brand settings: ${currentError.message}`);
  if (kitsError) throw new Error(`brand kits: ${kitsError.message}`);
  return { current: current || { brand_kit_id: null, config: cleanBrandConfig() }, kits: kits || [] };
}

export async function applyProjectBrand(owner, projectId, rawConfig, { kitName = "", brandKitId = null } = {}, client = serviceClient()) {
  await requireFeature(owner, "visual_editor");
  const project = await ownedProject(owner.id, projectId, "id,tree", client);
  if (!project) return null;
  const applied = applyBrandToTree(project.tree, rawConfig);
  let kitId = brandKitId;
  if (brandKitId) {
    const { data: kit } = await client.from("brand_kits").select("id").eq("id", brandKitId).eq("owner", owner.id).maybeSingle();
    if (!kit) throw Object.assign(new Error("Brand kit not found."), { code: "brand_not_found" });
  } else if (String(kitName).trim()) {
    const name = String(kitName).trim().slice(0, 80);
    const { data: kit, error } = await client.from("brand_kits").insert({ owner: owner.id, name, config: applied.config })
      .select("id").single();
    if (error) throw new Error(`brand kit create: ${error.message}`);
    kitId = kit.id;
  }
  const { error: projectError } = await client.from("projects").update({ tree: applied.tree, updated_at: new Date().toISOString() })
    .eq("id", projectId).eq("owner", owner.id);
  if (projectError) throw new Error(`brand project update: ${projectError.message}`);
  const { error: settingsError } = await client.from("project_brand_settings").upsert({
    project_id: projectId, owner: owner.id, brand_kit_id: kitId, config: applied.config, updated_at: new Date().toISOString(),
  }, { onConflict: "project_id" });
  if (settingsError) throw new Error(`brand settings update: ${settingsError.message}`);
  await auditEvent({ owner: owner.id, projectId, action: "project.brand.applied", target: kitId, metadata: { cssPath: applied.cssPath } }, client).catch(() => {});
  return { tree: applied.tree, config: applied.config, brandKitId: kitId };
}

export async function deleteBrandKit(owner, kitId, client = serviceClient()) {
  await requireFeature(owner, "visual_editor");
  const { data, error } = await client.from("brand_kits").delete().eq("id", kitId).eq("owner", owner.id).select("id").maybeSingle();
  if (error) throw new Error(`brand kit delete: ${error.message}`);
  return !!data;
}
