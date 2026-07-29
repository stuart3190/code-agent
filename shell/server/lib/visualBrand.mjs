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

function hexToRgb(value) {
  const hex = String(value).replace("#", "");
  return [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
}

function rgbToHsl(value) {
  const [red, green, blue] = hexToRgb(value).map((channel) => channel / 255);
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const lightness = (max + min) / 2;
  if (max === min) return `0 0% ${trimNumber(lightness * 100)}%`;
  const delta = max - min;
  const saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  let hue = max === red ? (green - blue) / delta + (green < blue ? 6 : 0)
    : max === green ? (blue - red) / delta + 2 : (red - green) / delta + 4;
  hue *= 60;
  return `${trimNumber(hue)} ${trimNumber(saturation * 100)}% ${trimNumber(lightness * 100)}%`;
}

function rgbTriplet(value) {
  return hexToRgb(value).join(" ");
}

function rgbToOklch(value) {
  const [red, green, blue] = hexToRgb(value).map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  const l = Math.cbrt(0.4122214708 * red + 0.5363325363 * green + 0.0514459929 * blue);
  const m = Math.cbrt(0.2119034982 * red + 0.6806995451 * green + 0.1073969566 * blue);
  const s = Math.cbrt(0.0883024619 * red + 0.2817188376 * green + 0.6299787005 * blue);
  const lightness = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const b = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const chroma = Math.sqrt(a * a + b * b);
  const hue = (Math.atan2(b, a) * 180 / Math.PI + 360) % 360;
  return `${trimNumber(lightness * 100)}% ${trimNumber(chroma, 4)} ${trimNumber(hue)}`;
}

function trimNumber(value, precision = 1) {
  return Number(value.toFixed(precision)).toString();
}

function relativeLuminance(value) {
  const channels = hexToRgb(value).map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastColor(value) {
  return relativeLuminance(value) > 0.42 ? "#0b1020" : "#ffffff";
}

function tokenMode(tree, cssPath) {
  const source = `${tree[cssPath] || ""}\n${tree["tailwind.config.js"] || ""}`;
  if (/hsl\(\s*var\(\s*--(?:primary|background|foreground)/i.test(source)) return "hsl";
  if (/rgb(?:a)?\(\s*var\(\s*--(?:primary|background|foreground)/i.test(source)) return "rgb";
  if (/oklch\(\s*var\(\s*--(?:primary|background|foreground)/i.test(source)) return "oklch";
  return "hex";
}

function tokenValue(value, mode) {
  if (mode === "hsl") return rgbToHsl(value);
  if (mode === "rgb") return rgbTriplet(value);
  if (mode === "oklch") return rgbToOklch(value);
  return value;
}

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
  const mode = tokenMode(tree, cssPath);
  const start = previous.indexOf(START);
  const end = previous.indexOf(END);
  const base = start >= 0 && end > start ? `${previous.slice(0, start).trimEnd()}\n` : `${previous.trimEnd()}\n`;
  const semantic = Object.fromEntries(Object.entries({
    primary: config.primary,
    primaryForeground: contrastColor(config.primary),
    accent: config.accent,
    accentForeground: contrastColor(config.accent),
    background: config.background,
    surface: config.surface,
    text: config.text,
  }).map(([key, value]) => [key, tokenValue(value, mode)]));
  const block = `${START}
:root, .dark, [class*="theme-"] {
  --buildr-primary: ${config.primary};
  --buildr-accent: ${config.accent};
  --buildr-background: ${config.background};
  --buildr-surface: ${config.surface};
  --buildr-text: ${config.text};
  --buildr-radius: ${config.radius}px;
  --primary: ${semantic.primary};
  --primary-foreground: ${semantic.primaryForeground};
  --accent: ${semantic.accent};
  --accent-foreground: ${semantic.accentForeground};
  --background: ${semantic.background};
  --foreground: ${semantic.text};
  --card: ${semantic.surface};
  --card-foreground: ${semantic.text};
  --popover: ${semantic.surface};
  --popover-foreground: ${semantic.text};
  --secondary: ${semantic.surface};
  --secondary-foreground: ${semantic.text};
  --muted: ${semantic.surface};
  --muted-foreground: ${semantic.text};
  --border: ${semantic.surface};
  --input: ${semantic.surface};
  --ring: ${semantic.primary};
  --radius: ${config.radius}px;
  --font-sans: ${FONTS[config.font]};
  --font-display: ${FONTS[config.font]};
}
html, body, #root { min-height: 100%; }
body { font-family: ${FONTS[config.font]}; background-color: var(--buildr-background); color: var(--buildr-text); }
button, input, select, textarea, h1, h2, h3, h4, h5, h6 { font-family: ${FONTS[config.font]}; }
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
